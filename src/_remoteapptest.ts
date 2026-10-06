/**
 * The phone app's own features on Echo's side: the chat, Face ID (passkeys)
 * and the actions behind them.
 *
 *   npm run remoteapptest
 *
 * Face ID is exercised end to end with a real P-256 key standing in for the
 * iPhone's Secure Enclave, so every check the phone's signature meets in
 * production is met here too — and every way to fake one is refused.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatLog, MAX_MESSAGES } from "./frontier/remote-chat.js";
import { PasskeyStore, decodeCbor } from "./frontier/passkeys.js";
import { parseRemoteAction, routeOf } from "./frontier/remote.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}`)));
const throws = (fn: () => unknown, m: string, match?: RegExp) => {
  try { fn(); ok(false, m); } catch (e: any) { ok(!match || match.test(String(e?.message)), `${m}${match && !match.test(String(e?.message)) ? ` (said: ${e?.message})` : ""}`); }
};
const dir = mkdtempSync(join(tmpdir(), "echo-remoteapp-"));

console.log("\nPhone app (Echo side)\n");

console.log("  chat");
{
  const file = join(dir, "chat.json");
  const log = new ChatLog(file);
  const a = log.add("you", "hey, how's the game going?");
  log.setTyping(true, 1000);
  ok(log.typing(1500), "typing… shows while Echo works on an answer");
  log.add("echo", "Pretty well!");
  ok(!log.typing(1500), "and clears the moment Echo answers");
  log.setTyping(true, 0);
  ok(!log.typing(200_000), "a turn that never answers stops showing typing… on its own");
  ok(log.since(0).length === 2 && log.since(a.id).length === 1, "the phone fetches only what it hasn't seen");
  const reopened = new ChatLog(file);
  ok(reopened.since(0).map((m) => m.text).join("|") === "hey, how's the game going?|Pretty well!", "the conversation survives a restart of Echo");
  ok(reopened.add("you", "x").id === 3, "and keeps numbering where it left off");
  for (let i = 0; i < MAX_MESSAGES + 20; i++) reopened.add("you", `m${i}`);
  ok(reopened.since(0).length === MAX_MESSAGES, `it keeps the last ${MAX_MESSAGES} messages`);
  ok(routeOf("/chat?t=x") === "chat" && routeOf("/chat/voice") === "chat-voice", "/chat and /chat/voice are routes");
}

console.log("  Face ID (passkeys)");
{
  const RP = "echo-remote.onrender.com", ORIGIN = `https://${RP}`;
  const store = new PasskeyStore(join(dir, "passkeys.json"));
  // The iPhone: a P-256 key pair, and the bytes its authenticator would produce.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const credId = randomBytes(16);
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
  // Tiny CBOR writer for the test's attestation object.
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const cbor = (v: any): Buffer => {
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
    if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
    if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
    throw new Error("cbor?");
  };
  const cose = cbor(new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const authData = (flags: number, count: number, attested = false) => Buffer.concat([
    sha(RP), Buffer.from([flags]), Buffer.from([0, 0, 0, count]),
    ...(attested ? [Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose] : []),
  ]);
  const client = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  const UP_UV = 0x01 | 0x04;

  const reg = store.options("register", RP) as any;
  ok(reg.authenticatorSelection.userVerification === "required" && reg.rp.id === RP, "registration asks for Face ID on this app's own site");
  const created = {
    id: credId.toString("base64url"),
    response: {
      clientDataJSON: client("webauthn.create", reg.challenge).toString("base64url"),
      attestationObject: cbor(new Map<any, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(UP_UV | 0x40, 0, true)]])).toString("base64url"),
    },
  };
  ok(decodeCbor(Buffer.from(created.response.attestationObject, "base64url")).value.get("fmt") === "none", "the CBOR reader reads an attestation object");
  store.register(created, ORIGIN, RP);
  ok(store.count === 1, "a phone's Face ID is registered");
  throws(() => store.register(created, ORIGIN, RP), "the same registration cannot be replayed", /expired/);

  const assertion = (purpose: "login" | "confirm", opts: { flags?: number; count?: number; origin?: string; sign?: boolean; challenge?: string } = {}) => {
    const challenge = opts.challenge ?? (store.options(purpose, RP) as any).challenge;
    const cd = client("webauthn.get", challenge, opts.origin);
    const ad = authData(opts.flags ?? UP_UV, opts.count ?? 0);
    const signer = createSign("sha256");
    signer.update(Buffer.concat([ad, sha(cd)]));
    const sig = opts.sign === false ? randomBytes(70) : signer.sign(privateKey);
    return { id: credId.toString("base64url"), response: { clientDataJSON: cd.toString("base64url"), authenticatorData: ad.toString("base64url"), signature: sig.toString("base64url") } };
  };
  ok(store.verify(assertion("login"), ORIGIN, RP, "login") === true, "Face ID signs in");
  ok(store.verify(assertion("confirm"), ORIGIN, RP, "confirm") === true, "and confirms an action");
  throws(() => store.verify(assertion("login", { sign: false }), ORIGIN, RP, "login"), "a forged signature is refused", /didn't match/);
  throws(() => store.verify(assertion("login", { flags: 0x01 }), ORIGIN, RP, "login"), "a tap without Face ID (no user verification) is refused", /Face ID/);
  throws(() => store.verify(assertion("login", { origin: "https://evil.example.com" }), ORIGIN, RP, "login"), "a request from another site is refused", /somewhere else/);
  throws(() => store.verify(assertion("login"), ORIGIN, RP, "confirm"), "a sign-in signature cannot approve an action", /expired/);
  const once = assertion("login");
  store.verify(once, ORIGIN, RP, "login");
  throws(() => store.verify(once, ORIGIN, RP, "login"), "the same Face ID answer cannot be used twice", /expired/);
  throws(() => store.verify(assertion("login", { challenge: "made-up" }), ORIGIN, RP, "login"), "an invented challenge is refused", /expired/);
  ok(store.verify(assertion("login", { count: 5 }), ORIGIN, RP, "login") === true, "a device-bound key's counter is tracked");
  throws(() => store.verify(assertion("login", { count: 3 }), ORIGIN, RP, "login"), "and a counter that goes backwards (a cloned key) is refused", /cloned/);
  const other = new PasskeyStore(join(dir, "passkeys.json"));
  ok(other.count === 1, "registrations survive a restart");
  throws(() => new PasskeyStore(null).verify(assertion("login"), ORIGIN, RP, "login"), "a phone that never registered cannot sign in");
}

console.log("  actions");
{
  ok(parseRemoteAction({ type: "power-off" }) === null, "power off without a Face ID answer is not even an action");
  ok(parseRemoteAction({ type: "power-off", assertion: {} })?.type === "power-off", "with one, it goes on to be verified");
  ok(parseRemoteAction({ type: "open-neural" })?.type === "open-neural", "opening the neural map on the Mac is allowed");
  ok(parseRemoteAction({ type: "shutdown" }) === null, "the control panel's own shutdown is still refused");
  ok(routeOf("/passkey/options") === "passkey-options" && routeOf("/passkey/login") === "passkey-login" && routeOf("/passkey/register") === "passkey-register", "the Face ID routes exist");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} phone app checks passed\n`);
process.exit(fail ? 1 : 0);
