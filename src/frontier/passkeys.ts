import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../memory/paths.js";

/**
 * Face ID for the phone app: WebAuthn passkeys, verified on this Mac.
 *
 * The phone keeps the private key (in its Secure Enclave / iCloud Keychain,
 * unlocked by Face ID); Echo keeps only the public key and checks every
 * signature itself, so neither the relay nor anyone between can approve
 * anything. Used to sign in, and to confirm the one action that needs more
 * than a session — powering Echo off.
 *
 * Only what this needs: ES256 and RS256 keys, "none" attestation (we trust the
 * device the user registers while already signed in with their password, not
 * a vendor certificate), and a user-verification check on every use — a tap
 * alone is not Face ID.
 */

export type PasskeyPurpose = "register" | "login" | "confirm";

interface StoredPasskey {
  id: string; // base64url credential id
  jwk: Record<string, string>;
  alg: number;
  signCount: number;
  createdAt: number;
  name: string;
}

const CHALLENGE_MS = 5 * 60_000;
const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: unknown) => Buffer.from(String(s ?? ""), "base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A minimal CBOR reader: what attestation objects and COSE keys contain. */
export function decodeCbor(buf: Buffer, start = 0): { value: any; end: number } {
  let p = start;
  const readArg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[p++];
    if (info === 25) { const v = buf.readUInt16BE(p); p += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(p); p += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(p)); p += 8; return v; }
    throw new Error("Unsupported CBOR length.");
  };
  const item = (): any => {
    if (p >= buf.length) throw new Error("Truncated CBOR.");
    const byte = buf[p++];
    const major = byte >> 5, info = byte & 31;
    switch (major) {
      case 0: return readArg(info);
      case 1: return -1 - readArg(info);
      case 2: { const n = readArg(info); const v = buf.subarray(p, p + n); p += n; if (v.length !== n) throw new Error("Truncated CBOR."); return Buffer.from(v); }
      case 3: { const n = readArg(info); const v = buf.toString("utf8", p, p + n); p += n; return v; }
      case 4: { const n = readArg(info); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = readArg(info); const m = new Map<any, any>(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; break;
    }
    throw new Error("Unsupported CBOR item.");
  };
  const value = item();
  return { value, end: p };
}

/** A COSE public key (ES256 or RS256) as a JWK. */
export function coseToJwk(cose: Map<number, any>): { jwk: Record<string, string>; alg: number } {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (kty === 3 && alg === -257) {
    return { alg, jwk: { kty: "RSA", n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) } };
  }
  throw new Error("This passkey uses a key type Echo does not accept.");
}

interface AuthData { rpIdHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; cose?: Map<number, any> }

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error("Authenticator data is too short.");
  const out: AuthData = { rpIdHash: data.subarray(0, 32), flags: data[32], signCount: data.readUInt32BE(33) };
  if (out.flags & 0x40) {
    const idLen = data.readUInt16BE(53);
    out.credentialId = data.subarray(55, 55 + idLen);
    out.cose = decodeCbor(data, 55 + idLen).value;
  }
  return out;
}

export class PasskeyStore {
  private keys: StoredPasskey[] = [];
  private challenges = new Map<string, { purpose: PasskeyPurpose; expires: number }>();

  constructor(private readonly file: string | null = join(dataRoot(), "remote-passkeys.json")) {
    if (file && existsSync(file)) {
      try { this.keys = JSON.parse(readFileSync(file, "utf8")).keys ?? []; } catch { this.keys = []; }
    }
  }

  get count(): number { return this.keys.length; }

  /** Options for navigator.credentials.create() / .get(), challenge included. */
  options(purpose: PasskeyPurpose, rpId: string, now = Date.now()): Record<string, unknown> {
    for (const [c, v] of this.challenges) if (v.expires < now) this.challenges.delete(c);
    const challenge = b64url(randomBytes(32));
    this.challenges.set(challenge, { purpose, expires: now + CHALLENGE_MS });
    if (purpose === "register") {
      return {
        challenge, rp: { id: rpId, name: "Echo" },
        user: { id: b64url(sha256("echo-owner")), name: "Echo", displayName: "Echo on your Mac" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
        excludeCredentials: this.keys.map((k) => ({ type: "public-key", id: k.id })),
        attestation: "none", timeout: 60_000,
      };
    }
    return { challenge, rpId, userVerification: "required", allowCredentials: this.keys.map((k) => ({ type: "public-key", id: k.id })), timeout: 60_000 };
  }

  /** Check clientDataJSON and use up its challenge. Throws when anything is off. */
  private clientData(raw: Buffer, type: string, origin: string, purpose: PasskeyPurpose, now: number): void {
    const data = JSON.parse(raw.toString("utf8"));
    if (data.type !== type) throw new Error("Wrong passkey ceremony.");
    if (data.origin !== origin) throw new Error("This passkey request came from somewhere else.");
    const pending = this.challenges.get(data.challenge);
    this.challenges.delete(data.challenge); // single use, success or not
    if (!pending || pending.expires < now || pending.purpose !== purpose) throw new Error("That Face ID request expired. Try again.");
  }

  private checkFlags(auth: AuthData, rpId: string): void {
    if (!sha256(rpId).equals(auth.rpIdHash)) throw new Error("This passkey belongs to another site.");
    if (!(auth.flags & 0x01)) throw new Error("No user presence.");
    if (!(auth.flags & 0x04)) throw new Error("Face ID (user verification) is required.");
  }

  register(cred: any, origin: string, rpId: string, name = "iPhone", now = Date.now()): void {
    this.clientData(fromB64url(cred?.response?.clientDataJSON), "webauthn.create", origin, "register", now);
    const att = decodeCbor(fromB64url(cred?.response?.attestationObject)).value as Map<string, any>;
    const auth = parseAuthData(att.get("authData"));
    this.checkFlags(auth, rpId);
    if (!auth.credentialId || !auth.cose) throw new Error("The passkey carried no key.");
    const { jwk, alg } = coseToJwk(auth.cose);
    createPublicKey({ key: jwk as any, format: "jwk" }); // refuse a key Node cannot use
    const id = b64url(auth.credentialId);
    this.keys = this.keys.filter((k) => k.id !== id);
    this.keys.push({ id, jwk, alg, signCount: auth.signCount, createdAt: now, name: String(name).slice(0, 40) });
    this.save();
  }

  /** Verify a Face ID assertion for `purpose`. Returns true, or throws with the reason. */
  verify(cred: any, origin: string, rpId: string, purpose: Exclude<PasskeyPurpose, "register">, now = Date.now()): true {
    const clientRaw = fromB64url(cred?.response?.clientDataJSON);
    this.clientData(clientRaw, "webauthn.get", origin, purpose, now);
    return this.checkAssertion(cred, clientRaw, rpId);
  }

  /**
   * Verify Face ID over something the phone signed while the Mac was away: the
   * challenge is the hash of that thing itself (a hand-off task), not one this
   * Mac handed out, so it's checked against `expectedChallenge`. Single use is
   * the caller's job (a task id only ever runs once).
   */
  verifySigned(cred: any, origin: string, rpId: string, expectedChallenge: string): true {
    const clientRaw = fromB64url(cred?.response?.clientDataJSON);
    let data: any;
    try { data = JSON.parse(clientRaw.toString("utf8")); } catch { throw new Error("That Face ID answer is unreadable."); }
    if (data.type !== "webauthn.get") throw new Error("Wrong passkey ceremony.");
    if (data.origin !== origin) throw new Error("This passkey request came from somewhere else.");
    if (data.challenge !== expectedChallenge) throw new Error("Face ID approved something else.");
    return this.checkAssertion(cred, clientRaw, rpId);
  }

  private checkAssertion(cred: any, clientRaw: Buffer, rpId: string): true {
    const key = this.keys.find((k) => k.id === String(cred?.id ?? cred?.rawId ?? ""));
    if (!key) throw new Error("This phone's Face ID isn't set up with Echo yet.");
    const authRaw = fromB64url(cred?.response?.authenticatorData);
    const auth = parseAuthData(authRaw);
    this.checkFlags(auth, rpId);
    const signed = Buffer.concat([authRaw, sha256(clientRaw)]);
    const publicKey: KeyObject = createPublicKey({ key: key.jwk as any, format: "jwk" });
    const ok = key.alg === -7
      ? verify("sha256", signed, { key: publicKey, dsaEncoding: "der" }, fromB64url(cred?.response?.signature))
      : verify("sha256", signed, publicKey, fromB64url(cred?.response?.signature));
    if (!ok) throw new Error("Face ID signature didn't match.");
    // Synced passkeys (iCloud Keychain) always report 0; a counter that goes
    // backwards on a device-bound key means a cloned authenticator.
    if (auth.signCount !== 0 || key.signCount !== 0) {
      if (auth.signCount <= key.signCount) throw new Error("This passkey looks cloned.");
      key.signCount = auth.signCount;
      this.save();
    }
    return true;
  }

  removeAll(): void {
    this.keys = [];
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileSync(this.file, JSON.stringify({ keys: this.keys }), { mode: 0o600 }); } catch { /* registration still holds for this run */ }
  }
}
