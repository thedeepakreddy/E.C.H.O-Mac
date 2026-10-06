import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "../tools/shell.js";

/**
 * A still of the main display for the phone, when live video cannot connect.
 *
 * WebRTC is peer to peer, and on mobile data the carrier's NAT usually refuses
 * the direct path a STUN server can find — the phone then has no screen at all.
 * These stills travel over the same https link as everything else, so they
 * reach the phone on any network: a couple of frames a second, not video.
 *
 * One capture at a time, and a frame younger than FRESH_MS is shared, so a
 * phone polling quickly (or two phones) cannot make the Mac capture
 * continuously. Small and compressed — 1024 px wide, JPEG quality 45, about
 * 60–90 KB — because on mobile data every frame is paid for.
 */
const FRESH_MS = 450;
let last: { at: number; jpeg: Buffer } | null = null;
let inFlight: Promise<Buffer> | null = null;

export function screenFrame(): Promise<Buffer> {
  if (last && Date.now() - last.at < FRESH_MS) return Promise.resolve(last.jpeg);
  inFlight ??= capture().finally(() => { inFlight = null; });
  return inFlight;
}

async function capture(): Promise<Buffer> {
  const raw = join(tmpdir(), `echo-remote-${randomUUID()}.jpg`);
  const small = raw.replace(/\.jpg$/, "-s.jpg");
  try {
    const cap = await run("/usr/sbin/screencapture", ["-x", "-C", "-t", "jpg", "-D", "1", raw], 8000);
    if (cap.code !== 0) throw new Error("Screen Recording permission is needed for the phone's screen view.");
    const shrink = await run("/usr/bin/sips", ["-Z", "1024", "-s", "format", "jpeg", "-s", "formatOptions", "45", raw, "--out", small], 8000);
    const jpeg = await readFile(shrink.code === 0 ? small : raw);
    last = { at: Date.now(), jpeg };
    return jpeg;
  } finally {
    unlink(raw).catch(() => {});
    unlink(small).catch(() => {});
  }
}
