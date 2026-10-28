import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAppPath } from "../utils/appPath.js";

/**
 * Wake Echo by tapping the Fn (globe) key.
 *
 * Electron's globalShortcut cannot do this: its accelerator grammar has no Fn,
 * because Fn is resolved below the window server and never arrives as an
 * ordinary key. native/fnwatch watches for it with a listen-only CGEventTap and
 * prints "fn" for a bare tap — never for Fn held as a modifier, which is what
 * Fn mostly is (Fn+F5, Fn+left for Home). See that file for the rule.
 *
 * Optional throughout. A missing binary, a refused tap or a helper that dies
 * leaves ⌘⇧J working exactly as before; waking by keyboard is a convenience and
 * must never be the reason Echo fails to start.
 */

type Watcher = ChildProcessByStdio<null, Readable, Readable>;
let proc: Watcher | null = null;
/** Two taps in quick succession are one wake, not two. */
const DEBOUNCE_MS = 600;
let lastWake = 0;

export function isFnWakeRunning(): boolean {
  return proc !== null;
}

export function startFnWake(onWake: () => void): void {
  if (proc) return;
  const bin = join(getAppPath(), "native", "fnwatch");
  if (!existsSync(bin)) {
    console.log("[jarvis] Fn wake unavailable — native/fnwatch is not built (run npm run build on macOS)");
    return;
  }

  let child: Watcher;
  try {
    child = spawn(bin, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    console.error("[jarvis] Fn wake could not start:", err?.message ?? err);
    return;
  }
  proc = child;

  // spawn reports ENOENT asynchronously, so an unrunnable helper arrives here
  // rather than as a throw above. Losing it is not fatal.
  child.on("error", (err: any) => {
    console.error("[jarvis] Fn wake unavailable:", err?.message ?? err);
    if (proc === child) proc = null;
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim() !== "fn") return;
    const now = Date.now();
    if (now - lastWake < DEBOUNCE_MS) return;
    lastWake = now;
    try {
      onWake();
    } catch (err) {
      console.error("[jarvis] Fn wake handler failed:", err);
    }
  });

  // The helper explains a refused tap on stderr; that reason is the difference
  // between "not built" and "Accessibility permission missing", so keep it.
  createInterface({ input: child.stderr }).on("line", (line) => console.log("[jarvis] " + line));

  child.on("exit", (code) => {
    if (proc === child) proc = null;
    if (code) console.error(`[jarvis] Fn wake helper exited (${code}) — ⌘⇧J still works`);
  });
}

export function stopFnWake(): void {
  proc?.kill();
  proc = null;
}
