import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, atomicWrite } from "./memory/paths.js";

/**
 * Voice shortcuts ("phrase" -> shell command), stored with the user's data.
 *
 * They used to live in <app>/shortcuts.json, which is read-only in an installed
 * app, would be replaced by every update, and was committed to the repository.
 * The app's copy is still read when the user has none yet, and the first change
 * carries its entries over.
 */
export interface Shortcut {
  command: string;
  reply?: string;
}

export function userShortcutsPath(): string {
  return join(dataRoot(), "shortcuts.json");
}

export function readShortcuts(appRoot: string): Record<string, Shortcut> {
  for (const file of [userShortcutsPath(), join(appRoot, "shortcuts.json")]) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err: any) {
      console.error(`[shortcuts] could not read ${file}: ${err?.message ?? err}`);
      return {};
    }
  }
  return {};
}

export function writeShortcuts(shortcuts: Record<string, Shortcut>): void {
  atomicWrite(userShortcutsPath(), `${JSON.stringify(shortcuts, null, 2)}\n`);
}
