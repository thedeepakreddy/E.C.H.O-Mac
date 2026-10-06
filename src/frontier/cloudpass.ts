import { createHmac, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The cloud pass: how the phone app's Phone mode is trusted while the Mac is off.
 *
 * The Mac signs it when the phone signs in (password or Face ID), with a key
 * derived from the relay secret the relay already shares, so the relay can check
 * it with nobody else involved. It names the phone's device id, lasts 30 days,
 * and is renewed whenever the Mac is reachable. Phone mode is all it opens: the
 * Mac itself is still guarded by its own sessions, and a pass can't reach it.
 *
 * "Sign out every phone" raises the generation; passes from an older one are
 * refused. The relay learns the generation from every poll, and Echo adopts a
 * higher one the relay reports (a sign-out done from the phone with the Mac off).
 *
 * The format is mirrored exactly in echo-remote (lib/secure.js); a shared test
 * vector keeps the two in step.
 */

export const PASS_TTL_S = 30 * 86400;
export const DEVICE_ID = /^[0-9a-f]{32}$/;

export function passKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("echo-relay"), Buffer.from("cloud-pass v1"), 32));
}

export function signPass(secret: string, o: { device: string; gen: number; now?: number; ttlS?: number }): string {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const body = Buffer.from(JSON.stringify({ v: 1, d: o.device, iat, exp: iat + (o.ttlS ?? PASS_TTL_S), g: o.gen })).toString("base64url");
  const sig = createHmac("sha256", passKey(secret)).update(`cp1.${body}`).digest("base64url");
  return `cp1.${body}.${sig}`;
}

/** The current pass generation, kept with the remote's other files. */
export class PassGeneration {
  private gen = 1;

  constructor(private readonly file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const n = Number(JSON.parse(readFileSync(file, "utf8"))?.gen);
      if (Number.isInteger(n) && n > 0) this.gen = n;
    } catch { /* unreadable: start at 1, which only ever cancels more */ }
  }

  get(): number { return this.gen; }

  /** Cancel every pass issued so far. */
  bump(): number {
    this.gen += 1;
    this.save();
    return this.gen;
  }

  /** The relay knows a higher one (a sign-out done from the phone): take it. */
  adopt(n: number): void {
    if (Number.isInteger(n) && n > this.gen) {
      this.gen = n;
      this.save();
    }
  }

  private save(): void {
    if (!this.file) return;
    try { writeFileSync(this.file, JSON.stringify({ gen: this.gen }), { mode: 0o600 }); } catch { /* still holds for this run */ }
  }
}
