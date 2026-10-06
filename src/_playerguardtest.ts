/**
 * A failing audio device must not take the process down.
 *   npm run playerguardtest
 *
 * From a real boot log:
 *
 *   engine failed to start: … com.apple.coreaudio.avfaudio error -10875
 *   [echo:process.uncaughtException] ERR_UNHANDLED_ERROR
 *   [perf] main process stalled ~3131ms
 *
 * An EventEmitter with no `error` listener THROWS when one is emitted.
 * `createPlayer` probes the voiceio helper, finds its microphone dead, tears
 * it down and builds a second one — and the caller only attaches its listener
 * after all that returns. The helper emitting a CoreAudio failure inside that
 * window was an unhandled throw, in the main process, at boot.
 *
 * Headphones coming and going is an ordinary Tuesday. It has to cost the
 * helper and nothing else.
 */
import { EventEmitter } from "node:events";
import { AfplayPlayer } from "./voice/player.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = "") =>
  c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`));

console.log("\nA dead audio device costs the player, not the process\n");

console.log("  the shape of the crash");
{
  // Node's own behaviour, pinned so the reason this matters stays visible.
  const bare = new EventEmitter();
  let threw = "";
  try { bare.emit("error", new Error("engine failed to start")); }
  catch (e: any) { threw = String(e?.message ?? e); }
  ok(!!threw, "an unlistened 'error' throws — this is the bug, not a metaphor", threw.slice(0, 60));
}

console.log("\n  a player from the factory is already guarded");
{
  // The factory is what callers use, and it is the only thing that can attach
  // a listener before the probe runs.
  const { createPlayer } = await import("./voice/player.js");
  const cfg: any = { voice: { captureEngine: "pvrecorder", ttsVoice: "Daniel", piperVoice: "" } };
  const player = await createPlayer(cfg, process.cwd());
  ok(player.listenerCount("error") >= 1,
    `it has an error listener from the start (${player.listenerCount("error")})`,
    "without one, any device failure before main.ts attaches its own is an uncaught throw");

  let threw = "";
  try { player.emit("error", "engine failed to start: CoreAudio -10875"); }
  catch (e: any) { threw = String(e?.message ?? e); }
  ok(!threw, "so emitting the real failure does not throw", threw.slice(0, 80));

  // And a caller adding its own must not replace the guard.
  player.on("error", () => {});
  ok(player.listenerCount("error") >= 2, "a caller's listener is added, not substituted");
}

console.log("\n  and the bare class is still usable on its own");
{
  const p = new AfplayPlayer();
  ok(p.name === "afplay" && p.aec === false, "constructed directly for tests as before");
}

console.log(`\n${pass}/${pass + fail} player-guard cases passed`);
console.log("A failure here means a flaky audio device can crash Echo at boot.\n");
process.exit(fail === 0 ? 0 : 1);
