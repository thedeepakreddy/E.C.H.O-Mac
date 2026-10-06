import { cpus, loadavg, totalmem, uptime } from "node:os";
import { run } from "../tools/shell.js";

/**
 * The Mac's own readings for the phone's System and Core pages.
 *
 * Polled every couple of seconds by a phone that may sit open for hours, so
 * anything that spawns a process is cached: the battery for 20 s (it moves a
 * percent every few minutes), the chip and OS version for the life of the app.
 * Everything else is a free call into node:os.
 */

export interface Battery {
  percent: number;
  charging: boolean;
  /** "9:17" as pmset reports it, or null while it is still estimating. */
  remaining: string | null;
}

export interface Vitals {
  battery: Battery | null;
  load: [number, number, number];
  cores: number;
  memGB: number;
  uptimeSec: number;
  chip: string;
  os: string;
}

/** Parse `pmset -g batt`. Desktops (no battery) and odd output give null. */
export function parseBattery(text: string): Battery | null {
  const m = /(\d+)%;\s*([a-zA-Z ]+?);\s*(\d+:\d+|\(no estimate\))?/.exec(text);
  if (!m) return null;
  const state = m[2].trim().toLowerCase();
  return {
    percent: Number(m[1]),
    charging: state === "charging" || state === "charged" || state === "finishing charge",
    remaining: m[3] && m[3] !== "(no estimate)" && m[3] !== "0:00" ? m[3] : null,
  };
}

let battery: { at: number; value: Battery | null } | null = null;
let fixed: { chip: string; os: string } | null = null;

async function readBattery(): Promise<Battery | null> {
  if (battery && Date.now() - battery.at < 20_000) return battery.value;
  const { stdout } = await run("/usr/bin/pmset", ["-g", "batt"], 3000).catch(() => ({ stdout: "" }));
  battery = { at: Date.now(), value: parseBattery(stdout) };
  return battery.value;
}

async function readFixed(): Promise<{ chip: string; os: string }> {
  if (fixed) return fixed;
  const [chip, os] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], 3000).then((r) => r.stdout.trim()).catch(() => ""),
    run("/usr/bin/sw_vers", ["-productVersion"], 3000).then((r) => r.stdout.trim()).catch(() => ""),
  ]);
  fixed = { chip: chip || "Mac", os: os ? `macOS ${os}` : "macOS" };
  return fixed;
}

export async function readVitals(): Promise<Vitals> {
  const [bat, f] = await Promise.all([readBattery(), readFixed()]);
  const [a, b, c] = loadavg();
  return {
    battery: bat,
    load: [a, b, c].map((n) => Math.round(n * 100) / 100) as [number, number, number],
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    uptimeSec: Math.floor(uptime()),
    chip: f.chip,
    os: f.os,
  };
}
