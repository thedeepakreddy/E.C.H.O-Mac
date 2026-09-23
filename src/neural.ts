import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Echo's neural core: action potentials conducted along the real dendrites of a
 * neuron micrograph, shown when the user asks to see Echo's "core" /
 * "neural schema" / "mind".
 *
 * A SOLID (non-transparent) window on purpose — the same lesson as the orbital
 * panel: a transparent window hosting animated GPU content makes the compositor
 * reject frames and pins the machine. The visual is Canvas 2D (no WebGL), so it
 * stays light. It's a separate window, so the always-on reactor overlay keeps
 * its locked-down, self-contained guarantees untouched.
 */

let win: any = null;

export function openNeuralCore(): void {
  let electron: any;
  try {
    electron = nodeRequire("electron");
  } catch {
    return; // not in the main process
  }
  const { BrowserWindow, screen } = electron;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  const area = screen.getPrimaryDisplay().workAreaSize;
  const size = Math.min(920, Math.round(Math.min(area.width, area.height) * 0.86));

  win = new BrowserWindow({
    width: size,
    height: size,
    center: true,
    frame: false,
    transparent: false,
    backgroundColor: "#03050a",
    resizable: true,
    hasShadow: true,
    title: "Echo — Neural Core",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(join(__dirname, "..", "renderer", "neural.html"));
  win.on("closed", () => {
    win = null;
  });
}

export function closeNeuralCore(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

export function isNeuralOpen(): boolean {
  return !!win && !win.isDestroyed();
}

/**
 * Mirror a HUD channel into the neural window when it is open.
 *
 * The firing rate is meant to BE Echo's state, not a decoration of it, so the
 * window rides the same `state` and `level` events the reactor does.
 */
export function forwardToNeural(channel: string, payload: unknown): void {
  if (channel !== "state" && channel !== "level") return;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* the window can go away mid-send; the next state will find it gone */
  }
}
