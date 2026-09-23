import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./memory/paths.js";

/**
 * Where API keys live once Jarvis is an installed app.
 *
 * They cannot sit beside the executable: an installed .app bundle is read-only,
 * and anything written there would be destroyed by the next update anyway. This
 * keeps them in the user's own directory, which survives updates and is theirs
 * to inspect or delete.
 *
 * The file is chmod 600 — readable only by its owner. Keys in a world-readable
 * file are a real exposure on a shared machine, and the default umask does not
 * guarantee otherwise.
 */

const DIR = dataRoot();
const FILE = join(DIR, "keys.env");

export const keysPath = FILE;

/** The keys Jarvis knows how to use, with what each unlocks. */
export interface KeyField {
  env: string;
  label: string;
  help: string;
  /** Where the user gets one. */
  url: string;
  /** Jarvis works without it. */
  optional: boolean;
  /** Rough shape check, to catch a mis-paste before it fails at runtime. */
  looksValid?: (v: string) => boolean;
}

export const KEY_FIELDS: KeyField[] = [
  {
    env: "ANTHROPIC_API_KEY",
    label: "Claude",
    help: "Powers the main brain. Leave blank if you signed in with a Claude subscription instead.",
    url: "https://console.anthropic.com/settings/keys",
    optional: true,
    looksValid: (v) => v.startsWith("sk-ant-"),
  },
  {
    env: "GEMINI_API_KEY",
    label: "Gemini",
    help: "An alternative brain you can switch to by voice.",
    url: "https://aistudio.google.com/apikey",
    optional: true,
  },
  {
    env: "ELEVENLABS_API_KEY",
    label: "ElevenLabs",
    help: "A more natural speaking voice. Without it Jarvis uses the built-in macOS voice.",
    url: "https://elevenlabs.io/app/settings/api-keys",
    optional: true,
  },
  {
    env: "PICOVOICE_ACCESS_KEY",
    label: "Picovoice",
    help: "A dedicated wake-word engine. Without it the name is detected from speech, which works fine.",
    url: "https://console.picovoice.ai",
    optional: true,
  },
  {
    env: "OPENAI_API_KEY",
    label: "OpenAI",
    help: "An alternative brain (GPT) you can switch to by voice.",
    url: "https://platform.openai.com/api-keys",
    optional: true,
    looksValid: (v) => v.startsWith("sk-"),
  },
  {
    env: "SARVAM_API_KEY",
    label: "Sarvam",
    help: "Speech recognition and text-to-speech for Indian languages, and the streaming voice pipeline.",
    url: "https://dashboard.sarvam.ai",
    optional: true,
  },
  {
    env: "TELEGRAM_BOT_TOKEN",
    label: "Telegram",
    help: "Lets you message Echo from Telegram. Create a bot with @BotFather to get a token.",
    url: "https://t.me/BotFather",
    optional: true,
  },
  {
    env: "TYPESAFE_API_KEY",
    label: "TypeSafe (Jev)",
    help: "A second opinion the risk gate asks before an irreversible click or shell command.",
    url: "https://typesafe.ai",
    optional: true,
  },
];

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && /^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (v) out[k] = v;
  }
  return out;
}

export function readKeys(): Record<string, string> {
  if (!existsSync(FILE)) return {};
  try {
    return parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Save keys, replacing what was there. Blank values remove a key. */
export function writeKeys(keys: Record<string, string>): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

  const lines = [
    "# J.A.R.V.I.S API keys.",
    "# Written by the Setup window; safe to edit by hand.",
    "# Delete a line to remove that key.",
    "",
  ];
  for (const field of KEY_FIELDS) {
    const v = (keys[field.env] ?? "").trim();
    if (v) lines.push(`${field.env}=${v}`);
  }
  writeFileSync(FILE, lines.join("\n") + "\n");
  try {
    chmodSync(FILE, 0o600); // owner-only: these are credentials
  } catch {
    /* a filesystem without permissions is not worth failing over */
  }
}

/** Put saved keys into the environment. Real env vars still win. */
export function applyKeys(): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(readKeys())) {
    if (process.env[k] !== undefined) continue;
    process.env[k] = v;
    applied.push(k);
  }
  return applied;
}

/** True when nothing is configured — used to show Setup on a first run. */
export function needsSetup(): boolean {
  const keys = readKeys();
  const anyKey = KEY_FIELDS.some((f) => (keys[f.env] ?? process.env[f.env] ?? "").trim());
  return !anyKey;
}

/**
 * Whether each known key is set right now, from EITHER source — the durable
 * keystore or a real environment variable (typically a `.env` file loaded at
 * startup). A key that only ever lived in `.env` still needs to show as
 * "saved" here, or editing it through this UI would look like adding a
 * brand-new key instead of what it actually is: taking over from `.env`.
 */
export function keyStatus(): Record<string, boolean> {
  const keys = readKeys();
  const status: Record<string, boolean> = {};
  for (const f of KEY_FIELDS) status[f.env] = !!(keys[f.env] ?? process.env[f.env] ?? "").trim();
  return status;
}

/**
 * Save keys from a form where a blank field means "leave what is already
 * saved" — the one piece of logic `setup.ts` and the control panel both need,
 * now written once. Saved keys immediately win in THIS process too: `.env`
 * only ever fills a gap at startup (see env.ts), so once someone has edited a
 * key here it must not keep reading from a `.env` line that is now stale.
 *
 * Still true to the existing caveat: an already-constructed brain read its API
 * key once, at startup, and does not notice `process.env` changing under it —
 * switching brains or restarting is still what makes a NEW key actually used
 * for that provider's calls. This only removes the "was it saved at all"
 * confusion, not that deeper one.
 */
export function saveKeys(values: Record<string, string>): { count: number; changed: string[] } {
  const existing = readKeys();
  const merged: Record<string, string> = { ...existing };
  const changed: string[] = [];
  for (const f of KEY_FIELDS) {
    const v = (values?.[f.env] ?? "").trim();
    if (!v || v === existing[f.env]) continue;
    merged[f.env] = v;
    changed.push(f.env);
  }
  writeKeys(merged);
  for (const env of changed) process.env[env] = merged[env];
  return { count: Object.keys(merged).length, changed };
}
