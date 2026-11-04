import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { getAppPath } from "../utils/appPath.js";
import { decide, newGestureState, DEFAULT_REGION, type HandFrame } from "./gesturelogic.js";
import { desktopBounds } from "./displays.js";
import { loadConfig } from "../config.js";
import {withHumanComputerControl,humanComputerInputPending} from './human-control.js';
import {outsideAgentContext,currentAgentRunContext} from '../agent-replay/context.js';
import {moveMouse,click,hotkey} from './computer-actions.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Turns hand gestures into cursor movement, clicks and scrolling.
 *
 *   1 finger              move the cursor
 *   pinch thumb + index   click
 *   3 fingers             swipe to scroll
 *
 * The tracker reports every frame; the work here is deciding what deserves an
 * action. Two decisions do most of the work:
 *
 *   - Freeze the pointer while pinching. Bringing the thumb across physically
 *     drags the index tip, so tracking it through a pinch slides the cursor off
 *     target at the exact moment precision matters.
 *   - Never issue a move for a distance nobody can see. Running cliclick on
 *     every frame at 30fps floods the process table and makes the pointer
 *     stutter, which feels like bad tracking even when the tracking is fine.
 */

let trackerProc: ChildProcessWithoutNullStreams | null = null;

/** Arrow presses per horizontal swipe. */
const SCROLL_STEPS = 5;

export function toggleGestures(enable: boolean) {
  if(currentAgentRunContext()?.identity.background)throw Error('Office agents cannot enable foreground gesture controls.');
  if (!enable) {
    trackerProc?.kill();
    trackerProc = null;
    return;
  }
  if (trackerProc) return;

  let electron: any;
  try {
    electron = nodeRequire("electron");
  } catch {
    /* handled below */
  }
  // Outside the Electron main process, requiring "electron" yields the path to
  // the binary — a truthy string with no `screen` — so checking only for
  // truthiness crashed on getPrimaryDisplay() instead of bailing out.
  const screen = electron?.screen;
  if (!screen?.getPrimaryDisplay) {
    console.error("[jarvis] gestures need the Electron main process; not starting.");
    return;
  }

  // Span EVERY display, not just the primary one. Anchoring to the primary
  // meant the pointer stopped dead at its edge: on a two-monitor desk half the
  // desktop was simply unreachable by hand.
  const all = screen.getAllDisplays?.() ?? [screen.getPrimaryDisplay()];
  const surface = desktopBounds(
    all.map((d: any, i: number) => ({
      index: i,
      id: d.id,
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      primary: false,
    }))
  );
  if (all.length > 1) {
    console.log(`[jarvis] gestures span ${all.length} displays (${surface.width}x${surface.height})`);
  }
  // Which slice of the camera view maps to the screen; tunable per person.
  const region = (() => {
    try {
      return loadConfig(getAppPath()).gestureRegion ?? DEFAULT_REGION;
    } catch {
      return DEFAULT_REGION;
    }
  })();

  trackerProc = spawn(join(getAppPath(), "native", "handtracker"), ["gestures"]);

  // A missing or unrunnable helper must not kill the app. Without this, spawn
  // raises an uncaught ENOENT and Jarvis dies mid-sentence.
  trackerProc.on("error", (err: any) => {
    console.error("[jarvis] hand gesture control unavailable:", err?.message ?? err);
    trackerProc = null;
  });

  const state = newGestureState();

  const rl = createInterface({ input: trackerProc.stdout });
  rl.on("line", (line) => {
    let d: HandFrame;
    try {
      d = JSON.parse(line);
    } catch {
      return; // a partial line is not worth reporting
    }

    const action = decide(d, state, surface, Date.now(), region);
    if(humanComputerInputPending())return; // Do not queue stale camera frames.
    // Only actual camera frames enter the human lane, not model arguments.
    outsideAgentContext(()=>{
      try{void withHumanComputerControl(async()=>{
        if(action.kind==='click')await click(action.x,action.y);
        else if(action.kind==='move')await moveMouse(action.x,action.y);
        else if(action.kind==='scroll')await hotkey([],action.direction==='up'?'page-up':action.direction==='down'?'page-down':action.direction==='left'?'arrow-left':'arrow-right',action.direction==='left'||action.direction==='right'?SCROLL_STEPS:1);
      }).catch(()=>{});}catch{/* An Echo-owned desktop suspends human camera input. */}
    });
  });

  trackerProc.on("exit", () => {
    trackerProc = null;
  });
}
