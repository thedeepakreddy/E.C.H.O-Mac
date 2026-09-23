/** Helpers shared by the tool files in this folder. */
import { taskCoordinator } from "../../memory/task-state.js";
import type { MemoryScope } from "../../memory/types.js";
import { owningTaskId } from "../../frontier/task-handoff.js";
import * as act from "../computer-actions.js";
import { GLOBAL } from "../../memory/store.js";
import { currentContext } from "../../memory/context.js";
import { getAppPath } from "../../utils/appPath.js";
import { positionOf, type Display } from "../displays.js";
import * as remote from "../../frontier/remote.js";
import { qrDataUrl, saveRemoteUrl } from "../../frontier/remotelink.js";
import { sendToOverlay } from "../../overlay.js";
import { createRequire } from "node:module";

export const nodeRequire = createRequire(import.meta.url);

/**
 * Access electron lazily. A top-level `import ... from "electron"` makes the
 * whole tool registry unloadable outside the Electron main process — it broke
 * every test that bundles the registry for plain Node. Requiring it on demand,
 * with a null fallback, keeps the registry usable anywhere.
 */
export function electronApp(): any | null {
  try {
    return nodeRequire("electron").app;
  } catch {
    return null;
  }
}

export function appRoot(): string {
  return electronApp()?.getAppPath() ?? process.cwd();
}

/**
 * The scope a memory read or write belongs to.
 *
 * Scope is what keeps one project's decisions out of another's task. It comes
 * from the live task when there is one, because that is the only place the
 * project was actually decided; the frontmost window is a fallback hint, and a
 * window title is a guess, never an authorization boundary.
 */
export async function memoryScope(project?: string): Promise<MemoryScope> {
  const taskId = owningTaskId();
  const fromTask = taskId ? (taskCoordinator.get(taskId)?.scope as MemoryScope | undefined) : undefined;
  const projectId = project ?? fromTask?.projectId ?? (await currentContext().catch(() => null))?.project;
  return { ...fromTask, projectId: projectId && projectId !== GLOBAL ? projectId : undefined };
}

/** Where the pointer is, as a point. cliclick reports it as "x,y". */
export async function pointerAt(): Promise<{ x: number; y: number } | undefined> {
  try {
    const [x, y] = (await act.getMousePosition()).split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  } catch {
    return undefined;
  }
}

/** "the one on the right", for confirming which screen was chosen. */
export function describeDisplayShort(d: Display, all: Display[]): string {
  return d.primary ? "main" : positionOf(d, all);
}

/**
 * Put the phone-remote link on screen as a QR code, and save it to a file.
 *
 * A link ending in a 32-character token cannot be conveyed by voice, so the
 * spoken/HUD text is not the delivery mechanism — this is. Failing to draw the
 * QR must not fail opening the remote, so every step is best-effort.
 */
export async function showRemoteLink(url: string): Promise<void> {
  try {
    saveRemoteUrl(url);
  } catch {
    /* the QR is the primary path */
  }
  try {
    const qr = await qrDataUrl(url);
    sendToOverlay("show-remote-link", { url, qr });
  } catch (e) {
    console.error("[jarvis] could not render the remote QR:", (e as any)?.message ?? e);
  }
}
