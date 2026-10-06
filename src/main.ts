import { BrainLifecycle, type BrainHandlers } from "./brain/lifecycle.js";
import { controlSettingsFor, normalizeControlSettings } from "./runtime/control-settings.js";
import { stopTerminalCommands } from './system/terminal.js';
import {handleBuildInput,setCodingEventHandler,stopCodingWorkers} from './coding/dialogue.js';
import { shutdownStep, gracefulShutdown } from './shutdown.js';
import {RuntimeTimers} from './runtime/timers.js';
import { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, powerMonitor } from "electron";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync } from "node:fs";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { loadConfig, setActiveConfig, JarvisConfig, readUserConfig, writeUserConfig, userConfigPath } from "./config.js";
import { readShortcuts } from "./shortcuts-store.js";
import { loadEnv } from "./env.js";
import { applyKeys, needsSetup, readKeys, saveKeys, writeKeys } from "./keystore.js";
import { openSetupWindow, wireSetupIpc, closeSetupWindow } from "./setup.js";
import { createBrain, Brain, type Provider } from "./brain/index.js";
import { PROVIDERS, isProvider, PROVIDER_LABELS, parseBrainSwitch, unavailableReason } from "./brain/switching.js";
import { openAIUnavailableReason, resolveOpenAIAuth } from "./brain/openai-auth.js";
import { chatgpt } from "./brain/chatgpt-auth.js";
import { VoiceListener, scheduleCaptureCleanup, sweepOldCaptures } from "./voice/listener.js";
import { transcribe, transcribeLocal, detectSpokenLanguage, warmUpStt, stopSttServer, NOT_ENGLISH_BELOW } from "./voice/stt.js";
import { audioTurnFor, describeTurn } from "./voice/audio-turn.js";
import { listen, useHearingBridge, withTone } from "./voice/hearing.js";
import { matchWakeWord, isNameOnly } from "./voice/wakeword.js";
import { isHallucination } from "./voice/vocabulary.js";
import { stripEchoWords, classifyInterjection, isEchoItself, isStopIntent, isPlaybackTranscript } from "./voice/interjection.js";
import { currentContext } from "./memory/context.js";
import { memoryService } from "./memory/service.js";
import { record } from "./cognition/episodic.js";
import { dataRoot, memoryRoot, atomicWrite } from "./memory/paths.js";
import { enforceRetention } from "./memory/deletion.js";
import { ProviderMemoryContext } from "./memory/provider-context.js";
import { executeMemoryCommand, isMemoryCommand } from "./memory/commands.js";
import type { MemoryScope } from "./memory/types.js";
import { compact, stats } from "./memory/store.js";
import { playSound } from "./voice/sfx.js";
import { Tts } from "./voice/tts.js";
import { setActiveTts } from "./voice/speaker.js";
import { VoiceSession, type Turn, type WakeKind } from "./voice/session.js";
import { voiceLog, describeSummary } from "./voice/voice-log.js";
import { SileroVad } from "./voice/vad.js";
import { DEFAULT_NO_SPEECH_MS, type CaptureMeta } from "./voice/listener.js";
import { createSttStream, type SttStream } from "./voice/stt-stream.js";
import { SpeechStream } from "./voice/speech-stream.js";
import { STREAMING_ENGINES, PiperWorker } from "./voice/tts-stream.js";
import { vibeVoiceEndpoint } from "./voice/vibevoice.js";
import { createPlayer, type AudioPlayer } from "./voice/player.js";
import { createWakeDetector } from "./voice/wake/index.js";
import type { AudioTurn } from "./brain/types.js";
import { prefetch } from "./brain/prefetch.js";
import { closeOrbitalPanel } from "./orbital.js";
import { closeOsirisPanel, isOsirisOpen, isOsirisPinned, openOsirisPanel, reloadOsiris, setOsirisPinned } from "./osiris.js";
import { closeNeuralCore, forwardToNeural, openNeuralCore } from "./neural.js";
import { confirmations, ConfirmationBroker } from "./safety/confirm.js";
import { classify } from "./safety/risk.js";
import { shellQuote } from "./safety/shellquote.js";
import { matchReflex } from "./frontier/reflex.js";
import * as autoreflex from "./frontier/autoreflex.js";
import { RealtimeVoiceSession, realtimeAvailable, realtimeUnavailableReason, REALTIME_OUTPUT_RATE, REALTIME_VOICE_GUIDANCE } from "./voice/realtime.js";
import { SpeechClock, isSelfAudio } from "./voice/speech-clock.js";
import { quickReply } from "./voice/quick-reply.js";
import { readWavPcm } from "./voice/wav.js";
import { buildSystemPrompt } from "./brain/types.js";
import { conversationId } from "./memory/conversation.js";
import { replayWithGate } from "./frontier/gatedreplay.js";
import { Workflow } from "./frontier/demonstrate.js";
import { capture } from "./safety/snapshot.js";
import { attention, urgencyOf } from "./frontier/attention.js";
import { resetIdleTimer, stopDreamingNow, setDreamingEnabled, isDreaming } from "./frontier/dreamer.js";
import { onHudState, setAway } from "./frontier/hudstate.js";
import { narrateState, narrateSaid, feed } from "./frontier/narrate.js";
import { presenceMonitor } from "./frontier/presence.js";
import { noteLeft, noteReturned } from "./frontier/changed.js";
import { stopResearchNow } from "./frontier/researcher.js";
import {
  setInterruptHandler, stopRemote, setCommandHandler, macConfirmRelay, startRemote, record as remoteRecord,
  setStatusProvider, setActionHandler, setPublicUrlListener, setChatHandler, chatReply, chatIdle
} from "./frontier/remote.js";
import { listSessions as listCodingProjects } from "./coding/session.js";
import { hasPassword as hasRemotePassword } from "./frontier/remoteauth.js";
import { saveRemoteUrl } from "./frontier/remotelink.js";
import { relayFromConfig } from "./frontier/relay-agent.js";
import { startCaptureBridge, stopCaptureBridge } from "./frontier/remotecapture.js";
import { startTelegram, type TelegramBridge } from "./frontier/telegram.js";
import { toggleGestures } from "./tools/gestures.js";
import { toggleEyeTracking } from "./tools/eyetrack.js";
import { toggleSonar } from "./tools/sonar.js";
import { releaseCamera, releaseCameraSync } from "./frontier/camera.js";
import { setShutdownHandler } from "./lifecycle.js";
import {
  configureLearning,
  startTurn,
  finishTurn,
  datasetStats,
  describeStats,
  type Source as LearnSource,
} from "./learn/trajectory.js";
import { startRewind, stopRewind } from "./tools/rewind.js";
import { upcomingEvents } from "./tools/system.js";
import { startWatchdog, stopWatchdog } from "./tools/watchdog.js";
import { startGhostMode, stopGhostMode } from "./tools/ghost.js";
import { startAutoDebug, stopAutoDebug } from "./tools/autodebug.js";
import { embedRecentMemory } from "./tools/long_term_memory.js";
import { isRecordingMeeting, audioLogPath } from "./tools/meeting.js";
import { createOverlayWindow, destroyOverlayWindow, setOverlayInteractive, sendToOverlay } from "./overlay.js";
import { startShadowMode, stopShadowMode } from "./tools/shadow.js";
import * as ax from "./tools/ax.js";
import { disableOrtTelemetry } from "./utils/ortEnv.js";
import { installProcessHandlers, pendingRecoveries, pruneOldRunLogs, recordRendererError } from "./agent-replay/runtime.js";
import { swarm } from "./frontier/swarm.js";
import {supervisor,automaticTasks} from './tasks/runtime.js';
import {needsTaskDispatch} from './tasks/automatic.js';
import {captureAllowed} from './memory/capture-policy.js';
import {closeBackgroundBrowser} from './browser/background.js';
import {closeTaskReports} from './tasks/report-window.js';
import { listFleet, addFleetMember, removeFleetMember, grantableTools, getFleetMember, MAX_CUSTOM as FLEET_MAX_CUSTOM, type NewAgent } from "./frontier/fleet.js";
import { brainProjectHint, makeFleetBrain as fleetBrainFactory } from "./frontier/fleet-brain.js";
import { closeMcpServers, loadMcpConfig } from "./brain/mcp.js";
import {
  controlTelemetry,
  observeControlEvent,
  openControlPanel,
  publishControlUpdate,
  wireControlPanel,
  type ControlAction,
  type ControlRuntime,
  type ControlSettings,
} from "./control-panel.js";

// Before anything else boots. A rejection thrown during startup — a missing
// binary, a failed keychain read — used to happen before any recorder existed
// and left nothing behind but a process that had quietly stopped doing things.
// Neither handler swallows: uncaughtException is observed through
// uncaughtExceptionMonitor, so Node still dies exactly as it did before.
installProcessHandlers();

// Before anything can load onnxruntime or start a child that does (the VAD,
// the wake spotter, the embedder, the Piper voice worker). Its bundled
// Microsoft telemetry thread has crashed both Electron and the Python worker;
// setting this once here means every child process inherits it.
disableOrtTelemetry();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_ICON_PATH = join(__dirname, "..", "assets", "echo-icon.png");

let win: BrowserWindow | null = null;
let cfg: JarvisConfig;
let brain: Brain;
let brainLifecycle: BrainLifecycle | null = null;
let inputRevision = 0;
let shuttingDown = false;
let listener: VoiceListener | null = null;
let tts: Tts;
let voiceSession: VoiceSession;
/** The streaming voice: sentences to TTS as the model writes them, audio to one persistent player. */
let speech: SpeechStream | null = null;
let player: AudioPlayer | null = null;
/** They said the name and nothing else: the mic is open for the command, and "Yes?" is owed only if silence follows. */
let awaitingCommand: { turnId: string; asked: boolean } | null = null;
/** A spoken command was accepted this turn, so the conversation window opens once Echo has replied. */
let conversationWanted = false;
/** Streaming transcriptions in flight, one per capture, keyed by when the capture started. */
const sttStreams = new Map<number, { stream: SttStream; turnId?: string }>();

/**
 * Start transcribing a capture while it is still being spoken. Only captures
 * already addressed to Echo get here (a wake, a click, the window); always-on
 * captures stay local until their transcript proves they were for Echo.
 */
function startSttStream(meta: CaptureMeta) {
  if (meta.needsWakeWord || sttStreams.has(meta.captureStartAt)) return;
  const stream = createSttStream(cfg, meta.turnId, app.getAppPath());
  if (!stream) return;
  const entry = { stream, turnId: meta.turnId };
  sttStreams.set(meta.captureStartAt, entry);
  stream.on("partial", (text: string) => {
    voiceLog.event("stt.partial", { turnId: entry.turnId, text });
    send("state", { hearing: text });
    // What the sentence sounds like so far shapes how long to wait for its end.
    listener?.setEndpointHint(
      /[.?!]\s*$/.test(text) ? "punctuated"
        : /\b(and|or|but|so|um|uh|to|the|a|an|of|in|on|with|for|then)\s*$/i.test(text) ? "midclause"
          : null
    );
  });
  stream.on("error", (m: string) => console.log(`[voice] stt stream: ${m}`));
  stream.start(listener?.capturedFrames() ?? []).catch((err: any) => {
    console.log(`[voice] stt stream failed to start: ${err?.message ?? err}`);
    sttStreams.delete(meta.captureStartAt);
  });
}

/** The capture ended: collect the streamed transcript, bounded so a stall cannot hold the turn. */
async function finishSttStream(captureStartAt: number | undefined, turnId?: string): Promise<string | undefined> {
  if (captureStartAt === undefined) return undefined;
  const entry = sttStreams.get(captureStartAt);
  if (!entry) return undefined;
  sttStreams.delete(captureStartAt);
  const t0 = Date.now();
  const text = await Promise.race([
    entry.stream.end(),
    new Promise<string | null>((r) => setTimeout(() => r(null), 1800)),
  ]);
  if (!text) {
    entry.stream.abort();
    console.log(`[voice] stt stream gave nothing (${Date.now() - t0}ms) — falling back to the file path`);
    return undefined;
  }
  voiceLog.event("stt.final", { turnId, engine: entry.stream.name, ms: Date.now() - t0, text: text.slice(0, 80) });
  return text;
}

function abortSttStreams(why: string) {
  for (const [, e] of sttStreams) e.stream.abort();
  if (sttStreams.size) console.log(`[voice] aborted ${sttStreams.size} stt stream(s): ${why}`);
  sttStreams.clear();
}
let telegram: TelegramBridge | null = null;

/**
 * Where a turn's reply goes. A command from the phone remote or Telegram is
 * answered THERE — on the phone, or in the chat — and not out of the Mac's
 * speakers, where nobody asked. Keyed by voice-session turn id, so a new turn
 * at the Mac is local again without anything having to reset it.
 */
type RemoteChannel = "phone" | "telegram" | "chat";
const remoteTurns = new Map<string, RemoteChannel>();
function remoteChannelOf(turnId: string | null | undefined): RemoteChannel | undefined {
  return turnId ? remoteTurns.get(turnId) : undefined;
}
/** The channel for output being produced right now: the current turn's, else the brain's. */
function replyChannel(): RemoteChannel | "local" {
  // While the brain is still answering a turn, its words go back to where that
  // turn came from. A newer turn (a Listen tapped on the phone meanwhile) must
  // not take an older turn's answer: a hand-off's inbox summary was read aloud
  // on the phone that way, and never reached the chat that asked for it.
  if (voiceSession?.brainTurnActive) return remoteChannelOf(voiceSession.brainTurnId) ?? "local";
  return remoteChannelOf(voiceSession?.current?.id) ?? remoteChannelOf(voiceSession?.brainTurnId) ?? "local";
}
/** Send something Echo would have said to the device the turn came from. */
function deliverRemote(channel: RemoteChannel, text: string): void {
  if (channel === "telegram") {
    void telegram?.reply(text).catch((error) => console.error("[telegram] reply failed:", error));
  } else if (channel === "chat") {
    // The phone app's chat: a message in the conversation, not speech.
    chatReply(text);
  } else {
    // The phone polls these and reads them out in its own voice.
    remoteRecord(`Echo: ${text}`, "reply");
  }
}
let lastBrainStatus = "idle";
let lastAssistantText = "";
/**
 * AGI blueprint #12 (dynamic IQ scaling): consecutive failed turns on the free
 * local model. Scoped to whole turns, not individual tool calls within one —
 * the blueprint's "2 tool errors in a row -> hot-swap" needs a signal inside a
 * turn that nothing here currently emits, and inventing one meant threading a
 * new cross-cutting event out of gate.ts through three different brain event
 * systems. A turn is the coarser, already-wired signal: `finishTurn` already
 * runs at the end of every one. The escalation only changes which brain the
 * NEXT command reaches — it does not retry the failed turn itself, because
 * blindly re-issuing a multi-step GUI task on a different brain risks
 * repeating whatever the first attempt already did before it failed.
 */
/**
 * The turn autoReflex is currently recording, if any.
 *
 * matchReflex() has always been wired on the READ side (see the cache-hit
 * branch below), but the only caller of saveReflex is autoreflex.ts, which
 * nothing imported — so the cache could never be written and the fast path was
 * a permanent miss. ~/.jarvis/reflex/ did not even exist. Every repeated
 * command paid a full model round trip forever. This is the missing bridge.
 */
let autoReflexTurn: { command: string; capture: autoreflex.TurnCapture } | null = null;

/**
 * Speech-to-speech voice, when `voice.realtime.enabled` is on.
 *
 * The turn runs on a model that takes audio in and gives audio out, instead of
 * mic -> STT -> text -> brain -> text -> TTS. The captured audio goes to the
 * model as audio, so tone and emphasis survive, and the reply comes back spoken
 * rather than re-synthesised from bare text.
 *
 * Deliberately hooked at the UTTERANCE, not at the microphone. Full duplex
 * would mean replacing the wake word, the VAD and the barge-in machinery all at
 * once — the most delicate code in the app, and the source of its last two
 * voice bugs. This keeps every one of them and swaps only what happens between
 * "a capture finished" and "Echo speaks".
 *
 * Tools are still executed by Echo through the risk gate; see voice/realtime.ts.
 */
let realtime: RealtimeVoiceSession | null = null;
let realtimeSaid = "";
/**
 * Realtime audio is still coming out of the speaker.
 *
 * `turnComplete` means the MODEL stopped generating, not that Echo stopped
 * talking — the player still has queued audio. Treating the two as the same
 * opened the conversation window while Echo was mid-sentence.
 *
 * The first fix waited for the player's `drained` event, and that was worse:
 * `drained` did not arrive, so `realtimeSpeaking` stuck at true, and because
 * `echoIsSpeaking()` reads it, `maybeAutoListen()` returned early forever. The
 * conversation window then never opened AT ALL and every single turn needed the
 * wake word again — a regression on the behaviour it was meant to improve.
 *
 * So the end of speech is now COMPUTED, not awaited. The audio is 24 kHz mono
 * PCM16, a known 48000 bytes per second, so the bytes handed to the player say
 * exactly how long they take to play. `drained` is still honoured when it comes
 * (it ends the turn earlier), and a hard cap guarantees the flag always clears.
 * Nothing about re-arming the microphone should depend on an event that may
 * never fire.
 */
/**
 * When Echo's own voice last stopped coming out of the speaker.
 *
 * Belt AND braces against the self-conversation loop. Pausing capture (below)
 * is the real fix, but a single missed pause does not degrade gracefully here —
 * it is an infinite loop of PAID audio round trips, Echo answering itself until
 * a human notices. So any capture that BEGAN while Echo was talking is dropped
 * on arrival, whatever the listener did.
 *
 * MONOTONIC, because `CaptureMeta.captureStartAt` is `performance.now()`. The
 * first version of this used `Date.now()` and compared the two directly: a
 * monotonic reading (~34000, milliseconds since start) is always smaller than a
 * wall-clock one (~1.79e12), so EVERY capture looked like it began during
 * Echo's speech. Echo went permanently deaf after its first reply — the log
 * showed the user's own questions discarded as `echo_self_audio` fifty seconds
 * after Echo had stopped talking. Two clocks are not comparable; use the one
 * the value being compared against actually came from.
 */
let echoSpokeUntil = 0; // performance.now() units — see above

/**
 * What Echo has said aloud since this turn began.
 *
 * Hardware echo cancellation does not work on this machine, so a recording
 * made while Echo is talking contains Echo as well as whoever interrupted it.
 * This is the copy that gets subtracted back out — see `stripEchoWords`.
 *
 * Capped, and that cap is load-bearing rather than tidiness: the subtraction
 * deletes any three words the user says that Echo also said, so an unbounded
 * transcript of a long session would eventually start eating real commands.
 */
let spokenThisReply = "";
const SPOKEN_MEMORY_CHARS = 2000;
function noteSpoken(text: string): void {
  spokenThisReply = `${spokenThisReply} ${text}`.slice(-SPOKEN_MEMORY_CHARS);
}
/** Everything Echo's voice could have leaked into the microphone, on either speech path. */
function echoesOfMyself(): string {
  // `lastAssistantText` as well: the streaming path can finish a reply and
  // clear its own buffers before the microphone's copy of it arrives.
  return `${spokenThisReply} ${speech?.spokenSoFar() ?? ""} ${realtimeSaid} ${lastAssistantText}`;
}

/** Heard over a reply, held until that reply has finished saying its piece. */
let pendingInterjection: { wavPath: string; meta: CaptureMeta; transcript: string } | null = null;

const realtimeClock = new SpeechClock(
  { bytesPerSecond: REALTIME_OUTPUT_RATE * 2 }, // mono PCM16
  () => {
    // Echo has stopped talking: capture may resume. See the pause in the
    // 'audio' handler for why this matters so much on the realtime path.
    echoSpokeUntil = performance.now();
    listener?.setPaused(false);
    voiceSession.noteSpeaking(false);
    setStatus(lastBrainStatus);
    maybeAutoListen();
  }
);

/** Did this capture start while Echo was speaking? Then it is Echo's own voice. */
function isEchoTalkingToItself(meta: UtteranceMeta): boolean {
  return isSelfAudio({
    speaking: realtimeClock.speaking,
    captureStartAt: meta.captureStartAt,
    spokeUntil: echoSpokeUntil,
  });
}

async function ensureRealtime(): Promise<RealtimeVoiceSession | null> {
  if (realtime?.active && realtime.conversationId === conversationId("echo", currentScope())) { realtime.syncContext(); return realtime; }
  if (realtime) { realtime.close(); realtime = null; }
  const key = process.env[cfg.gemini?.apiKeyEnv ?? "GEMINI_API_KEY"];
  if (!key) return null;
  const session = new RealtimeVoiceSession(cfg, key, {
    scope: currentScope(),
    workingDir: cfg.control.workingDir,
    // The SHARED builder, not the bare persona: the three text brains had
    // already drifted once over exactly this, with Gemini loading no memories
    // at all. A fourth path with its own prompt would repeat it.
    //
    // The guidance appended here does not replace any of it — it corrects the
    // parts written for a text-then-TTS pipeline, which a model that speaks
    // directly otherwise reads as an instruction to start speaking Telugu.
    instruction: buildSystemPrompt(undefined, REALTIME_VOICE_GUIDANCE, false),
  });
  session.on("heard", (t: string) => send("state", { hearing: t }));
  session.on("said", (t: string) => {
    realtimeSaid += t;
    send("message", { kind: "assistant", text: realtimeSaid });
  });
  session.on("audio", (pcm: Buffer) => {
    // PAUSE CAPTURE WHILE ECHO SPEAKS. Both pipeline paths already do this and
    // the realtime path did not, which produced a genuine infinite loop: the
    // conversation window leaves the mic open with no wake word required, so
    // Echo's own voice was captured as the next command, answered, spoken,
    // captured again — Echo talking to itself, in alternating languages, until
    // someone stopped it. Every cycle is a paid audio round trip.
    //
    // setPaused only suspends CAPTURE, not hearing, so barge-in still works —
    // and it is also what seeds the listener's echo-peak baseline, which is
    // what stops Echo's own voice registering as the user interrupting.
    if (!realtimeClock.speaking) {
      listener?.setPaused(true);
      voiceSession.noteSpeaking(true);
    }
    realtimeClock.noteAudio(pcm.length);
    setStatus("speaking");
    player?.play(pcm, REALTIME_OUTPUT_RATE, 0);
  });
  session.on("tool", (name: string) => send("message", { kind: "action", text: `Running ${name}` }));
  // The model stopped because the user cut in; drop whatever is still queued.
  session.on("interrupted", () => { try { player?.stop(); } catch { /* ignore */ } });
  session.on("turnComplete", () => {
    if (realtimeSaid.trim()) lastAssistantText = realtimeSaid.trim();
    realtimeSaid = "";
    finishTurn("success", "realtime turn completed");
    // Only re-arm the mic once the SPEAKER is quiet, not when the model
    // stopped generating. The clock calls back when that happens.
    realtimeClock.noteTurnComplete();
  });
  session.on("error", (m: string) => {
    console.error(`[realtime] ${m}`);
    send("notice", { level: "error", text: `Realtime voice: ${m}` });
  });
  session.on("closed", () => { if (realtime === session) realtime = null; realtimeClock.noteDrained(); });
  // `drained` only ever ENDS a turn early — it is never depended on, because it
  // did not arrive and that is what broke the conversation window.
  player?.on("drained", () => realtimeClock.noteDrained());
  session.on("interrupted", () => realtimeClock.noteDrained());
  await session.connect();
  realtime = session;
  return session;
}

/**
 * Send one finished capture to the realtime model as AUDIO.
 *
 * Returns false when the session could not be opened, so the caller falls back
 * to the ordinary pipeline rather than dropping the turn — a voice that goes
 * silent because a preview model was unavailable is worse than a slow one.
 */
async function dispatchToRealtime(wavPath: string, turn: Turn | null, command = ""): Promise<boolean> {
  if (needsTaskDispatch(command)) return false;
  try {
    const session = await ensureRealtime();
    if (!session) return false;
    // Open a recorded turn, exactly as the text brains do.
    //
    // This path recorded NOTHING. `recordStep` and `finishTurn` both return
    // early without an active turn, so every tool the spoken session ran was
    // dropped and the `finishTurn("success")` on turnComplete labelled a turn
    // that was never opened. Because language routing sends every non-English
    // turn here, the whole Telugu and Hindi half of how Deepak actually uses
    // Echo was invisible to the dataset — the half a local model would most
    // need to learn from.
    //
    // The command is whatever the transcript managed; on this path it is
    // often poor or empty, which is WHY the audio went to a model that
    // listens. Recorded as-is rather than guessed at.
    beginLearnedTurn(command.trim() || "(spoken audio)");
    realtimeSaid = "";
    // A reset skips the clock's callback, so release the mic here too — an
    // abandoned turn must never leave capture paused for the rest of the session.
    if (realtimeClock.speaking) { listener?.setPaused(false); voiceSession.noteSpeaking(false); }
    realtimeClock.reset(); // never inherit the last turn's speaking state
    voiceSession.noteBrainSend(turn, "(audio)", "gemini-live");
    setStatus("thinking");
    const pcm = readWavPcm(wavPath);
    // 100ms of 16 kHz mono PCM16 per message, as the provider expects.
    for (let off = 0; off < pcm.length; off += 3200) {
      const slice = pcm.subarray(off, Math.min(off + 3200, pcm.length));
      session.push(new Int16Array(slice.buffer, slice.byteOffset, slice.length / 2));
    }
    session.endOfSpeech();
    return true;
  } catch (err: any) {
    console.error(`[realtime] dispatch failed, falling back: ${err?.message ?? err}`);
    return false;
  }
}

/** End the recording started for this turn, if one is open. Never throws. */
function endAutoReflex(success: boolean): void {
  const open = autoReflexTurn;
  if (!open) return;
  autoReflexTurn = null;
  void autoreflex
    .endTurn(open.command, open.capture, success, app.getAppPath())
    .catch((err) => console.error("[autoreflex] endTurn failed:", (err as any)?.message ?? err));
}

let ollamaFailureStreak = 0;
let expectAnswer = false;
/** Holds the detected project between memory init and brain creation. */
const createBrainProjectHint = brainProjectHint;

/**
 * The scope every turn is remembered and recalled under.
 *
 * Without this, memory is written with no project and the router cannot keep
 * one project's decisions out of another's task — which is the whole point of
 * scoping it. The frontmost window is a hint about which project the user is
 * in, refreshed per turn because they switch apps between sentences; it is
 * never a permission boundary, and a memory can still be explicitly global.
 */
function currentScope(): MemoryScope {
  const projectId = createBrainProjectHint.value;
  return { projectId: projectId && projectId !== "global" ? projectId : undefined };
}

/** Re-read the frontmost window's project, cheaply and never fatally. */
async function refreshScope(): Promise<void> {
  try {
    const ctx = await currentContext();
    if (ctx?.project) createBrainProjectHint.value = ctx.project;
  } catch { /* a scope hint is never worth failing a turn over */ }
}

function send(channel: string, payload: any) {
  win?.webContents.send(channel, payload);
  observeControlEvent(channel, payload);
  // The neural core's firing rate IS Echo's state, so it rides the same events.
  forwardToNeural(channel, payload);
}

function setStatus(status: string, extra: Record<string, any> = {}) {
  send("state", { status, ...extra });
}

/**
 * Which brain is about to act, named so the trainer can exclude the student.
 *
 * A model trained on its own output degrades a little each cycle until it is
 * useless, and the local brain is exactly where DeepakLLM will be served from —
 * so "ollama" alone is not a safe label. Once the model in use is the student,
 * its rows are tagged as such and the training set can drop them.
 */
/**
 * Which brain produced this turn, for the training set.
 *
 * `openai` was missing from both of these, and `Source` has always allowed it.
 * The effect was not a gap but WRONG DATA: a turn on the OpenAI brain was
 * filed as `source: "unknown"`, and `learnModel` fell through its last line
 * and recorded the CLAUDE model name against it. A dataset that says a GPT
 * turn came from Claude is worse than one that omits it.
 *
 * `BRAIN_SOURCES` is checked against `cfg.brain`'s own union by a wiring test,
 * so adding a fifth brain cannot quietly reintroduce this.
 */
const BRAIN_SOURCES: Record<string, LearnSource> = {
  claude: "claude",
  gemini: "gemini",
  ollama: "ollama",
  openai: "openai",
  openrouter: "openrouter",
  nvidia: 'nvidia',
};

function brainProvider(): string {
  return (brain?.provider ?? cfg.brain) as string;
}

function learnSource(): LearnSource {
  const provider = brainProvider();
  if (provider === "ollama" && /deepak/i.test(cfg.ollama?.model ?? "")) return "deepakllm";
  return BRAIN_SOURCES[provider] ?? (provider || "unknown");
}

function learnModel(): string {
  const provider = brainProvider();
  if (provider === "gemini") return cfg.gemini?.model ?? "";
  if (provider === "ollama") return cfg.ollama?.model ?? "";
  if (provider === "openai") return cfg.openai?.model ?? "";
  if (provider === "openrouter") return cfg.openrouter?.model ?? "";
  if (provider === "nvidia") return cfg.nvidia.model;
  if (provider === "claude") return cfg.claude?.model ?? "";
  // Preserve future provider metadata rather than attributing it to Claude.
  return String((brain as any)?.model ?? (cfg as any)[provider]?.model ?? "");
}

/** Open a recorded turn, so everything the brain does next is captured. */
function beginLearnedTurn(command: string) {
  startTurn(command, learnSource(), learnModel());
  // Learn the user's command patterns for safe pre-fetch/prediction. Only the
  // commands they give Echo — never keystrokes elsewhere.
  try {
    prefetch.learn(command);
  } catch {
    /* prediction is a nicety; never let it disturb a turn */
  }
}

/**
 * Is the local Ollama server up? The background helpers that lean on it should
 * start when it is actually there, not when some unrelated cloud brain is
 * selected. A short timeout so a missing server never stalls startup.
 */
async function ollamaReachable(host = "http://localhost:11434"): Promise<boolean> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Sized only for the reactor and its glow. The control panel is a separate
// centered window, so the always-on-top HUD never grows or shifts position.
const HUD_COMPACT = { width: 240, height: 240 };

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // Just big enough for the reactor plus its glow. The window is transparent
  // and always-on-top, so any extra size would sit over other apps swallowing
  // clicks that were never meant for Jarvis.
  const width = HUD_COMPACT.width;
  const height = HUD_COMPACT.height;
  win = new BrowserWindow({
    width,
    height,
    icon: ECHO_ICON_PATH,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height - 20,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    // macOS: an ordinary window cannot be drawn over ANOTHER app's fullscreen
    // Space, no matter how high its always-on-top level. Only an NSPanel can,
    // and that is what Jarvis needs to stay visible while you work fullscreen.
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // Float above everything, including other apps and fullscreen spaces.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(join(__dirname, "..", "renderer", "index.html"));

  win.on("closed", () => {
    win = null;
  });
}

/**
 * @param needsWakeWord true when the mic opened on its own (always-on keyless
 * mode), so the transcript has to actually start with "Jarvis" to count.
 */
/** Chirp so the user knows they were heard, without waiting on it. */
function acknowledgeWake(turnId?: string) {
  voiceLog.event("wake.ack", { turnId });
  const file = cfg.voice.wakeSound;
  if (!file) return;
  // The chirp used to PAUSE the mic for its whole 2.2 s, and pausing threw away
  // the capture in progress — so anything said right after the name was lost.
  // Now the mic keeps recording; only NEW captures are held off while it plays.
  listener?.holdOff(350);
  void playSound(file, cfg.voice.wakeSoundSeconds);
}

/** What the listener knew about the capture, so the turn's timings are real. */
interface UtteranceMeta {
  turnId?: string;
  wake?: WakeKind;
  captureStartAt?: number;
  speechStartAt?: number;
  speechEndAt?: number;
  /** Streaming STT already produced the transcript while the user spoke. */
  transcript?: string;
  /**
   * Recorded over Echo's own reply and already vetted as a real interruption
   * by the interjection path, so the self-audio guard must not drop it — that
   * guard exists for captures nobody has looked at yet.
   */
  overlap?: boolean;
}


/**
 * AGI blueprint #13 (implicit RLHF), the guardrailed version: the whole
 * utterance being praise or complaint, in the same "match the WHOLE trimmed
 * command" style as isStopIntent above — substring-matching "thanks" inside a
 * real, longer instruction ("thanks, and also open Mail") would misfire on
 * every polite request. Recorded through episodic memory's existing scoring
 * (cognition/episodic.ts, wired to every brain's prompt via factsForPrompt),
 * never by rewriting the persona or any system prompt directly — a single
 * sarcastic "thanks" or a "no" aimed at something else can never do more than
 * nudge a decayed, ranked memory the user can see and correct with `forget`,
 * the same as anything else Echo remembers.
 */
// Fully anchored start-to-end (bar optional trailing punctuation), the same
// discipline isStopIntent above uses — apostrophes are optional throughout
// because STT routinely drops them ("thats fast", "that didnt work").
const POSITIVE_FEEDBACK =
  /^(?:thanks?(?:\s+echo)?|thank\s*you(?:\s+echo)?|nice|perfect|great(?:\s*job)?|awesome|exactly|love\s*it|good\s*job|well\s*done|that(?:'?s|\s+is)\s+(?:fast|quick|great|perfect|awesome|helpful))[.!]?$/i;
const NEGATIVE_FEEDBACK =
  /^(?:that(?:'?s|\s+is)\s+wrong|not\s+what\s+i\s+(?:asked|wanted)|you\s+messed\s+(?:it|that)\s+up|that\s+didn'?t\s+work|wrong)[.!]?$/i;

function detectFeedback(command: string): 1 | -1 | 0 {
  const t = command.trim();
  if (POSITIVE_FEEDBACK.test(t)) return 1;
  if (NEGATIVE_FEEDBACK.test(t)) return -1;
  return 0;
}

/**
 * They said the name and nothing else. Open the mic for the command NOW rather
 * than after a spoken "Yes?" — the old round trip took ~2.5 s during which the
 * mic was paused, so the command that naturally follows a beat after the name
 * was exactly what got dropped. "Yes?" is said only if nothing follows.
 */
function awaitCommand(turn: Turn) {
  void refreshScope();
  awaitingCommand = { turnId: turn.id, asked: false };
  expectAnswer = false;
  setStatus("listening");
  listener?.triggerListen({ turnId: turn.id, wake: turn.wake, noSpeechMs: DEFAULT_NO_SPEECH_MS });
}

/**
 * Is Echo producing audio right now, on EITHER speech path?
 *
 * There are two, and only one of them is `tts`. With a streaming engine
 * (sarvam/elevenlabs/mac + ttsStreaming, which is the default) the reply is
 * spoken sentence-by-sentence by SpeechStream as the deltas arrive, and
 * `brain.on("text")` then returns early at `speech.ackBlock()` — so `tts.say()`
 * is never called for a streamed reply and `tts.isSpeaking()` stays false the
 * entire time Echo is talking.
 *
 * Asking `tts` alone therefore answered "no" during every streamed reply, which
 * is what left the control panel's humanoid idle while Echo spoke, let a brain
 * `status` event overwrite the speaking state, and let `maybeAutoListen()` arm
 * the microphone at turnEnd while audio was still playing.
 */
function echoIsSpeaking(): boolean {
  return tts.isSpeaking() || speech?.isSpeaking === true || realtimeClock.speaking;
}

/** Status to fall back to when a capture came to nothing. */
function idleStatus(): string {
  return echoIsSpeaking() ? "speaking" : lastBrainStatus;
}

/**
 * Every path into the brain goes through here, so the session knows which
 * output is current and every turn is stamped in the voice log.
 */
function dispatchToBrain(text: string, audio?: AudioTurn, turn: Turn | null = null, modality: "voice" | "text" = "voice") {
  if (shuttingDown) return;
  if (brainLifecycle?.isSwitching) {
    const revision = inputRevision;
    void brainLifecycle.ready().then(ready => {
      if (ready && !shuttingDown && revision === inputRevision) dispatchToBrain(text, audio, turn, modality);
    }).catch(error => console.error('[brain] pending command failed:', error));
    return;
  }
  const owner = brain;
  const revision = inputRevision;
  const stillCurrent = () => !shuttingDown && revision === inputRevision && owner === brain;
  const foregroundBusy=!!owner.currentTaskState && ['running','waiting','verifying'].includes(owner.currentTaskState.status);
  const savedStatus=automaticTasks.control(text,foregroundBusy);
  void (savedStatus?Promise.resolve(savedStatus):handleBuildInput(text, cfg, owner.currentTaskState,stillCurrent)).then(handled => {
    if (!stillCurrent()) return;
    handled ??= automaticTasks.handle(text,{scope:{...currentScope()},privateMode:!captureAllowed(),foregroundBusy});
    if (!handled) {dispatchToBrainUnchecked(text, audio, turn, modality); return;}
    voiceSession.noteBrainSend(turn,text,owner.provider ?? cfg.brain);
    speech?.newTurn();
    lastAssistantText = handled;
    voiceSession.noteBrainText(handled);
    send("message", {kind: "assistant", text: handled});
    tts.say(handled);
    voiceSession.noteBrainDone();
    const status = owner.currentTaskState?.status;
    if (status && ["running", "waiting", "verifying"].includes(status)) {
      if (!echoIsSpeaking()) setStatus(lastBrainStatus);
      maybeAutoListen();
    } else finishLocalTurn();
  }).catch(error => {
    if (!stillCurrent()) return;
    send("notice", {level: "error", text: `Command failed: ${String(error instanceof Error ? error.message : error)}`});
    finishLocalTurn();
  });
}
function dispatchToBrainUnchecked(text: string, audio?: AudioTurn, turn: Turn | null = null, modality: "voice" | "text" = "voice") {
  if (shuttingDown) return;
  controlTelemetry.beginTask(text);
  publishControlUpdate();
  voiceSession.noteBrainSend(turn, text, brain.provider ?? cfg.brain);
  speech?.newTurn();
  // Deliberately NOT cleared here.
  //
  // It used to be, with the comment "a new answer: the old one can no longer
  // be in the room". That is false, and it cost a self-conversation: Echo
  // speaks reply A, the microphone picks A up a few seconds later, and by the
  // time that capture is transcribed a NEW turn has started and wiped the
  // only record of what A was. `stripEchoWords` then had nothing to subtract,
  // filed Echo's own sentence as a command, and answered it — which started
  // another turn, which wiped the memory again. Six of eight turns in one
  // recorded session were Echo talking to itself.
  //
  // The window has to outlive the turn, because the SOUND does. It ages out
  // by SPOKEN_MEMORY_CHARS instead.
  // Open the TTS socket while the model thinks, so the first sentence does not wait for it.
  const channel = remoteChannelOf(turn?.id);
  if (cfg.voice.ttsEnabled && !channel) speech?.warm(text);
  // Speculative execution (AGI blueprint #10), scoped to the one read-only
  // call GUI tasks always pay for at the start: see ax.ts's warmDump doc
  // comment for why this is single-use and short-lived rather than a general
  // tool-call predictor.
  if (cfg.agi.speculative.enabled) ax.warmDump();
  // Second time you ask for something like this, record the steps so the reflex
  // cache can answer instantly next time. Records nothing on a first-time ask,
  // never steals an in-progress learn_workflow session, and only ever saves on
  // an explicit yes at the end of a SUCCESSFUL turn.
  endAutoReflex(false); // a turn starting means any previous one is over
  void autoreflex
    .beginTurn(text, cfg.agi.autoReflex, app.getAppPath())
    .then((capture) => { if (capture.capturing) autoReflexTurn = { command: text, capture }; })
    .catch((err) => console.error("[autoreflex] beginTurn failed:", (err as any)?.message ?? err));
  brain.send(text, audio, { modality, turnId: turn?.id, scope: currentScope(), ...(channel ? { channel } : {}) });
}

/**
 * @param needsWakeWord true when the mic opened on its own (always-on keyless
 * mode), so the transcript has to actually contain "Echo" to count.
 */
async function handleUtterance(wavPath: string, needsWakeWord = false, meta: UtteranceMeta = {}) {
  if (shuttingDown) return;
  const t0 = Date.now();
  // Echo's own voice, captured while it was speaking. Dropped before anything
  // is transcribed or sent: on the realtime path this is the difference between
  // one reply and Echo holding a conversation with itself, in alternating
  // languages, at the cost of a paid audio round trip per turn.
  if (realtimeAvailable(cfg) && !meta.overlap && isEchoTalkingToItself(meta)) {
    console.log("[realtime] ignoring a capture that began while Echo was speaking");
    voiceLog.event("capture.discarded", { turnId: meta.turnId, reason: "echo_self_audio" });
    return;
  }
  // A turn exists already when the capture was started deliberately (a wake, a
  // click, speech inside the window). An always-on capture only becomes a
  // turn once its transcript proves it was addressed to Echo.
  let turn: Turn | null = meta.turnId && voiceSession.isCurrent(meta.turnId) ? voiceSession.current : null;
  const stampCapture = (t: Turn) => {
    if (meta.captureStartAt) voiceLog.stampAt("capture.start", t.id, meta.captureStartAt);
    if (meta.speechStartAt) voiceLog.stampAt("vad.speech_start", t.id, meta.speechStartAt);
    if (meta.speechEndAt) voiceLog.stampAt("vad.speech_end", t.id, meta.speechEndAt);
    voiceLog.event("capture.end", { turnId: t.id, wake: t.wake });
  };
  if (turn) stampCapture(turn);
  if (!needsWakeWord) setStatus("thinking");
  console.log(`[echo] captured utterance -> ${wavPath}${needsWakeWord ? " (awaiting wake word)" : ""}`);

  // On a cloud provider the wake-word pass is still done locally: most captures
  // are room noise that was never addressed to Echo, and none of that should
  // leave the machine (or be paid for). The real command is re-transcribed with
  // the configured provider once the name actually matches.
  const wakeGatesCloud = needsWakeWord && cfg.voice.sttProvider === "sarvam";

  // Whether Echo listens to this turn itself rather than only reading it. The
  // bridge stands in for a brain that cannot hear; when the brain can, the
  // recording goes to it directly further down and no extra call happens here.
  const bridging = useHearingBridge(cfg, brain?.hearsAudio ?? false);
  // A detector/click/conversation window already gated these captures. Let
  // the more accurate ear run alongside Whisper, rather than after it. Room
  // audio still stays local until the transcript proves the wake word.
  const hearingAudio = bridging ? audioTurnFor(wavPath, { enabled: true, hearsAudio: true }) : null;
  const hearingAhead = hearingAudio && !needsWakeWord && !confirmations.isWaiting
    ? listen(hearingAudio, cfg) : null;

  let text = "";
  let sttEngine = "whisper";
  if (meta.transcript === undefined && !needsWakeWord) {
    meta.transcript = await finishSttStream(meta.captureStartAt, turn?.id);
  }
  if (meta.transcript !== undefined && meta.transcript.trim()) {
    text = meta.transcript;
    sttEngine = "stream";
  } else {
    try {
      // Either gate means the first pass is only there to find the wake word and
      // to hint the real one, so it stays local: cheap, offline, and nothing that
      // was never addressed to Echo leaves the machine.
      const localFirst = wakeGatesCloud || bridging;
      text = localFirst ? await transcribeLocal(wavPath, cfg) : await transcribe(wavPath, cfg);
      sttEngine = localFirst ? "whisper" : cfg.voice.sttProvider ?? "whisper";
    } catch (err: any) {
      console.error(`[echo] transcription failed: ${err?.message ?? err}`);
      send("notice", { level: "error", text: String(err?.message ?? err) });
      setStatus(idleStatus());
      return;
    }
  }
  if (turn) voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0, text: text.slice(0, 80) });
  console.log(`[echo] transcript (${Date.now() - t0}ms): ${JSON.stringify(text)}`);
  // Gemini Live for other languages, the ordinary pipeline for English. The
  // language check costs ~450 ms, so it runs only once a turn is really going
  // to be answered — never for room audio the wake word has not claimed.
  let liveDecision: Promise<boolean> | null = null;
  const useLive = (): Promise<boolean> => {
    // VibeVoice is the output layer for the selected brain. Gemini Live's
    // direct audio replies would bypass both that brain and this voice.
    if (cfg.voice.ttsEngine === "vibevoice") return Promise.resolve(false);
    if (!realtimeAvailable(cfg)) return Promise.resolve(false);
    if (cfg.voice.realtime?.languages !== "non-english") return Promise.resolve(true);
    return (liveDecision ??= detectSpokenLanguage(wavPath, cfg).then((heard) => {
      const other = heard.english < NOT_ENGLISH_BELOW;
      console.log(`[echo] spoken language: ${heard.language} (English ${heard.english.toFixed(2)}) — ${other ? "Gemini Live" : "normal pipeline"}`);
      return other;
    }));
  };

  let command = text.replace(/\[.*?\]|\(.*?\)/g, "").trim();
  const playbackLeak=(candidate:string)=> (echoIsSpeaking()||performance.now()-echoSpokeUntil<15000)&&isPlaybackTranscript(candidate,echoesOfMyself());
  if(playbackLeak(command)){voiceLog.event('capture.discarded',{turnId:turn?.id,reason:'echo_playback_transcript'});setStatus(idleStatus());return;}

  /**
   * Transcribe this utterance again with the configured cloud engine.
   *
   * Two callers — the wake-word gate and the hearing pass's fallback — so it
   * lives in one place. Returns null rather than throwing: a failure here must
   * leave the local transcript standing, never drop a spoken command.
   */
  const reTranscribeWithCloud = async (): Promise<string | null> => {
    try {
      const remote = await transcribe(wavPath, cfg);
      if (!remote) return null;
      const again = matchWakeWord(remote);
      return (again.matched ? again.command : remote).trim();
    } catch (err: any) {
      console.error(
        `[echo] ${cfg.voice.sttProvider} transcription failed, using local: ${err?.message ?? err}`
      );
      return null;
    }
  };

  // Whisper invents words for near-silence — "(laughing)", "Thank you.", "you".
  // These reached the brain as real commands; drop them before anything acts.
  if (isHallucination(command)) {
    console.log(`[echo] ignoring noise: ${JSON.stringify(text.trim().slice(0, 40))}`);
    if (turn) voiceLog.event("capture.discarded", { turnId: turn.id, reason: "noise" });
    // Noise inside the conversation window no longer ends the conversation —
    // that closed it on a cough. The window's own timer ends it.
    setStatus(idleStatus());
    return;
  }

  // Continuous Audio Log
  if (isRecordingMeeting) {
    try {
      mkdirSync(dataRoot(), { recursive: true });
      appendFileSync(audioLogPath(), `[${new Date().toISOString()}] ${command}\n`, "utf8");
    } catch (err) {
        console.error("[echo] could not append to the audio log:", (err as any)?.message ?? err);
      }
  }

  // A pending confirmation takes priority over everything, and needs no wake
  // word — Echo just asked you a direct question, so answer it.
  if (confirmations.isWaiting) {
    const answer = ConfirmationBroker.readAnswer(command);
    if (answer !== null) {
      confirmations.settle(null, answer);
      return;
    }
    // Neither yes nor no: re-ask rather than guessing at a destructive action.
    console.log(`[echo] ambiguous confirmation reply: ${JSON.stringify(command)}`);
    tts.say("Sorry — yes or no?");
    expectAnswer = true;
    if (!cfg.voice.ttsEnabled) maybeAutoListen();
    return;
  }

  if (needsWakeWord) {
    const { matched, command: rest } = matchWakeWord(text);
    if (!matched) {
      // Ordinary conversation in the room — not addressed to Echo. Stay quiet.
      console.log("[echo] no wake word — ignoring");
      setStatus(idleStatus());
      return;
    }
    // The transcript proved it: this capture is a turn.
    turn = voiceSession.beginTurn("transcript", meta.captureStartAt);
    stampCapture(turn);
    voiceLog.event("wake.detected", { turnId: turn.id, engine: "transcript", score: 1 });
    voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0 });
    console.log(`[echo] wake word matched; command = ${JSON.stringify(rest)}`);
    acknowledgeWake(turn.id);
    setStatus("thinking");

    // They only said the name: open the mic for the command.
    //
    // Except on the realtime path, where the transcript is NOT evidence about
    // what was said — only that Echo was addressed. Whisper's Telugu is poor,
    // and its initial prompt is stuffed with "Echo"/"Hey Echo" to help wake
    // detection, so an utterance it cannot read comes back as literally "Echo."
    // and looks like a bare name. A full Telugu question was being answered
    // with "Yes?" while the audio that actually contained it was thrown away —
    // and Gemini Live, which hears the recording itself, understands it fine.
    if (isNameOnly(rest) && !(await useLive())) {
      awaitCommand(turn);
      return;
    }
    command = rest;

    // Addressed to Echo, so the audio is worth sending to the better engine.
    // Skipped when the hearing pass is on: that reads the same recording with a
    // better ear a few lines below, and two cloud transcriptions of one spoken
    // sentence is one too many.
    if (wakeGatesCloud && !bridging) {
      const better = await reTranscribeWithCloud();
      if (better) {
        command = better;
        console.log(`[echo] re-transcribed via ${cfg.voice.sttProvider}: ${JSON.stringify(command)}`);
      }
    }
  } else {
    // A capture that started on the name being heard, a click, or speech in
    // the window. The recording begins before the name, so strip it if the
    // transcriber wrote it down — but never REQUIRE it: the detector already
    // decided this was addressed to Echo.
    const { matched, command: rest } = matchWakeWord(text);
    if (matched) command = rest;
    if (!turn) {
      turn = voiceSession.beginTurn(meta.wake ?? "manual", meta.captureStartAt);
      stampCapture(turn);
      voiceLog.event("stt.final", { turnId: turn.id, engine: sttEngine, ms: Date.now() - t0 });
    }
    // Same reasoning as above: on the realtime path the audio goes to the model
    // regardless, because the transcript may simply not be able to spell what
    // was said.
    if (isNameOnly(command) && meta.wake !== "answer" && !(await useLive())) {
      awaitCommand(turn);
      return;
    }
  }
  awaitingCommand = null;

  // "Stop" means stop, whichever way the mic opened.
  if (isStopIntent(command)) {
    stopEverything(`you said ${JSON.stringify(command)}`);
    return;
  }

  if (maybeQuickReply(command, turn, true)) return;

  // Implicit feedback on what Echo just said or did — recorded, not answered,
  // when the whole utterance IS the feedback (see detectFeedback's comment).
  if (cfg.agi.feedback.enabled && lastAssistantText) {
    const sentiment = detectFeedback(command);
    if (sentiment !== 0) {
      try {
        record({
          kind: sentiment > 0 ? "outcome" : "correction",
          text:
            sentiment > 0
              ? `You were pleased: "${command}" — about: ${lastAssistantText.slice(0, 150)}`
              : `You pushed back: "${command}" — about: ${lastAssistantText.slice(0, 150)}`,
          importance: sentiment > 0 ? 0.5 : undefined, // negative feedback keeps defaultImportance's own high correction weight
        });
      } catch (err) {
        console.error("[echo] feedback not recorded:", (err as any)?.message ?? err);
      }
      if (sentiment > 0) {
        send("notice", { level: "info", text: "🙂" });
        setStatus(idleStatus());
        return;
      }
      // Negative feedback still goes to the brain as a real message — "that's
      // wrong" is usually the start of a correction the model needs to act on,
      // not only a signal to remember.
    }
  }

  // Hear the turn rather than only reading it. The same recording, read by a
  // model that can listen: it returns what was actually said (the local whisper
  // pass above is only a hint to it) plus a short note on HOW it was said —
  // the part a text-only brain can never recover from a transcript.
  let tone: string | undefined;
  if (bridging) {
    const heard = hearingAhead ? await hearingAhead : hearingAudio ? await listen(hearingAudio, cfg, command) : null;
    if (turn && !voiceSession.isCurrent(turn.id)) return;
    if (heard?.transcript) {
      const again = matchWakeWord(heard.transcript);
      command = (again.matched ? again.command : heard.transcript).trim();
      tone = heard.tone;
      console.log(
        `[echo] heard (${Date.now() - t0}ms): ${JSON.stringify(command)}${tone ? ` · ${tone}` : ""}`
      );
    } else {
      // The ear is what failed, so fall back to the engine it replaced rather
      // than acting on the local pass's guess at a Telugu sentence.
      const better = cfg.voice.sttProvider === "sarvam" ? await reTranscribeWithCloud() : null;
      if (better) command = better;
    }
  }

  // Whisper returns "" or markers like [BLANK_AUDIO] for silence. Say so rather
  // than going quiet, which is indistinguishable from being ignored.
  if(playbackLeak(command)){voiceLog.event('capture.discarded',{turnId:turn?.id,reason:'echo_playback_after_hearing'});setStatus(idleStatus());return;}
  if (command.length < 2) {
    // On the realtime path an unreadable transcript is NOT evidence of silence.
    // This capture was addressed to Echo — the wake word matched, or the mic
    // opened deliberately — and whisper simply could not spell what followed:
    // its Telugu is poor and its initial prompt is stuffed with "Echo", so a
    // Telugu question comes back as the single word "Echo." and looks empty.
    //
    // Gemini Live hears the recording itself, so hand it the audio and let it
    // answer. It also covers a genuine bare "Echo" — it just replies as a
    // person would instead of Echo silently dropping the turn, which is what
    // the user experienced as "it listens and then goes quiet".
    if ((await useLive()) && (await dispatchToRealtime(wavPath, turn, command))) return;
    console.log("[echo] nothing intelligible in that utterance — ignoring");
    if (!needsWakeWord) send("notice", { level: "warn", text: "I didn't catch that." });
    voiceLog.event("capture.discarded", { turnId: turn.id, reason: "empty" });
    setStatus(idleStatus());
    return;
  }
  send("message", { kind: "user", text: command });
  voiceLog.event("note", { turnId: turn.id, transcript: command, wake: turn.wake });
  // A real command means the user is talking to Echo — keep (or start) the
  // conversation open so replies re-arm the mic without the wake word.
  if (conversationOn()) startConversation();

  const lowercaseCmd = command.toLowerCase();
  
  // Custom Shortcuts Intercept
  const cleanCmd = lowercaseCmd.replace(/[.,!?]/g, "").trim();
  {
    try {
      const shortcuts = readShortcuts(app.getAppPath());
      for (const [phrase, action] of Object.entries(shortcuts)) {
        const cleanPhrase = phrase.toLowerCase().replace(/[.,!?]/g, "").trim();
        let match = false;
        let param = "";
        
        if (cleanPhrase.includes("*")) {
          const regexStr = "^" + cleanPhrase.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "(.*)") + "$";
          const regex = new RegExp(regexStr);
          const res = cleanCmd.match(regex);
          if (res) {
            match = true;
            param = res[1].trim();
          }
        } else if (cleanCmd === cleanPhrase || cleanCmd.endsWith(cleanPhrase) || cleanCmd.startsWith(cleanPhrase)) {
          match = true;
        }

        if (match) {
          const actObj = action as any;
          let cmdToRun = actObj.command;
          if (param && cmdToRun.includes("$1")) {
            // The parameter comes from speech and lands inside a shell string,
            // so it must be neutralised. Injecting it raw meant that saying
            // "...x'; rm -rf ~; echo '" would run the injected command.
            const injected = cmdToRun.includes("http")
              ? encodeURIComponent(param)
              : shellQuote(param);
            cmdToRun = cmdToRun.replace(/\$1/g, injected);
          }

          // Shortcuts skip the model, so they used to skip the risk gate with
          // it — "empty the trash" deleted files with no confirmation. Classify
          // the command that will actually run, exactly as a tool call would be.
          const assessment = classify("Bash", { command: cmdToRun }, {
            workingDir: cfg.control.workingDir,
          });
          console.log(`[jarvis] shortcut "${phrase}" -> ${assessment.tier}: ${cmdToRun.slice(0, 80)}`);

          if (assessment.tier === "high") {
            const snap = assessment.snapshot
              ? await capture(assessment.snapshot, assessment.reason).catch(() => null)
              : null;
            const approved = await confirmations.request(
              `That shortcut will ${assessment.reason}.${snap ? " I've taken a snapshot first." : ""} Should I go ahead?`
            );
            if (!approved) {
              send("notice", { level: "warn", text: "Shortcut cancelled." });
              tts.say("Cancelled.");
              finishLocalTurn();
              return;
            }
          }

          if (actObj.reply) {
            send("notice", { level: "info", text: `Shortcut: ${actObj.reply}` });
            tts.say(actObj.reply);
          }
          exec(cmdToRun, (err) => {
            if (!err) return;
            console.error("[jarvis] Shortcut failed:", err);
            send("notice", { level: "error", text: `Shortcut "${phrase}" failed: ${err.message.slice(0, 120)}` });
          });
          finishLocalTurn();
          return;
        }
      }
    } catch (e) {
      console.error("[jarvis] shortcut failed:", e);
    }
  }

  // "Gemini." — just the name is the whole command. Handled here, before the
  // brain sees it, because the brain being replaced cannot be the one to decide
  // that it is being replaced.
  if (await maybeSwitchBrain(command)) return;

  // There used to be four hardcoded reflexes here — "open …", "type …",
  // "click …" and "email … saying …" — plus a Gmail prompt override. They are
  // gone. "open" swallowed every sentence that began with the word ("open
  // youtube and play…" never reached the model, and failed silently); "type"
  // lowercased the text; "click" pressed a button with no risk check, so
  // "click send" sent without asking; "email" spliced speech into AppleScript;
  // and the Gmail prompt contradicted the persona's own email steps. The
  // model has a tool for each, all behind the gate.

  const cached = needsTaskDispatch(command)?null:matchReflex(lowercaseCmd);
  if (cached) {
    send("notice", { level: "info", text: `Reflex Cache Hit! Executing instantly...` });
    tts.say("Got it, executing from reflex memory.");
    const wf: Workflow = {
      name: cached.query,
      createdAt: cached.createdAt,
      steps: cached.steps,
      parameters: [],
      runs: cached.successes,
      repairs: 0
    };
    // Through the gate, not around it: a cached workflow can contain "click
    // Send" just as easily as "click Inbox", and replaying it directly meant
    // those never asked for confirmation.
    void replayWithGate(wf, wf.steps, cfg.control.workingDir)
      .then((r) => {
        if (!r.ok) {
          send("notice", { level: "warn", text: r.summary });
          tts.say(r.summary);
        }
      })
      .catch((err) => send("notice", { level: "error", text: `Replay failed: ${err?.message ?? err}` }))
      .finally(finishLocalTurn);
    return;
  }

  beginLearnedTurn(command);

  // Let the brain hear the turn, not just read it. The transcript still goes as
  // the text of the turn — it is what the HUD shows, what memory keeps, and a
  // second opinion the model can weigh against what it hears.
  const heard = audioTurnFor(wavPath, {
    enabled: cfg.voice?.sendAudioToBrain === true,
    hearsAudio: brain.hearsAudio,
  });
  if (heard) console.log(`[echo] sending ${describeTurn(heard)} of audio to the brain`);
  // A brain that heard the turn needs no note about it; one that didn't gets
  // what the hearing pass noticed, which is the whole point of that pass.
  // Speech-to-speech first when it is on: the model hears the recording itself,
  // so tone and emphasis reach it instead of being flattened into a transcript.
  if ((await useLive()) && (await dispatchToRealtime(wavPath, turn, command))) return;
  dispatchToBrain(heard ? command : withTone(command, tone), heard ?? undefined, turn);
}

/**
 * When Jarvis ends a turn by asking something ("what kind of app?"), re-open the
 * mic automatically once it has finished speaking, so the user can just answer
 * out loud instead of waking it again.
 */
/**
 * A pending confirmation owns the next thing you say. Wired here because the
 * broker deliberately knows nothing about audio.
 */
function wireConfirmations() {
  confirmations.on("ask", ({ id, question }: { id: string; question: string }) => {
    console.log(`[jarvis] confirm: ${question}`);
    send("message", { kind: "assistant", text: question });
    send("state", { status: "confirming" });
    voiceSession.transition("confirming", "question pending");
    tts.say(question);
    // Open the mic once the question has been spoken, so an answer is expected.
    expectAnswer = true;
    if (!cfg.voice.ttsEnabled) maybeAutoListen();

    // Mirror the question to a connected phone, carrying the SAME id so an
    // approval from the phone settles this exact action. The relay's timeout is
    // longer than the broker's, so it never denies ahead of the local prompt —
    // only a real tap on the phone resolves it early.
    try {
      const { answered } = macConfirmRelay().ask(question, "high", 40_000, id);
      answered.then((approved) => {
        if (approved) confirmations.settle(id, true, "approved from phone");
        else confirmations.settle(id, false, "denied from phone");
      });
    } catch {
      /* the phone mirror must never break the local confirmation */
    }
  });

  confirmations.on("settled", ({ id, approved, why }: { id: string; approved: boolean; why: string }) => {
    console.log(`[jarvis] confirm -> ${approved ? "APPROVED" : "DENIED"}${why ? ` (${why})` : ""}`);
    // However it was answered, clear it from the phone's screen.
    try {
      macConfirmRelay().dismiss(id);
      } catch (err) {
        console.error("[jarvis] could not dismiss the phone confirmation:", (err as any)?.message ?? err);
      }
    if (!approved && why === "no answer") tts.say("No answer, so I'll leave it.");
    setStatus(lastBrainStatus);
  });
}

/**
 * Conversation mode: after you wake Echo once, the session keeps a window open
 * after each reply in which speech alone starts the next turn — no wake word.
 * The window is owned by the VoiceSession (see voice/session.ts): it opens once
 * Echo has finished replying, every user turn extends it, and only its timer
 * or an explicit stop closes it. Noise no longer ends it, which used to make a
 * cough the end of the conversation.
 */
const conversationOn = () => cfg.voice?.conversationMode !== false;

function startConversation() {
  conversationWanted = true;
  voiceSession.extendWindow();
}
function endConversation(why = "stopped") {
  conversationWanted = false;
  voiceSession.closeWindow(why);
}

/**
 * Called whenever Echo falls silent (speech finished, or a turn ended with
 * nothing to say). Re-opens the mic for an answer Echo asked for, or opens the
 * conversation window so the user can simply keep talking.
 */
function maybeAutoListen() {
  if (shuttingDown || brainLifecycle?.isSwitching) return;
  if (echoIsSpeaking()) return;
  // Something was said over the reply and held until it had finished. That IS
  // the next turn, so it runs before the mic is reopened for a different one.
  if (drainPendingInterjection()) return;
  if (expectAnswer || awaitingCommand) {
    // Echo asked something, or heard only its name: open the mic explicitly
    // and give up quietly if nothing follows.
    const asked = !!awaitingCommand;
    expectAnswer = false;
    const turn = voiceSession.beginTurn("answer");
    if (awaitingCommand) awaitingCommand = { turnId: turn.id, asked: true };
    const revision = inputRevision;
    setTimeout(() => {
      if (!shuttingDown && revision === inputRevision) listener?.triggerListen({turnId: turn.id, wake: "answer", noSpeechMs: asked ? 4000 : 6000});
    }, 250);
    return;
  }
  if (conversationOn() && conversationWanted) voiceSession.openWindow("reply finished");
}

/**
 * A turn answered here, with no brain involved (a shortcut, a cached reflex).
 *
 * The brain's `turnEnd` is what normally takes the HUD out of "thinking" and
 * reopens the conversation window. Nothing emits it for these, so without this
 * the reactor stayed on "thinking" and the next sentence needed the wake word.
 */
function finishLocalTurn(): void {
  lastBrainStatus = "idle";
  if (!echoIsSpeaking()) setStatus("idle");
  maybeAutoListen();
}

function maybeQuickReply(command: string, turn: Turn | null = null, showUser = false): boolean {
  if (confirmations.isWaiting || echoIsSpeaking() || !["idle", "sleeping", "asleep"].includes(lastBrainStatus)) return false;
  const reply = quickReply(command);
  if (!reply) return false;
  turn ??= voiceSession.beginTurn("typed");
  if (showUser) send("message", { kind: "user", text: command });
  voiceSession.noteBrainSend(turn, command, "local-social");
  speech?.newTurn();
  lastAssistantText = reply;
  send("message", { kind: "assistant", text: reply });
  voiceSession.noteBrainText(reply);
  if (conversationOn()) startConversation();
  tts.say(reply);
  expectAnswer = /\?\s*$/.test(reply);
  voiceSession.noteBrainDone();
  finishLocalTurn();
  return true;
}

/** Everything stops: speech, the brain, the conversation. The one path for every stop control. */
function stopEverything(why: string) {
  inputRevision++;
  // Anything held back to be answered after the reply is part of what is being
  // stopped. Draining it later would answer a question the user has abandoned.
  if (pendingInterjection) {
    scheduleCaptureCleanup(pendingInterjection.wavPath);
    pendingInterjection = null;
  }
  const heard = speech?.spokenSoFar() ?? "";
  voiceSession.cancel("stop", why);
  abortSttStreams(why);
  tts.stop();
  brain.noteInterrupted?.(heard);
  voiceLog.event("audio.stopped", { turnId: voiceSession.current?.id, why });
  brain.interrupt();
  void supervisor.cancelOwned().catch(error=>console.error('[tasks] cancellation failed:',error));
  endConversation(why);
  awaitingCommand = null;
  expectAnswer = false;
  setStatus("idle");
  // Being stopped mid-task is the user saying this was going wrong. Recording
  // it as a success would teach exactly the behaviour they just cut short.
  finishTurn("rejected", why);
  endAutoReflex(false);
  controlTelemetry.stopMainTasks();
  send("notice", { level: "info", text: "Stopped." });
}

function brainHandlers(): BrainHandlers {
    let failed = false;
    return {
        "text": (t: string) => {
            console.log(`[echo] says: ${t}`);
            const live = voiceSession.brainOutputIsLive();
            const channel = replyChannel();
            voiceSession.noteBrainText(t);
            narrateSaid(t);
            lastAssistantText = t;
            send("message", { kind: "assistant", text: t });
            // Asked from the phone or Telegram: answered there, and not spoken
            // at the Mac. Shown on the HUD all the same.
            if (channel !== "local") {
                if (live) deliverRemote(channel, t);
                return;
            }
            remoteRecord(`Echo: ${t}`, "jarvis");
            // Output the user has already cancelled is shown, never spoken: a stale
            // answer read out a moment after "stop" is the most confusing thing a voice
            // assistant can do.
            if (!live) {
                console.log("[voice] not speaking output from a cancelled turn");
                return;
            }
            // Streamed blocks were spoken sentence by sentence as they arrived; this
            // is the same text again, whole, for the consumers above. Not twice.
            if (speech?.tookDeltas()) {
                speech.ackBlock();
                return;
            }
            // Answers and questions go out immediately; unprompted observations wait
            // until the user is not mid-keystroke. Nothing is dropped — anything held
            // is released by the timer below once it is overdue.
            const now = attention.offer(t, urgencyOf(t));
            if (now)
                tts.say(now);
        },
        "textDelta": ({ text }: {
            text: string;
        }) => {
            if (!speech || !cfg.voice.ttsEnabled)
                return;
            if (!voiceSession.brainOutputIsLive())
                return; // cancelled: shown later, never spoken
            if (replyChannel() !== "local")
                return; // answered on the phone or in Telegram, not aloud here
            speech.feed(text);
        },
        "textDone": () => {
            if (speech && voiceSession.brainOutputIsLive() && replyChannel() === "local")
                speech.endBlock();
        },
        "tool": (info: {
            name: string;
            summary: string;
        }) => {
            controlTelemetry.tool(info.name);
            console.log(`[jarvis] doing: ${info.summary}`);
            remoteRecord(`Action: ${info.summary}`, "action");
            send("message", { kind: "action", text: info.summary });
        },
        'progress': (text: string) => { send('message', { kind: 'action', text }); controlTelemetry.observe('notice', { level: 'info', text }); publishControlUpdate(); },
        "risk": (r: {
            tool: string;
            tier: string;
            reason: string;
        }) => {
            // Low risk is the overwhelming majority; logging it would bury everything else.
            if (r.tier !== "low") {
                console.log(`[jarvis] risk=${r.tier.padEnd(6)} ${r.reason}`);
                remoteRecord(`Risk [${r.tier}]: ${r.reason}`, "warn");
            }
        },
        "status": (s: string) => {
            lastBrainStatus = s;
            narrateState(s);
            if (!echoIsSpeaking())
                setStatus(s);
        },
        "turnEnd": () => {
            lastBrainStatus = "idle";
            expectAnswer = /\?\s*$/.test(lastAssistantText.trim());
            lastAssistantText = "";
            // Reaching the end of a turn without an error is the weakest useful success
            // signal. It is provisional: an "undo that" a moment later overrides it.
            if (!failed) {
                finishTurn("success", "turn completed");
                endAutoReflex(true);
                ollamaFailureStreak = 0;
                controlTelemetry.finishTask("done");
            }
            publishControlUpdate();
            telegram?.finishTurn(); chatIdle();
            voiceSession.noteBrainDone();
            // If TTS is off there is no speech-finished callback, so arm the mic now.
            maybeAutoListen();
            if (failed)
                maybeEscalateBrain();
            failed = false;
        },
        "error": (msg: string) => {
            console.error(`[jarvis] brain error: ${msg}`);
            remoteRecord(`Error: ${msg}`, "stop");
            if (!failed) {
                failed = true;
                finishTurn("failure", msg.slice(0, 200));
                endAutoReflex(false);
                controlTelemetry.finishTask("failed");
            }
            publishControlUpdate();
            telegram?.finishTurn(); chatIdle(msg);
            send("notice", { level: "error", text: msg });
        }
    };
}

/** See the `ollamaFailureStreak` comment above for what this does and does not do. */
function maybeEscalateBrain(): void {
  const esc = cfg.agi.escalation;
  const provider = brain?.provider ?? cfg.brain;
  if (!esc.enabled || provider !== "ollama") {
    ollamaFailureStreak = 0; // only ever counts a streak ON ollama
    return;
  }
  ollamaFailureStreak++;
  if (ollamaFailureStreak < esc.failureThreshold) return;
  ollamaFailureStreak = 0;
  console.log(`[jarvis] local model failed ${esc.failureThreshold} turn(s) in a row — escalating to Claude`);
  void switchBrain("claude").then((message) => {
    if (brain?.provider === "claude") {
      send("notice", { level: "info", text: `Escalated to Claude after repeated local failures. ${message}` });
      tts.say("The local model kept failing, so I've switched to Claude to take over from here.");
    } else send("notice", {level: "error", text: `Could not escalate after local failures. ${message}`});
  });
}

/**
 * Remember the choice, so a restart comes back on the brain you last asked for.
 *
 * Only the one key is touched: config.json is hand-edited and full of `//`
 * comment keys, and rewriting it wholesale from a runtime object is how those
 * get quietly reordered or dropped.
 */
const mutableConfigPath = userConfigPath;
const readMutableConfigBase = () => readUserConfig(app.getAppPath());
const writeMutableConfig = writeUserConfig;

function persistBrainChoice(provider: Provider): void {
  try {
    const configData = readMutableConfigBase();
    if (configData.brain === provider) return;
    configData.brain = provider;
    writeMutableConfig(configData);
  } catch (err: any) {
    // Not fatal: the brain has already changed for this session.
    console.error(`[jarvis] could not save the brain choice: ${err?.message ?? err}`);
  }
}

function controlSettings(): ControlSettings {
  return controlSettingsFor(cfg, mutableConfigPath());
}

async function saveControlSettings(input: Partial<ControlSettings> | undefined): Promise<string> {
  const next = normalizeControlSettings(controlSettings(), input);
  if (next.voice.ttsEngine === "vibevoice") {
    if (!next.voice.vibeVoiceUrl) throw new Error("Enter your VibeVoice server address before selecting it.");
    vibeVoiceEndpoint(next.voice.vibeVoiceUrl);
    if (!next.voice.ttsStreaming) throw new Error("Enable streaming speech to use VibeVoice.");
  }
  const blocked = brainUnavailable(next.brain);
  if (blocked) throw new Error(`${PROVIDER_LABELS[next.brain]} is unavailable: ${blocked}. Add the key under API Keys first.`);
  const data = readMutableConfigBase();
  data.brain = next.brain;
  data.voice = { ...(data.voice ?? {}), ...next.voice };
  data.hud = { ...(data.hud ?? {}), ...next.hud };
  data.memory = { ...(data.memory ?? {}), ...next.memory };
  data.helpers = { ...(data.helpers ?? {}), ...next.helpers };
  data.dreaming = { ...(data.dreaming ?? {}), ...next.dreaming };
  data.learning = { ...(data.learning ?? {}), ...next.learning };
  writeMutableConfig(data);

  const previousProvider = (brain?.provider ?? cfg.brain) as Provider;
  Object.assign(cfg.voice, next.voice);
  Object.assign(cfg.hud, next.hud);
  Object.assign(cfg.memory, next.memory);
  Object.assign(cfg.helpers, next.helpers);
  Object.assign(cfg.dreaming, next.dreaming);
  Object.assign(cfg.learning, next.learning);
  tts.setEnabled(next.voice.ttsEnabled);
  setDreamingEnabled(next.dreaming.enabled);
  configureLearning(next.learning);
  if (next.helpers.shadow) startShadowMode(tts, next.helpers.shadowIntervalSeconds); else stopShadowMode();
  if (next.helpers.ghost) startGhostMode(tts); else stopGhostMode();
  if (next.helpers.autoDebug) startAutoDebug(tts); else stopAutoDebug();
  const providerMessage = previousProvider === next.brain ? "" : await switchBrain(next.brain);
  publishControlUpdate();
  return `${providerMessage ? `${providerMessage} ` : ""}Settings saved. Voice output and background helpers are live; wake, capture, and engine changes apply after restart.`;
}

/** Why a brain cannot run right now, or null. OpenAI counts a ChatGPT sign-in as well as a key. */
function brainUnavailable(provider: Provider): string | null {
  return provider === "openai"
    ? openAIUnavailableReason(cfg)
    : unavailableReason(provider, process.env, cfg.gemini?.apiKeyEnv, cfg.openai?.apiKeyEnv, cfg.openrouter?.apiKeyEnv, cfg.nvidia?.apiKeyEnv);
}

/** The OpenAI model in use: the plan's when paying with ChatGPT, else the API-key model. */
function openAIModelLabel(): string {
  return resolveOpenAIAuth(cfg)?.via === "chatgpt"
    ? cfg.openai.chatgptModel?.trim() || "your ChatGPT plan's default model"
    : cfg.openai.model;
}

/**
 * The models the OpenRouter card offers, and whether it has a key.
 *
 * Synchronous on purpose: a panel update happens often, and must never wait
 * on the network. `refreshOpenRouterCatalogue` does the fetching in the
 * background and this reads whatever the last one left.
 */
let openRouterModels: Array<{ id: string; label: string; contextLength: number }> = [];
let openRouterNote: string | undefined;

function openRouterCatalogue() {
  return {
    signedIn: !!process.env[cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY"]?.trim(),
    models: openRouterModels,
    ...(openRouterNote ? { note: openRouterNote } : {}),
  };
}

/** Pull the live list, then tell the panel. Safe to call at any time. */
async function refreshOpenRouterCatalogue(force = false): Promise<void> {
  try {
    const { offerableModels } = await import("./brain/openrouter-models.js");
    const { models, note } = await offerableModels({ force });
    openRouterModels = models.map((m) => ({ id: m.id, label: m.label, contextLength: m.contextLength }));
    openRouterNote = note;
  } catch (err) {
    openRouterNote = `Couldn't read OpenRouter's model list (${(err as any)?.message ?? err}).`;
  }
  publishControlUpdate();
}

/** What the control panel shows on the ChatGPT card. Never a token. */
function openAIAccount() {
  const session = chatgpt.session();
  const auth = resolveOpenAIAuth(cfg);
  return {
    billing: (auth?.via ?? "none") as "chatgpt" | "apiKey" | "none",
    chatgpt: { status: session.status, planUsage: session.planUsage, email: session.email, error: session.error },
  };
}

/** Replace the foreground provider through its lifecycle owner. */
async function switchBrain(target: Provider, restart = false): Promise<string> {
  if (!brainLifecycle || shuttingDown) return "Echo is not ready to change brains.";
  return (await brainLifecycle.switch(target, restart)).message;
}

/** Rebuild copied credentials immediately; forgetting a key must stop its user. */
async function refreshCredentialBrain(provider: Provider): Promise<string> {
  const lifecycle = brainLifecycle;
  if (!lifecycle || shuttingDown) return "";
  if (!await lifecycle.ready() || shuttingDown || lifecycle.provider !== provider) return "";
  const target = brainUnavailable(provider) ? "claude" : provider;
  return (await lifecycle.switch(target, target === provider)).message;
}

async function refreshChangedKeys(changed: readonly string[]): Promise<string> {
  const lifecycle = brainLifecycle;
  if (!lifecycle || shuttingDown || !await lifecycle.ready()) return "";
  const provider = lifecycle.provider;
  const env = provider === "claude" ? "ANTHROPIC_API_KEY" : provider === "gemini" ? cfg.gemini.apiKeyEnv
    : provider === "openai" ? cfg.openai.apiKeyEnv : provider === "openrouter" ? cfg.openrouter.apiKeyEnv : provider === 'nvidia' ? cfg.nvidia.apiKeyEnv : null;
  return env && changed.includes(env) ? refreshCredentialBrain(provider) : "";
}

function activateMainBrain(instance: {brain: Brain; provider: Provider}): void {
  brain = instance.brain;
  cfg.brain = instance.provider;
  brain.projectHint = createBrainProjectHint.value;
  (global as any).__mainBrain = brain;
  send("state", {provider: instance.provider});
  lastBrainStatus = "idle";
  setStatus("idle");
}

/**
 * Handle a command that is only a brain name, wherever it came from.
 *
 * Returns true when it took the command, so the caller stops: voice, typed
 * chat, phone remote and Telegram all route through here and all get the same
 * behaviour, rather than the spoken path being the only one that works.
 */
/**
 * A pending confirmation owns the next thing you SAY OR TYPE.
 *
 * The voice path has always routed "yes" to the waiting question. Typed input
 * did not: it started a fresh turn, left the question hanging until it timed
 * out into a denial, and the model — told it had been refused — asked again.
 * From the user's side that is "I keep saying yes and it keeps asking me".
 *
 * Every way into Echo goes through here now, so the answer lands wherever it
 * was typed: the HUD, the phone remote, or Telegram.
 */
function maybeAnswerConfirmation(text: string): boolean {
  if (!confirmations.isWaiting) return false;
  const answer = ConfirmationBroker.readAnswer(text);
  if (answer !== null) {
    console.log(`[jarvis] typed confirmation: ${answer ? "yes" : "no"}`);
    confirmations.settle(null, answer);
    return true;
  }
  // Neither yes nor no. Re-ask rather than guessing at something irreversible,
  // and say so in writing — the person is typing, so they may not have sound on.
  const said = "I still need a yes or no on the question above before I can go ahead.";
  console.log(`[jarvis] ambiguous typed confirmation: ${JSON.stringify(text.slice(0, 60))}`);
  send("message", { kind: "assistant", text: said });
  if (cfg.voice.ttsEnabled) tts.say(said);
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

/**
 * Answer a memory inspection or deletion command locally, before any model.
 *
 * "What do you remember?" and "forget that" must not depend on which brain is
 * running or on a model choosing to call a tool. A deletion in particular is
 * irreversible, so it is answered by code with an exact scope and a receipt,
 * identically on Claude, Gemini and the local 3B model. Returns true when it
 * took the command.
 */
async function maybeMemoryCommand(command: string): Promise<boolean> {
  if (!isMemoryCommand(command)) return false;
  let said: string;
  try {
    await refreshScope();
    said = executeMemoryCommand(command, { scope: currentScope(), appRoot: app.getAppPath() })
      ?? "I did not understand that memory command.";
  } catch (err: any) {
    said = `That memory command failed: ${err?.message ?? err}`;
    console.error("[jarvis] memory command failed:", err);
  }
  send("message", { kind: "assistant", text: said });
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

async function maybeSwitchBrain(command: string): Promise<boolean> {
  const target = parseBrainSwitch(command);
  if (!target) return false;

  const current = (brain?.provider ?? cfg.brain) as Provider;
  if (current !== target) {
    send("notice", { level: "info", text: `Switching to ${PROVIDER_LABELS[target] ?? target}…` });
  }
  const said = await switchBrain(target);
  send("message", { kind: "assistant", text: said });
  send("notice", {
    level: "info",
    text: current === target ? said : `${said} Your conversation and saved task history carry over.`,
  });
  tts.say(said);
  remoteRecord(`Jarvis: ${said}`, "jarvis");
  void telegram?.reply(said).catch(() => {});
  return true;
}

async function wireVoice() {
  if (shuttingDown) return;
  listener = new VoiceListener(cfg, player?.frameSource ?? undefined);

  // Speech detector: Silero when its model is present, the RMS level otherwise.
  const vadPath = cfg.voice.vadModel ? (isAbsolute(cfg.voice.vadModel) ? cfg.voice.vadModel : join(app.getAppPath(), cfg.voice.vadModel)) : "";
  const vad = vadPath ? await SileroVad.load(vadPath) : null;
  if (vad) listener.setVad(vad);
  console.log(`[voice] speech detector: ${vad ? "silero VAD" : "RMS level (models/silero_vad.onnx not loaded)"}`);

  // Wake word: a detector on the raw audio when one can be built, the
  // transcript matcher otherwise (and alongside, if wakeTranscriptFallback).
  try {
    const wake = await createWakeDetector(cfg, app.getAppPath());
    if (wake) listener.setWakeDetector(wake);
    console.log(`[voice] wake word: ${wake ? wake.name : "transcript match (no acoustic detector available)"}`);
  } catch (err: any) {
    console.error(`[voice] wake detector unavailable: ${err?.message ?? err}`);
  }

  listener.on("ready", (wakeEnabled: boolean, engine: string) => {
    console.log(
      wakeEnabled
        ? `[echo] voice ready — wake word "Echo" is ACTIVE (${engine})`
        : "[echo] voice ready — wake word OFF. Click the reactor core or press ⌘⇧J to talk."
    );
    send("state", { wakeEnabled, provider: brain.provider ?? cfg.brain });
    send("notice", {
      level: "info",
      text: wakeEnabled
        ? 'Listening. Say "Echo" to wake me.'
        : "Push-to-talk ready. Click the reactor core or press ⌘⇧J to talk.",
    });
  });
  listener.on("discarded", (reason: string, meta?: { turnId?: string; wake?: WakeKind; captureStartAt?: number; overlap?: boolean }) => {
    console.log(`[echo] audio discarded: ${reason}`);
    if (meta?.overlap) {
      // A recording started over a reply that came to nothing. Saying "I
      // couldn't hear you" here would be Echo interrupting ITSELF to complain
      // about a noise the user never made.
      return;
    }
    if (meta?.captureStartAt !== undefined) {
      sttStreams.get(meta.captureStartAt)?.stream.abort();
      sttStreams.delete(meta.captureStartAt);
    }
    if (meta?.turnId) voiceLog.event("capture.discarded", { turnId: meta.turnId, reason });
    if (/^no speech/.test(reason) && meta?.turnId) {
      // The name with nothing after it. Ask once, then let it go.
      if (awaitingCommand?.turnId === meta.turnId && !awaitingCommand.asked) {
        send("notice", { level: "info", text: "Yes?" });
        tts.say("Yes?"); // speech end → maybeAutoListen re-arms once more
        return;
      }
      awaitingCommand = null;
      setStatus(idleStatus());
      return;
    }
    // Only worth telling the user when they explicitly asked to be heard;
    // in always-on mode this fires constantly on room noise.
    if (/peak level/.test(reason) && meta?.wake && meta.wake !== "transcript") {
      send("notice", { level: "warn", text: `I couldn't hear you — ${reason}` });
      setStatus(idleStatus());
    }
  });
  // A microphone that has gone deaf is the one failure the user cannot see:
  // the HUD still says "listening" and nothing is being heard. Say it.
  listener.on("deaf", (was: string, now: string | null) => {
    if (now) {
      console.log(`[echo] "${was}" went silent — switched to "${now}"`);
      send("notice", { level: "warn", text: `${was} went silent. Listening on ${now} now.` });
    } else {
      console.warn(`[echo] every input is silent — last tried "${was}"`);
      send("notice", {
        level: "error",
        text: "I can't hear anything from any microphone. Check the input device in System Settings.",
      });
    }
  });

  listener.on("device", (name: string) => {
    console.log(`[echo] microphone: ${name}`);
    // A headset that's connected but not being worn is a common false alarm.
    if (/airpod|headphone|headset|buds/i.test(name)) {
      send("notice", {
        level: "warn",
        text: `Listening through ${name}. If it isn't in your ear, switch input in Sound settings.`,
      });
    }
  });
  listener.on("bargein", (level: number, bar: number) => onBargeIn(level, bar));
  listener.on("interjection", (wav: string, meta: CaptureMeta) => void onInterjection(wav, meta));
  listener.on("wakeCandidate", () => send("state", { wakeCandidate: true }));
  listener.on("wake", (det: { engine: string; score: number; at: number }) => {
    resetIdleTimer();
    const turn = voiceSession.beginTurn("acoustic", det.at);
    listener?.setCaptureTurn(turn.id);
    voiceLog.event("wake.detected", { turnId: turn.id, engine: det.engine, score: Number(det.score.toFixed(3)) });
    console.log(`[echo] wake word "Echo" detected (${det.engine})`);
    setStatus("listening");
    send("state", { wake: true });
    acknowledgeWake(turn.id);
  });
  listener.on("listening", (meta: CaptureMeta) => {
    setStatus("listening");
    startSttStream(meta);
  });
  listener.setFrameTap((frame, _at, capture) => {
    if (!capture || capture.needsWakeWord) return;
    sttStreams.get(capture.captureStartAt)?.stream.push(frame);
  });
  // Confirmed speech in an always-on capture: let the reactor react to the
  // person talking, which it never did before the transcript came back.
  listener.on("speech", () => {
    if (!tts.isSpeaking()) setStatus("listening");
  });
  listener.on("level", (n: number) => send("level", n));
  listener.on("utterance", (wav: string, needsWakeWord: boolean, meta: any) =>
    void voiceSession
      .enqueue("utterance", () =>
        handleUtterance(wav, needsWakeWord, {
          turnId: meta?.turnId,
          wake: meta?.wake,
          captureStartAt: meta?.captureStartAt,
          speechStartAt: meta?.speechStartAt,
          speechEndAt: meta?.speechEndAt,
        })
      )
      .finally(() => scheduleCaptureCleanup(wav))
  );
  void sweepOldCaptures().then((n) => n && console.log(`[voice] removed ${n} old voice captures from the temp folder`));
  listener.on("unavailable", (reason: string) =>
    send("notice", { level: "warn", text: reason })
  );
  listener.on("error", (msg: string) => send("notice", { level: "warn", text: msg }));

  voiceSession.on("window", (open: boolean) => {
    listener?.setSessionOpen(open);
    send("state", { session: open });
    if (!open && !echoIsSpeaking()) setStatus(lastBrainStatus);
  });

  warmUpStt(cfg); // load the STT model now, not on the first command
  await listener.start();
}

/**
 * Someone is talking over Echo.
 *
 * The old answer was to cut the voice off the instant anything cleared the
 * barge-in bar. That threw away the rest of an answer nobody had heard yet,
 * and it fired on a door, a laugh, a chair — because "louder than Echo" is not
 * the same as "addressed to Echo", and nothing had looked at the words yet.
 *
 * So by default Echo keeps talking and starts recording instead. The reply
 * runs to the end of its script while what was said over it is transcribed in
 * parallel, and that becomes the next turn — or, if it turns out to have been
 * nothing, nobody ever knows it happened. Asking for silence still gets
 * silence: `onInterjection` cuts the voice the moment the words come back and
 * say so. See `voice/interjection.ts`.
 */
function onBargeIn(level: number, bar: number) {
  if ((cfg.voice.bargeInMode ?? "finish") === "finish" && listener) {
    console.log(`[echo] someone spoke over the reply (level ${level} over ${bar}) — listening without stopping`);
    voiceLog.event("barge_in.deferred", { turnId: voiceSession.current?.id, level, bar });
    listener.captureInterjection(voiceSession.current?.id);
    return;
  }
  console.log(`[echo] barge-in (level ${level} over ${bar}) — stopping speech`);
  const heard = speech?.spokenSoFar() ?? "";
  voiceSession.cancel("bargein", `level ${level} over ${bar}`);
  tts.stop();
  brain.noteInterrupted?.(heard);
  voiceLog.event("audio.stopped", { turnId: voiceSession.current?.id, level, bar });
  expectAnswer = false;
  awaitingCommand = null;
  const turn = voiceSession.beginTurn("bargein");
  listener?.triggerListen({ turnId: turn.id, wake: "bargein", noSpeechMs: 2500 });
}

/**
 * Work out what was said over the reply, while the reply keeps playing.
 *
 * The recording holds two voices and this is where they are separated: Echo
 * knows its own script, so its words are subtracted and whatever is left is
 * the person. Nothing left means nothing was said.
 */
async function onInterjection(wavPath: string, meta: CaptureMeta) {
  let heard = "";
  try {
    // Always the local model, whatever the configured provider. Most of these
    // turn out to be a chair scraping, and a recording of Echo's own voice
    // should not be paid for or leave the machine to find that out.
    heard = await transcribeLocal(wavPath, cfg);
  } catch (err: any) {
    console.error(`[echo] could not transcribe what I heard over the reply: ${err?.message ?? err}`);
    scheduleCaptureCleanup(wavPath);
    return;
  }
  const mine = echoesOfMyself();
  const said = stripEchoWords(heard, mine).trim();
  // Two passes, because they answer different questions. `stripEchoWords`
  // removes words Echo verbatim said; `isEchoItself` asks whether the capture
  // was ever the user's at all. Whisper does not transcribe Echo verbatim, so
  // fragments survive the first and only the second catches them.
  const verdict = isHallucination(said) || isEchoItself(heard, mine)
    ? "noise"
    : classifyInterjection(said);
  console.log(`[echo] over the reply: ${JSON.stringify(heard)} -> ${JSON.stringify(said)} (${verdict})`);
  voiceLog.event("interjection", {
    turnId: meta.turnId,
    verdict,
    heard: heard.slice(0, 60),
    said: said.slice(0, 60),
  });

  if (verdict === "noise") {
    // A door, a laugh, or Echo's own voice arriving back. The reply was never
    // in danger — not cutting it here is the entire point of this path.
    scheduleCaptureCleanup(wavPath);
    return;
  }
  if (verdict === "stop") {
    stopEverything(`asked to stop mid-reply: ${said.slice(0, 40)}`);
    scheduleCaptureCleanup(wavPath);
    return;
  }
  // A real instruction. Hold it until the reply has finished its script, then
  // it goes through the ordinary command path like anything else.
  if (pendingInterjection) scheduleCaptureCleanup(pendingInterjection.wavPath);
  pendingInterjection = { wavPath, meta, transcript: said };
  // The reply may have ended while this was being transcribed, in which case
  // nothing is going to call maybeAutoListen() again on our behalf.
  if (!echoIsSpeaking()) drainPendingInterjection();
}

/**
 * The reply has finished. Answer what was said over it.
 *
 * Returns true when it has taken the turn, so the caller does not also open
 * the microphone for a different one.
 */
function drainPendingInterjection(): boolean {
  const held = pendingInterjection;
  if (!held) return false;
  pendingInterjection = null;
  console.log(`[echo] finished speaking — now answering what I heard over it: ${JSON.stringify(held.transcript)}`);
  const turn = voiceSession.beginTurn("bargein");
  void voiceSession
    .enqueue("interjection", () =>
      handleUtterance(held.wavPath, false, {
        turnId: turn.id,
        wake: "bargein",
        captureStartAt: held.meta.captureStartAt,
        speechStartAt: held.meta.speechStartAt,
        speechEndAt: held.meta.speechEndAt,
        transcript: held.transcript,
        overlap: true,
      })
    )
    .finally(() => scheduleCaptureCleanup(held.wavPath));
  return true;
}

/** Say anything that was held back, once the moment is right. */
function drainHeldSpeech() {
  if (shuttingDown) return;
  for (const text of attention.release()) tts.say(text);
}

async function wireTts() {
  console.log("[echo] starting TTS with engine:", cfg.voice.ttsEngine);
  // The persistent player (and, with the voiceio helper, the echo-cancelled
  // microphone). Created before the listener so the listener can take its frames.
  try {
    player = await createPlayer(cfg, app.getAppPath());
    if (shuttingDown) {await player.dispose(); return;}
    console.log(`[voice] player: ${player.name}${player.aec ? " + echo-cancelled capture" : ""}`);
    player.on("error", (m: string) => console.error(`[voice] player: ${m}`));
    player.on("started", () => voiceLog.event("audio.start", { turnId: voiceSession.brainTurnId ?? voiceSession.current?.id }));
    player.on("exit", () => console.error("[voice] player process exited"));
  } catch (err: any) {
    console.error(`[voice] player unavailable: ${err?.message ?? err}`);
  }
  if (shuttingDown) return;
  tts = new Tts(cfg.voice.ttsVoice, cfg.voice.ttsEnabled, cfg.voice.ttsEngine, cfg.voice.elevenLabsVoiceId, (speaking) => {
    if(!speaking)echoSpokeUntil=performance.now();
    // The mic keeps hearing while Echo speaks (for barge-in); only capture pauses.
    listener?.setPaused(speaking);
    voiceSession.noteSpeaking(speaking);
    setStatus(speaking ? "speaking" : lastBrainStatus);
    // Echo just finished — open the mic for an answer, or the conversation window.
    if (!speaking) maybeAutoListen();
  }, { speaker: cfg.voice.sarvamSpeaker, pace: cfg.voice.sarvamPace }, cfg.voice.piperVoice);
  // Every other thing Echo says — a confirmation question, "Cancelled.", a
  // task report — goes through tts.say, so this is the one place it is routed:
  // during a phone or Telegram turn it goes to that device instead.
  const sayHere = tts.say.bind(tts);
  tts.say = (text: string) => {
    const channel = replyChannel();
    if (channel === "local") return sayHere(text);
    deliverRemote(channel, text);
  };
  tts.onAudioStart((text) => {
    // Both speech paths reach here as each sentence starts playing, which is
    // exactly the text that can leak into the microphone from now on.
    noteSpoken(text);
    voiceLog.event("tts.first_audio", { turnId: voiceSession.brainTurnId ?? voiceSession.current?.id, sentence: text.slice(0, 40) });
  });
  if (player && cfg.voice.ttsStreaming !== false && STREAMING_ENGINES.has(cfg.voice.ttsEngine ?? "mac")) {
    speech = new SpeechStream(cfg, player, { maxSentences: () => cfg.voice.maxSpokenSentences ?? 6 });
    speech.on("sentence", (text: string, i: number) => voiceLog.event("llm.text", { turnId: voiceSession.brainTurnId ?? undefined, sentence: text.slice(0, 50), chars: i }));
    speech.on("capped", () => console.log("[voice] spoken reply capped — the rest stays on screen"));
    // SpeechStream has always emitted this; nothing consumed it. Without it the
    // streamed path had no speech-start/-finished signal at all, so the mic was
    // never paused for capture, the session never learned Echo was talking, and
    // the HUD and control panel never left the previous state. Mirrors the Tts
    // callback above so both paths behave identically.
    speech.on("speaking", (on: boolean) => {
      if(!on)echoSpokeUntil=performance.now();
      listener?.setPaused(on);
      voiceSession.noteSpeaking(on);
      setStatus(on ? "speaking" : lastBrainStatus);
      if (!on) maybeAutoListen();
    });
    tts.attachStream(speech);
    console.log("[voice] streaming speech: on");
  } else {
    console.log("[voice] streaming speech: off (file path)");
  }
  // Share this one voice with background features (companion mode, watchers) so
  // they speak through the real pipeline instead of shelling out to `say`.
  setActiveTts(tts);
}

/** Route typed text from either the HUD bridge or the control panel identically. */
function handleTypedInput(value: unknown): void {
  if (shuttingDown) return;
  const revision = inputRevision;
  if (brainLifecycle?.isSwitching) {
    void brainLifecycle.ready().then(ready => {
      if (ready && !shuttingDown && revision === inputRevision) handleTypedInput(value);
    }).catch(error => console.error('[brain] pending typed command failed:', error));
    return;
  }
  const clean = String(value ?? "").trim();
  if (!clean) return;
  send("message", { kind: "user", text: clean });
  if (maybeAnswerConfirmation(clean)) return;
  void maybeMemoryCommand(clean).then(async (handled) => {
    if (handled || shuttingDown || revision !== inputRevision) return;
    if (maybeQuickReply(clean)) return;
    if (await maybeSwitchBrain(clean)) return;
    if (shuttingDown || revision !== inputRevision) return;
    await refreshScope();
    if (shuttingDown || revision !== inputRevision) return;
    beginLearnedTurn(clean);
    dispatchToBrain(clean, undefined, voiceSession.beginTurn("typed"), "text");
  }).catch(error => {
    if (!shuttingDown && revision === inputRevision) send("notice", {level: "error", text: `Command failed: ${String(error)}`});
  });
}

function controlRuntime(): ControlRuntime {
  const provider = ((brain?.provider ?? cfg.brain) as Provider);
  const configured = loadMcpConfig();
  return {
    voiceEnabled: cfg.voice.ttsEnabled,
    agents: [...swarm.list(),...supervisor.listAgents()],
    missions: [...swarm.listMissions(),...supervisor.panelMissions()].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,20),
    settings: controlSettings(),
    models: PROVIDERS.map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
      model: id === "claude" ? cfg.claude.model
        : id === "gemini" ? cfg.gemini.model
        : id === "openai" ? openAIModelLabel()
        : id === "openrouter" ? cfg.openrouter.model
        : id === 'nvidia' ? cfg.nvidia.model
        : cfg.ollama.model,
      active: id === provider,
      available: !brainUnavailable(id),
      ...(brainUnavailable(id) ? { reason: brainUnavailable(id)! } : {}),
      // How the OpenAI brain pays, and the ChatGPT account it would use.
      ...(id === "openai" ? { account: openAIAccount() } : {}),
      // The models OpenRouter can be switched to, read live. Cached in the
      // models module, so building a panel update costs nothing.
      ...(id === "openrouter" ? { catalogue: openRouterCatalogue() } : {}),
    })),
    connections: Object.keys(configured).map((name) => {
      const lastActivityAt = controlTelemetry.connectionActivity(name);
      return { name, status: lastActivityAt ? "active" : "configured", tools: null, ...(lastActivityAt ? { lastActivityAt } : {}) };
    }),
  };
}

function makeFleetBrain() {
  return fleetBrainFactory(cfg);
}

async function handleControlAction(action: ControlAction): Promise<{ ok: boolean; message?: string; data?: Record<string, unknown> }> {
  if (shuttingDown) return {ok: false, message: "Echo is shutting down."};
  switch (action.type) {
    case "command": {
      const command = String(action.text ?? "").trim();
      if (!command) return { ok: false, message: "Enter a command first." };
      handleTypedInput(command);
      return { ok: true };
    }
    case "listen":
      resetIdleTimer(); listener?.triggerListen(); return { ok: true, message: "Listening." };
    case "interrupt":
      stopEverything("user interrupted from control panel"); return { ok: true, message: "Current run stopped." };
    case "toggle-voice":
      cfg.voice.ttsEnabled = !cfg.voice.ttsEnabled;
      tts.setEnabled(cfg.voice.ttsEnabled);
      return { ok: true, message: `Spoken responses ${cfg.voice.ttsEnabled ? "enabled" : "muted"}.` };
    case "settings":
      return { ok: true, message: "Settings are open in the control panel." };
    case "api-keys":
      openSetupWindow(); return { ok: true, message: "API key setup opened." };
    case "openrouter-sign-in": {
      // The browser flow, which OpenRouter provides for exactly this. What
      // comes back is an ordinary API key the user owns and can revoke, so it
      // is stored like any other key rather than in a second credential store.
      try {
        const { signInToOpenRouter } = await import("./brain/openrouter-auth.js");
        const { shell } = await import("electron");
        const { key } = await signInToOpenRouter({ openUrl: (url) => void shell.openExternal(url) });
        const env = cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY";
        saveKeys({ [env]: key }); // merges; writeKeys would replace the whole file
        process.env[env] = key; // usable now, not after a restart
        const updated = await refreshCredentialBrain("openrouter");
        void refreshOpenRouterCatalogue(true);
        publishControlUpdate();
        return { ok: true, message: `Signed in to OpenRouter. ${updated}`.trim() };
      } catch (err: any) {
        return { ok: false, message: `OpenRouter sign-in failed: ${err?.message ?? err}` };
      }
    }

    case "openrouter-sign-out": {
      // Forget it here. The key itself keeps working until it is revoked on
      // openrouter.ai, and saying so is more honest than implying otherwise.
      const env = cfg.openrouter?.apiKeyEnv ?? "OPENROUTER_API_KEY";
      // `writeKeys` rewrites the file from what it is given, so it has to be
      // handed every OTHER key as well — passing just this one would delete
      // the lot. `saveKeys` cannot be used here because it skips blanks by
      // design, which is exactly how you would fail to clear something.
      writeKeys({ ...readKeys(), [env]: "" });
      delete process.env[env];
      const updated = await refreshCredentialBrain("openrouter");
      publishControlUpdate();
      return { ok: true, message: `Forgot the OpenRouter key. ${updated} Revoke it at openrouter.ai/keys to disable it for good.` };
    }

    case "openrouter-set-model": {
      const want = String(action.name ?? action.text ?? "").trim();
      if (!want) return { ok: false, message: "No model given." };
      // Only from the live list: it is the one that knows what still exists
      // and what can call tools, and a model that cannot do the latter makes
      // an Echo that can talk but not act.
      if (openRouterModels.length && !openRouterModels.some((m) => m.id === want)) {
        return { ok: false, message: `${want} isn't in the list of tool-capable models.` };
      }
      const data = readMutableConfigBase();
      data.openrouter = {...(data.openrouter ?? {}), model: want};
      writeMutableConfig(data);
      cfg.openrouter.model = want;
      const onOpenRouter = (brain?.provider ?? cfg.brain) === "openrouter";
      if (onOpenRouter && brainLifecycle) {
        const restarted = await brainLifecycle.switch("openrouter", true);
        if (!restarted.ok) return {ok: false, message: `Model preference saved; ${restarted.message}`};
      }
      publishControlUpdate();
      return { ok: true, message: `OpenRouter model set to ${want}${onOpenRouter ? "" : " (switch to OpenRouter to use it)"}.` };
    }

    case "chatgpt-sign-in": {
      // Returns once the browser round trip finishes (or is cancelled).
      try {
        const session = await chatgpt.signIn();
        publishControlUpdate();
        if (!session.planUsage) {
          return { ok: false, message: session.error ?? "Signed in, but ChatGPT plan use wasn't allowed." };
        }
        const updated = await refreshCredentialBrain("openai");
        return {
          ok: true,
          message: `Signed in${session.email ? ` as ${session.email}` : ""}. ${updated || "Switch to the ChatGPT brain to use your plan."}`,
        };
      } catch (err: any) {
        publishControlUpdate();
        return { ok: false, message: String(err?.message ?? err) };
      }
    }
    case "chatgpt-cancel-sign-in":
      chatgpt.cancelSignIn(); return { ok: true, message: "Sign-in cancelled." };
    case "chatgpt-sign-out": {
      const { revoked } = await chatgpt.signOut();
      const updated = await refreshCredentialBrain("openai");
      publishControlUpdate();
      return {
        ok: true,
        message: (revoked
          ? "Signed out of ChatGPT. Echo can no longer use your plan."
          : "Signed out of ChatGPT on this Mac. To be sure Echo's access is gone, disconnect it in ChatGPT → Settings → Connected apps.") + ` ${updated}`,
      };
    }
    case "save-api-keys": {
      const { count, changed } = saveKeys(action.apiKeys ?? {});
      if (!changed.length) return { ok: true, message: "No changes — every field was left blank." };
      const updated = await refreshChangedKeys(changed);
      return {
        ok: true,
        message: `Saved ${changed.length} key${changed.length === 1 ? "" : "s"} (${count} total configured). ` +
          (updated || "New connections use the saved keys."),
      };
    }
    case "save-settings":
      return { ok: true, message: await saveControlSettings(action.settings) };
    case "shutdown": {
      // Let the invoke response reach the renderer so it can show a clear
      // shutting-down state, then enter the single graceful quit path below.
      const timer = setTimeout(() => requestAppShutdown("control panel"), 120);
      timer.unref();
      return { ok: true, message: "Closing MCP connections and shutting down Echo…" };
    }
    case "neural":
      openNeuralCore(); return { ok: true };
    case "osiris":
      await openOsirisPanel(); return { ok: true };
    case "refresh-connections":
      return { ok: true, message: "Connection configuration refreshed." };
    case "switch-model": {
      const target = action.provider;
      if (!isProvider(target)) return { ok: false, message: "Unknown model route." };
      const before = (brain?.provider ?? cfg.brain) as Provider;
      const message = await switchBrain(target);
      const after = (brain?.provider ?? cfg.brain) as Provider;
      return { ok: after === target, message: before === target ? `Already routed to ${PROVIDER_LABELS[target]}.` : message };
    }
    case "spawn-agent": {
      const goal = String(action.goal ?? "").trim();
      if (!goal) return { ok: false, message: "Describe the task to assign." };
      const result = swarm.spawn(goal, { makeBrain: makeFleetBrain() });
      return result.ok ? { ok: true, message: `${result.name} deployed.` } : { ok: false, message: result.reason ?? "Agent could not be deployed." };
    }
    case "assign-agent": {
      const name = String(action.name ?? "").trim();
      const goal = String(action.goal ?? "").trim();
      if (!name || !goal) return { ok: false, message: "Choose an agent and enter a task." };
      return (swarm.send(name, goal) || supervisor.send(name,goal)) ? { ok: true, message: `Task assigned to ${name}.` } : { ok: false, message: `${name} is not active.` };
    }
    case "run-board": {
      const goal = String(action.goal ?? "").trim();
      const agentIds = [...new Set((action.agentIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
      if (!goal) return { ok: false, message: "Describe the task for the board." };
      if (!agentIds.length) return { ok: false, message: "Select at least one agent for the board." };
      const unknown = agentIds.filter((id) => !getFleetMember(id));
      if (unknown.length) return { ok: false, message: `Unknown agent(s): ${unknown.join(", ")}.` };
      const submitted = swarm.submitMission(
        { id: `board-${Date.now()}`, goal, tasks: agentIds.map((id) => ({ id, goal, profile: id, lane: "knowledge" as const })) },
        { makeBrain: makeFleetBrain() }
      );
      return submitted.ok
        ? { ok: true, message: `Board dispatched to ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}.`, data: { missionId: submitted.missionId } }
        : { ok: false, message: submitted.reason ?? "The board could not be dispatched." };
    }
    case "run-fleet-agent": {
      const agentId = String(action.name ?? "").trim();
      const goal = String(action.goal ?? "").trim();
      const member = getFleetMember(agentId);
      if (!member) return { ok: false, message: "Unknown agent." };
      if (!goal) return { ok: false, message: `Describe the task for ${member.name}.` };
      const submitted = swarm.submitMission(
        { id: `solo-${agentId}-${Date.now()}`, goal, tasks: [{ id: agentId, goal, profile: agentId, lane: "knowledge" }] },
        { makeBrain: makeFleetBrain() }
      );
      return submitted.ok
        ? { ok: true, message: `Sent to ${member.name}.`, data: { missionId: submitted.missionId } }
        : { ok: false, message: submitted.reason ?? `${member.name} could not be dispatched.` };
    }
    case "stop-mission":
      if(String(action.missionId ?? '').startsWith('supervised.') && supervisor.inspect(String(action.missionId))) {await supervisor.cancel(String(action.missionId));return {ok:true,message:'Supervised task stopped.'};}
      return swarm.cancelMission(String(action.missionId ?? "").trim())
        ? { ok: true, message: "Mission stopped." }
        : { ok: false, message: "That mission is not running." };
    case "stop-mission-task":
      if(String(action.missionId ?? '').startsWith('supervised.') && supervisor.inspect(String(action.missionId))) {await supervisor.cancel(String(action.missionId));return {ok:true,message:'Supervised worker and inspector stopped together.'};}
      return swarm.cancelMissionTask(String(action.missionId ?? "").trim(), String(action.name ?? "").trim())
        ? { ok: true, message: "Stopped." }
        : { ok: false, message: "That agent is not running." };
    case "delete-mission": {
      if(String(action.missionId ?? '').startsWith('supervised.')) {
        const id=String(action.missionId);const ok=await supervisor.forget(id);const {removeTaskReport}=await import('./tasks/report-window.js');removeTaskReport(id);
        return {ok,message:ok?'Supervised task record deleted; output files are preserved.':'Task not found.'};
      }
      // Deleting a running mission stops it first — see swarm.forgetMission.
      const removed = swarm.forgetMission(String(action.missionId ?? "").trim());
      if (!removed.ok) return { ok: false, message: "That mission no longer exists." };
      return { ok: true, message: removed.cancelled ? "Mission stopped and deleted." : "Mission deleted." };
    }
    case "save-agent": {
      try {
        const saved = addFleetMember((action.agent ?? {}) as NewAgent);
        return { ok: true, message: `Saved "${saved.name}".` };
      } catch (err: any) {
        return { ok: false, message: String(err?.message ?? err) };
      }
    }
    case "remove-agent": {
      try {
        removeFleetMember(String(action.name ?? "").trim());
        return { ok: true, message: "Removed." };
      } catch (err: any) {
        return { ok: false, message: String(err?.message ?? err) };
      }
    }
    default:
      return { ok: false, message: "Unsupported control action." };
  }
}

function wireIpc() {
  ipcMain.on("renderer:error", (_e, payload) => recordRendererError(payload ?? { kind: "unknown", message: "empty report" }));
  ipcMain.on("listen", () => { resetIdleTimer(); listener?.triggerListen(); });
  ipcMain.on("user-typing", () => { resetIdleTimer(); attention.noteTyping(); });
  ipcMain.on("open-control-panel", () => openControlPanel(win));
  // The overlay is click-through except when the pointer is over its one
  // interactive control (the QR's close button), which asks for clicks here.
  ipcMain.on("overlay:set-interactive", (_e, on: boolean) => setOverlayInteractive(Boolean(on)));
  ipcMain.on("orbital:close", () => closeOrbitalPanel());
  // The Osiris grid stays up until it is told otherwise; these three are the
  // only things in the app that move it, and all three are a deliberate act.
  ipcMain.on("osiris:close", () => closeOsirisPanel());
  ipcMain.on("osiris:reload", () => void reloadOsiris());
  ipcMain.on("osiris:toggle-pin", () => { if (isOsirisOpen()) setOsirisPinned(!isOsirisPinned()); });
  ipcMain.on("neural:close", () => closeNeuralCore());
  ipcMain.on("send-text", (_e, text: string) => handleTypedInput(text));
  ipcMain.on("interrupt", () => stopEverything("user interrupted"));
}

function wireShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+J", () => listener?.triggerListen());
  globalShortcut.register("CommandOrControl+Shift+.", () => stopEverything("user interrupted (hotkey)"));
}

// Only ever one Jarvis. A second instance would spawn a rival brain and fight
// the first one for the microphone, while leaving two reactors on screen.
//
// That is exactly what happened, for a long time, because `app.quit()` is
// ASYNCHRONOUS and this is top-level module code with nowhere to return to:
// execution carried straight on past it, `whenReady` fired, and the second
// instance booted in full — microphone, speech, brain, HUD. Worse, the
// `before-quit` handler below calls `event.preventDefault()` to run an async
// teardown, so the quit this line asked for was then actively delayed. The
// result was two Echos answering the same room, replying to each other, each
// one paying for its own model calls.
//
// `app.exit()` is the immediate form: it does not emit before-quit or
// will-quit, so nothing can hold it open. The flag is belt and braces — if the
// process somehow survives long enough to reach `whenReady`, that handler
// returns instead of starting a second assistant.
const isPrimaryInstance = app.requestSingleInstanceLock();
const secondaryInstanceMessage = process.argv.includes('--echo-shutdown') ? '[jarvis] shutdown request sent to the running Echo' : '[jarvis] already running — focusing the existing window';
if (!isPrimaryInstance) {
  console.log(secondaryInstanceMessage);
  app.exit(0);
}
if (process.argv.includes('--echo-shutdown')) {
  console.log('[jarvis] Echo is already stopped');
  app.exit(0);
}

app.on("second-instance", (_event, argv) => {
  if (argv.includes('--echo-shutdown')) {
    void requestAppShutdown('terminal stop command');
    return;
  }
  if (!win) return;
  win.show();
  win.focus();
});

// Event-loop lag monitor: for "the control panel got slow" reports that a
// code-reading pass can't reproduce (checked and ruled out: render() cost,
// duplicate IPC listeners, stale timers — all fine under synthetic load).
// This measures the one thing a renderer-side investigation cannot see: the
// MAIN process's own JS thread falling behind schedule, which is exactly
// what makes every window's IPC-backed button feel slow at once, since they
// all share this one event loop. Logged with what was actually running at
// the time, so the next occurrence is evidence instead of a guess.
let lastLagCheckAt = Date.now();
const mainTimers = new RuntimeTimers();
mainTimers.every(1000, () => {
  const now = Date.now();
  const drift = now - lastLagCheckAt - 1000;
  lastLagCheckAt = now;
  if (drift > 150) {
    const activeMissions = swarm.list().filter((a) => a.status === "working").length;
    console.warn(
      `[perf] main process stalled ~${drift}ms (provider=${cfg?.brain ?? "starting"}, osiris=${isOsirisOpen()}, agents working=${activeMissions})`
    );
  }
});

app.whenReady().then(async () => {
  // A losing second instance must never reach any of this. See the lock above.
  if (!isPrimaryInstance || shuttingDown) return;
  // Development runs use Electron's generic icon unless the Dock is updated
  // explicitly. assets/echo.icns is ready for a future packaged build; other
  // desktop platforms pick up the BrowserWindow icon above.
  if (process.platform === "darwin" && existsSync(ECHO_ICON_PATH)) {
    app.dock.setIcon(ECHO_ICON_PATH);
  }
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
    (details, callback) => {
      details.requestHeaders['Origin'] = 'https://www.youtube.com';
      details.requestHeaders['Referer'] = 'https://www.youtube.com/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  // Secrets first: the brain and the wake word both read from process.env, and
  // the agent subprocess inherits it.
  // A previous run may have died without releasing the camera; clear any
  // orphan before doing anything else, so the light is never on unexplained.
  await releaseCamera("clearing orphans from a previous run").catch(() => {});
  if (shuttingDown) return;

  // Keys saved by the Setup window live in the user's own directory, because an
  // installed .app is read-only. Applied before anything reads the environment.
  const stored = applyKeys();
  if (stored.length) console.log(`[jarvis] loaded saved keys (${stored.join(", ")})`);

  wireSetupIpc(changed => {
    void refreshChangedKeys(changed)
      .then(message => {if (message) send("notice", {level: "info", text: message});})
      .catch(error => console.error('[brain] key refresh failed:', error));
  });

  const loaded = loadEnv(app.getAppPath());
  if (loaded.length) console.log(`[jarvis] .env loaded (${loaded.join(", ")})`);

  // Fill the OpenRouter picker in the background. Not awaited: the panel
  // reads whatever is there and the list arrives a moment later, rather than
  // every boot paying for a catalogue most sessions never open.
  void refreshOpenRouterCatalogue();
  cfg = loadConfig(app.getAppPath());
  chatgpt.configure({ redirectPort: cfg.openai?.chatgptRedirectPort, sendHostId: cfg.openai?.chatgptSendHostId === true });
  // The control panel shows "Connecting…" and the result as they happen.
  chatgpt.onChange(() => publishControlUpdate());
  setActiveConfig(cfg); // deep modules (gate.ts's critic, tool pruning, escalation, …) read the live config through this
  voiceLog.init(app.getAppPath());
  voiceSession = new VoiceSession({ windowMs: () => (cfg.voice?.conversationMode === false ? 0 : cfg.voice?.conversationWindowMs ?? 12000) });
  voiceSession.on("turnSummary", (summary) => console.log(`[voice] ${describeSummary(summary)}`));
  console.log(`[jarvis] config loaded (brain=${cfg.brain})`);
  {
    // Next to the brain line on purpose: the two together are what explain
    // which path a spoken turn will actually take.
    const why = realtimeUnavailableReason(cfg);
    if (why) console.warn(`[realtime] ${why}`);
  }

  // Teach-by-demonstration capture. Opt-in: it is the one part of Jarvis that
  // deliberately stores what was on screen, so it should never start unasked.
  configureLearning(cfg.learning ?? { enabled: false, captureScreens: true, maxStepsPerTurn: 0 });
  if (cfg.learning?.enabled) {
    void datasetStats()
      .then((s) => console.log(`[learn] recording trajectories — ${describeStats(s)}`))
      .catch(() => {});
  }
  createWindow();
  createOverlayWindow();

  // Decide now whether an Osiris checkout is running here, so the first "show me
  // the world" opens on the right instance without pausing to scan for one.
  void import("./tools/osiris-intel.js").then(({ warmOsiris }) => warmOsiris());

  // The Mac end of the phone-remote video link. Idle until a phone connects —
  // it captures nothing (and lights no recording indicator) until then.
  try {
    startCaptureBridge({ BrowserWindow, ipcMain, session, desktopCapturer });
  } catch (e) {
    console.error("[jarvis] remote capture bridge failed to start:", e);
  }

  // Always-on phone remote: start it silently at launch so the saved link keeps
  // working, and never let it auto-close. Fails closed — a password is required,
  // and nothing is exposed beyond the private tailnet. No QR is shown here; the
  // user already has the link, and popping it up every launch would be noise.
  if (cfg.remote?.alwaysOn) {
    if (!hasRemotePassword()) {
      console.log("[jarvis] remote.alwaysOn is set but no remote password — not starting. Set one first.");
    } else {
      void startRemote({
        ttlMs: 0, relay: relayFromConfig(cfg.remote.relayUrl),
      })
        .then((r) => {
          if (r.ok && r.url) {
            saveRemoteUrl(r.url);
            console.log(`[jarvis] phone remote is ALWAYS ON at ${r.url}`);
          } else {
            console.error(`[jarvis] could not auto-start the phone remote: ${r.message}`);
          }
        })
        .catch((e) => console.error("[jarvis] auto-start phone remote failed:", e));
    }
  }

  // First run with no keys at all: show Setup rather than failing later with an
  // authentication error the user has no way to interpret.
  // A ChatGPT sign-in is a way to run Echo too, not only a key.
  if (needsSetup() && !chatgpt.isReady()) {
    console.log("[jarvis] no API keys configured — opening Setup");
    openSetupWindow();
  }
  console.log("[jarvis] window created");

  const uiLoaded = new Promise<void>((resolve) => {
    if (win?.webContents) {
      win.webContents.once("did-finish-load", () => resolve());
    } else {
      resolve();
    }
  });

  // Tidy tombstoned records, then scope the session to whatever you are working
  // on so the brain starts with that project's history rather than cold.
  try {
    compact();
    const ctx = await currentContext();
    const s = stats();
    console.log(`[jarvis] memory: ${s.count} records, current project "${ctx.project}" (${ctx.app})`);
    (createBrainProjectHint as any).value = ctx.project;
  } catch (err) {
    console.error("[jarvis] memory init failed:", err);
  }

  // Bring the Memory OS up before the brain, because the brain reads from it on
  // its very first turn. Every step here is survivable: a memory layer that
  // cannot start must not stop Echo from answering, it must say so loudly and
  // leave the assistant working without it.
  try {
    ProviderMemoryContext.enabled = cfg.memory?.enabled !== false;
    ProviderMemoryContext.cloudRecall = cfg.memory?.cloudRecall !== false;
    if (ProviderMemoryContext.enabled) {
      if (cfg.memory?.importLegacy !== false) {
        // One-time, idempotent, and a COPY: the legacy files are left exactly
        // where they are, so this is reversible by turning the flag off.
        const { imported, skipped } = memoryService.importLegacy({ skillsFile: join(app.getAppPath(), "skills", "skills.json") });
        if (imported || skipped) console.log(`[jarvis] memory os: imported ${imported} legacy record(s), skipped ${skipped}`);
      }
      const days = Number(cfg.memory?.retentionDays ?? 0);
      if (days > 0) {
        // Retention is dated from when it was switched on, so turning it on
        // today never silently deletes an archive kept since last year.
        const marker = join(memoryRoot(), "retention-activated.json");
        if (!existsSync(marker)) atomicWrite(marker, JSON.stringify({ activatedAt: new Date().toISOString(), episodeDays: days }));
        const { activatedAt } = JSON.parse(readFileSync(marker, "utf8"));
        const expired = enforceRetention({ enabled: true, activatedAt, episodeDays: days });
        if (expired) console.log(`[jarvis] memory os: retention removed ${expired} expired record(s)`);
      }
      const total = memoryService.list(undefined, { includeInactive: true }).length;
      console.log(`[jarvis] memory os: ${total} record(s) at revision ${memoryService.revision()}, cloud recall ${ProviderMemoryContext.cloudRecall ? "on" : "off"}`);
    } else {
      console.log("[jarvis] memory os: disabled by config; the brain runs without recall");
    }
  } catch (err) {
    console.error("[jarvis] memory os unavailable — Echo will run WITHOUT memory this session:", err);
  }

  if (shuttingDown) return;
  const startupRecoveries = pendingRecoveries();
  // Run logs hold full prompts and tool results; age them out rather than
  // keep every run forever. After pendingRecoveries, and it skips anything
  // still resumable either way.
  void pruneOldRunLogs().then((n) => n && console.log(`[echo:log] removed ${n} old run log(s)`));
  const startupMainTasks = startupRecoveries.filter((task) => task.actor.kind === "main");
  const startupMainTask = startupMainTasks.at(-1);
  const recoveryProvider = startupMainTask?.provider;
  const startupCfg: JarvisConfig = isProvider(recoveryProvider) ? { ...cfg, brain: recoveryProvider } : cfg;
  const built = createBrain(startupCfg);
  let firstActivation = true;
  brainLifecycle = new BrainLifecycle(built, {
    create: provider => createBrain({...cfg, brain: provider}),
    unavailable: brainUnavailable,
    handlers: brainHandlers,
    beforeReplace: () => {
      inputRevision++;
      voiceSession.cancel("stop", "brain replaced");
      tts?.stop();
      if (realtime) {realtime.close(); realtime = null;}
      endAutoReflex(false);
      controlTelemetry.stopMainTasks();
    },
    activated: instance => {
      activateMainBrain(instance);
      if (!firstActivation) persistBrainChoice(instance.provider);
      firstActivation = false;
    },
    report: message => console.error('[brain]', message),
  });
  // The switch_brain tool runs inside whichever brain is being replaced, so it
  // reaches the swap the same way the tools reach the brain itself — through a
  // global, because importing main.ts from the registry would be a cycle.
  (global as any).__switchBrain = switchBrain;
  console.log(`[jarvis] brain ready (provider=${built.provider})`);
  telegram = startTelegram(cfg, handleTelegramCommand);

  // Anything that wants to change the reactor's appearance publishes through
  // hudstate; this is the one place that actually talks to the window.
  onHudState((patch) => {
    send("state", patch);
    sendToOverlay("state", patch);
  });

  // Away mode dims the reactor the moment you leave, and restores it when you
  // return — visible from across the room without reading anything.
  presenceMonitor.on("left", () => {
    console.log("[jarvis] you left the desk — dimming and pausing");
    // Remember when, so "what changed while I was away?" knows the window it
    // is being asked about without having to be told.
    noteLeft();
    setAway(true);
  });
  presenceMonitor.on("returned", () => {
    console.log("[jarvis] you're back — restoring");
    noteReturned();
    stopDreamingNow();
    // Research must stand down for the same reason rehearsal does: work you did
    // not ask for should never compete with work you did.
    stopResearchNow();
    setAway(false);
  });
  presenceMonitor.on("tooDark", () => {
    console.log("[jarvis] room too dark to judge presence — taking no action");
  });

  // Rehearsals are opt-in; without this the dreamer is inert.
  setDreamingEnabled(cfg.dreaming?.enabled === true);
  if (cfg.dreaming?.enabled) console.log("[jarvis] idle rehearsal is ON (look-only, when you're away)");

  await wireTts();
  if (shuttingDown) return;
  // Held speech is checked on a timer so nothing waits indefinitely.
  mainTimers.every(4000, drainHeldSpeech);
  wireConfirmations();
  wireIpc();
  wireControlPanel({ runtime: controlRuntime, action: handleControlAction });
  wireShortcuts();

  // Give the renderer a beat to attach listeners before we start emitting.
  uiLoaded.then(() => {
    if (shuttingDown) return;
    console.log("[jarvis] HUD loaded");
    // Include the saved skin, so the reactor the user last chose is the one
    // that appears — not a flash of the default before it corrects itself.
    send("state", { status: "idle", provider: built.provider, skin: cfg.hud?.skin ?? "classic" });
    if (process.env.JARVIS_NO_VOICE) {
      send("notice", { level: "info", text: "Voice disabled (JARVIS_NO_VOICE). Type commands below." });
    } else {
      void wireVoice().catch(error => {
        console.error('[voice] initialization failed:', error);
        if (!shuttingDown) send("notice", {level: "error", text: `Voice initialization failed: ${String(error)}`});
      });
    }

    // A process kill leaves the checkpoint in `running`. Restore the main Echo
    // and every named clone through fresh brains; each recovery prompt carries
    // completed and uncertain actions so mutable tools are verified, not
    // blindly repeated.
    if (startupMainTask && brain.recoverFromCheckpoint(startupMainTask)) {
      console.warn(`[echo:recovery] resuming Echo task ${startupMainTask.taskId} after process restart`);
      send("notice", { level: "info", text: "Echo found an interrupted task and is continuing from its checkpoint." });
    }
    for (const task of startupRecoveries.filter((item) => item.actor.kind === "clone")) {
      const recovered = swarm.recover(task, {
        makeBrain: (identity, missionTask) => {
          const provider = task.provider;
          const cloneCfg: JarvisConfig = isProvider(provider) ? { ...cfg, brain: provider } : cfg;
          return fleetBrainFactory(cloneCfg)(identity, missionTask);
        },
      });
      if (recovered) console.warn(`[echo:recovery] resumed ${task.actor.name} task ${task.taskId}`);
    }

    // Anything that did NOT come back above cannot still be running: its
    // wall-time timer died with the process that armed it. Close those out so
    // the board shows what is true, rather than agents that stopped existing
    // when Echo exited.
    {
      const closed = swarm.reconcileAbandoned({ makeBrain: () => { throw new Error("unused"); } } as any);
      supervisor.reconcile();
      if (closed.tasks) {
        console.warn(`[echo:recovery] closed ${closed.tasks} abandoned Agent Task(s) across ${closed.missions} mission(s)`);
      }
    }
    
    // Futuristic Features: Background Tasks
    if (cfg.helpers?.screenHistory === true) {
      let suspended = false, locked = false;
      powerMonitor.on("suspend", () => { suspended = true; });
      powerMonitor.on("resume", () => { suspended = false; });
      powerMonitor.on("lock-screen", () => { locked = true; });
      powerMonitor.on("unlock-screen", () => { locked = false; });
      startRewind({ intervalSeconds: cfg.helpers.screenHistoryIntervalSeconds,
        canCapture: () => !suspended && !locked });
    }
    // Opt-in: it needs Documents access, which prompted every new user at launch.
    if (cfg.helpers?.watchdog) startWatchdog();
    // The prediction model is the user's data, so it lives with it — it was
    // written into the app folder, and from there into the repository. An
    // existing copy there is carried over once.
    try {
      const legacy = join(app.getAppPath(), "prefetch.json");
      const current = join(dataRoot(), "prefetch.json");
      if (!existsSync(current) && existsSync(legacy)) {
        mkdirSync(dataRoot(), { recursive: true });
        copyFileSync(legacy, current);
      }
    } catch (err) {
      console.error("[jarvis] could not carry the prediction model over:", (err as any)?.message ?? err);
    }
    prefetch.start(); // load the command-prediction model
    // Ghost (pattern spotting), Shadow (pair programmer) and Auto-debug all run
    // on the LOCAL Ollama model — none of them touch Claude or Gemini. They were
    // gated on `brain === "gemini"`, which is unrelated: it left them off under
    // Claude even with Ollama running, and started them under Gemini whether or
    // not Ollama was up. Gate on the thing they actually need instead.
    // Each of these polls the SCREEN forever, so "is Ollama up?" is the wrong
    // question — a reachable port is not a request to be watched. Gating on that
    // alone started shadow's 15-second full-screen OCR automatically and drove
    // this machine to a load average of 14 while Echo looked idle. They are
    // opt-in now, and the Ollama check only decides whether an opted-in helper
    // can actually work.
    const want = cfg.helpers ?? { shadow: false, ghost: false, autoDebug: false };
    if (want.shadow || want.ghost || want.autoDebug) {
      void ollamaReachable(cfg.ollama?.host).then((up) => {
        if (shuttingDown) return;
        if (!up) {
          console.log("[jarvis] helpers are on in config but Ollama is not reachable — staying off");
          return;
        }
        const on: string[] = [];
        if (want.ghost) { startGhostMode(tts); on.push("ghost"); }
        if (want.autoDebug) { startAutoDebug(tts); on.push("auto-debug"); }
        if (want.shadow) { startShadowMode(tts, cfg.helpers?.shadowIntervalSeconds); on.push("shadow"); }
        console.log(`[jarvis] background helpers on: ${on.join(", ")}`);
      });
    }

    // Embed memory every 5 minutes
    if (cfg.helpers?.memoryIndexing === true) {
      mainTimers.every(5 * 60 * 1000, embedRecentMemory, err => console.error("[jarvis] memory indexing failed:", err));
    }
    
    // Meeting reminders. Only while Calendar is already open (asking a closed
    // Calendar launches it — every minute), once per event, and on a window
    // rather than `minutesAway === 5` exactly, which a late poll skipped.
    if (cfg.helpers?.meetingReminders !== false) {
      const reminded = new Set<string>();
      mainTimers.every(60000, async () => {
        try {
          const events = await upcomingEvents(1, { onlyIfRunning: true });
          if (shuttingDown) return;
          for (const next of events) {
            const key = `${next.title}@${Math.round(Date.parse(next.start) / 60000)}`;
            if (next.minutesAway > 5 || next.minutesAway < 3 || reminded.has(key)) continue;
            reminded.add(key);
            const msg = `Your meeting "${next.title}" starts in ${next.minutesAway} minutes.`;
            send("notice", { level: "info", text: msg });
            tts.say(msg);
          }
          if (reminded.size > 200) reminded.clear();
        } catch (err) {
          console.error("[jarvis] Calendar poll error:", err);
        }
      });
    }
  });

  app.on("activate", () => {
    if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  console.error('[jarvis] startup failed:', error);
  if (!shuttingDown) {
    send("notice", {level: "error", text: `Echo could not start: ${String(error)}`});
    void requestAppShutdown('startup failure');
  }
});

/**
 * Release everything this process owns: the mic, the brain, the speech child
 * process, and the whisper server.
 *
 * This must run on EVERY exit path. `app.exit()` force-terminates without
 * firing will-quit, so a route that calls it has to invoke this itself —
 * otherwise the spawned `say` and whisper-server survive as orphans owned by
 * launchd. An orphaned `say` is what makes a restarting Jarvis appear to answer
 * in two overlapping voices: the old one is still talking when the new one starts.
 */
let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  inputRevision++;
  mainTimers.close();
  const brainStopping = shutdownStep('brain', () => brainLifecycle?.close() ?? brain?.stop());
  shutdownPromise = (async () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* already gone */
  }
  await shutdownStep('microphone', () => listener?.stop(), 3000);
  await shutdownStep('speech', () => { tts?.stop(); realtime?.close(); realtime = null; }, 3000);
  await shutdownStep('Piper workers', () => PiperWorker.stopAll(), 3000);
  await shutdownStep('Telegram', () => telegram?.stop(), 3000);
  await shutdownStep('speech recognition', () => stopSttServer(), 3000);
  await shutdownStep('audio player', () => player?.dispose(), 3000);
  await shutdownStep('task reports', () => closeTaskReports(), 3000);
  await Promise.all([
    shutdownStep('background agents', () => swarm.close()),
    shutdownStep('supervised tasks', () => supervisor.close()),
  ]);
  await shutdownStep('background browser', () => closeBackgroundBrowser(), 3000);
  await shutdownStep('terminal commands', () => stopTerminalCommands(), 3000);
  await shutdownStep('coding workers', () => stopCodingWorkers());
  // stop() closes the selected brain's own MCP connection. Await it before
  // Electron exits: starting an async close from will-quit and immediately
  // ending the process is how uvx workers became orphaned.
  try {
    await brainStopping;
  } catch (err) {
    console.error("[jarvis] brain shutdown failed:", err);
  }
  // Clones and any partially-started connection are registered globally in
  // the MCP layer, so this is the final ownership backstop.
  await shutdownStep('MCP servers', () => closeMcpServers());
  for (const [name, stop] of [['rewind', stopRewind], ['watchdog', stopWatchdog], ['ghost', stopGhostMode], ['debugger', stopAutoDebug], ['shadow', stopShadowMode]] as const) {
    await shutdownStep(name, stop, 3000);
  }
  // Quitting must close the listening port. Leaving a socket open after the
  // app is gone would be a hole nobody could see to close.
  await shutdownStep('remote server', () => stopRemote(), 3000);
  await shutdownStep('capture bridge', () => stopCaptureBridge(), 3000);
  await shutdownStep('overlay', () => destroyOverlayWindow(), 3000);
  await shutdownStep('orbital panel', () => closeOrbitalPanel(), 3000);
  // Quitting is the one thing other than an explicit "close it" that takes the
  // grid down — leaving a window behind a dead app would be worse.
  await shutdownStep('Osiris panel', () => closeOsirisPanel(), 3000);
  await shutdownStep('neural core', () => closeNeuralCore(), 3000);
  // Turn the camera-driven sensors off through their own toggles first — the
  // ordinary "release on the way out". Each stops its tracker via the child
  // handle we still hold and clears the module's state; a sensor that was never
  // on is a no-op. (toggleSonar's disable path ignores tts, but the signature
  // demands one.) None of this may throw its way out of a quit.
  await shutdownStep('gestures', () => toggleGestures(false), 3000);
  await shutdownStep('eye tracking', () => toggleEyeTracking(false), 3000);
  await shutdownStep('sonar', () => toggleSonar(false, tts), 3000);
  // Backstop: SIGKILL by name anything still holding the camera — a helper the
  // toggle above couldn't reach, or an orphan from a run that never got here.
  // The SYNC variant is deliberate: will-quit does not await promises, so an
  // async release simply never finishes and the camera light stays on with an
  // orphan holding it.
  try {
    releaseCameraSync("app shutting down");
  } catch {
    /* nothing more to do on the way out */
  }
  })();
  return shutdownPromise;
}

const requestAppShutdown = gracefulShutdown(shutdown, () => {
  shutdownComplete = true;
  // Resources have been released; avoid re-entering a pending native quit.
  app.exit(0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => { void requestAppShutdown(`terminal ${signal}`); });
}

// What the phone's stop button actually does. Registered here because this is
// where the brain lives; the tool that opens the remote never touches it.
setInterruptHandler(() => {
  try {
    // The same stop as the hotkey and the HUD button. The phone's used to stop
    // only the brain and the file-path voice, so a streamed reply kept talking
    // and the conversation window stayed open.
    stopEverything("stopped from the phone");
  } catch {
    /* stopping should never throw back at the network */
  }
});

// A command typed or spoken on the phone is fed to the brain exactly as if it
// had been said out loud at the desk — it then flows through the same safety
// gate, so a risky action still surfaces a confirmation (answerable from the
// phone). Echoed to the HUD so the desk shows what the phone asked for.
/**
 * A command from another device — the phone remote or Telegram.
 *
 * One path for both. The phone's used to call `brain.send` directly, which
 * skipped brain switching and memory commands, and skipped `dispatchToBrain`'s
 * bookkeeping: the voice session was never told a new turn had started, so
 * after any "stop" earlier in the session, replies to phone commands were
 * treated as leftovers of the cancelled turn and never spoken.
 */
function handleRemoteCommand(text: string, source: RemoteChannel, modality: "voice" | "text" = "text"): void {
  if (shuttingDown) return;
  const revision = inputRevision;
  if (brainLifecycle?.isSwitching) {
    void brainLifecycle.ready().then(ready => {
      if (ready && !shuttingDown && revision === inputRevision) handleRemoteCommand(text, source, modality);
    }).catch(error => console.error('[brain] pending remote command failed:', error));
    return;
  }
  // The turn starts here, before the confirmation and memory shortcuts, so
  // even their answers go back to the device that asked.
  const turn = voiceSession.beginTurn("typed");
  remoteTurns.set(turn.id, source);
  if (remoteTurns.size > 64) remoteTurns.delete(remoteTurns.keys().next().value!);
  try {
    console.log(`[jarvis] ${source} command: ${text}`);
    send("message", { kind: "user", text: `${source === "telegram" ? "✈️" : source === "chat" ? "💬" : "📱"} ${text}` });
    if (maybeAnswerConfirmation(text)) return;
    void maybeMemoryCommand(text)
      .then(async (handled) => {
        if (handled || shuttingDown || revision !== inputRevision) return;
        if (await maybeSwitchBrain(text)) return;
        if (shuttingDown || revision !== inputRevision) return;
        await refreshScope();
        if (shuttingDown || revision !== inputRevision) return;
        beginLearnedTurn(text);
        dispatchToBrain(text, undefined, turn, modality);
      })
      .catch((e) => console.error(`[jarvis] ${source} command failed:`, e));
  } catch (e) {
    console.error(`[jarvis] ${source} command failed:`, e);
  }
}

// Commands typed or spoken on the phone flow through the same path as
// Telegram, and through the same safety gate — a risky action still asks, and
// the question can be answered from the phone.
// The phone app's chat: answered in the conversation, like Telegram — a voice
// note there is still a chat message, so it gets the chat style, not speech.
setChatHandler((text: string) => handleRemoteCommand(text, "chat", "text"));

// Spoken on the phone gets the short spoken style; typed gets text.
setCommandHandler((text: string, via) => handleRemoteCommand(text, "phone", via === "voice" ? "voice" : "text"));

/**
 * Everything the phone's pages show, from the same telemetry the desktop
 * control panel reads, so the two never disagree. Private projects stay off
 * the phone, and the log is sent incrementally after the id the phone has.
 */
setStatusProvider((logsAfter) => {
  const snap = controlTelemetry.snapshot(controlRuntime());
  const active = snap.models.find((m) => m.active);
  const trim = (text: unknown, n: number) => String(text ?? "").slice(0, n);
  return {
    status: String(snap.state.status ?? "idle"),
    brain: active ? { id: active.id, label: active.label, model: active.model } : null,
    models: snap.models
      .filter((m) => m.available || m.active)
      .map((m) => ({ id: m.id, label: m.label, model: m.model, active: m.active })),
    voice: {
      ttsEnabled: snap.settings.voice.ttsEnabled,
      wakeWord: snap.settings.voice.wakeWord,
      bargeIn: snap.settings.voice.bargeIn,
    },
    analytics: snap.analytics,
    tasks: snap.tasks.slice(-6).map((t) => ({ id: t.id, title: trim(t.title, 160), status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt ?? null })),
    missions: snap.missions.slice(0, 8).map((m) => ({
      id: m.id, goal: trim(m.goal, 200), status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt,
      steps: Object.values(m.tasks).slice(0, 12).map((t) => ({ goal: trim(t.goal, 140), status: t.status, actor: t.actorName ?? null, startedAt: t.startedAt ?? null })),
    })),
    projects: listCodingProjects()
      .filter((p) => !p.privateMode)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map((p) => ({ id: p.id, name: p.name, phase: p.phase, revision: p.revision, criteria: p.acceptance.length,
        updatedAt: p.updatedAt, question: p.question && !p.question.answer ? trim(p.question.text, 200) : null })),
    connections: snap.connections.map((c) => ({ name: c.name, status: c.status })),
    agents: snap.agents.slice(0, 12).map((a) => ({ id: a.id, name: trim(a.name, 60), goal: trim(a.goal, 160), status: a.status, progress: trim(a.progress, 160), startedAt: a.startedAt })),
    logs: snap.logs.filter((l) => l.id > logsAfter).slice(-80).map((l) => ({ id: l.id, at: l.at, kind: l.kind, text: trim(l.text, 400) })),
  };
});

// The public link's address changes whenever the tunnel restarts, so each new
// one is saved (the HUD's remote button and phone_remote_status read it) and
// sent to the user's own Telegram chats — the phone needs it to get back in.
// A permanent link comes back unchanged after every reconnect; it is sent once.
let lastSentRemoteUrl = "";
setPublicUrlListener((url) => {
  if (!url || url === lastSentRemoteUrl) return;
  lastSentRemoteUrl = url;
  saveRemoteUrl(url);
  const tell = (triesLeft: number) => {
    // At launch the remote starts before Telegram does; wait for it briefly.
    if (!telegram) { if (triesLeft > 0) setTimeout(() => tell(triesLeft - 1), 5000); return; }
    void telegram.notify(`Echo remote — new link (works on Wi-Fi and mobile data):\n${url}`)
      .catch((error) => console.error("[telegram] could not send the remote link:", error));
  };
  tell(6);
});

// The phone's short list of controls, run through the control panel's own
// handlers so the same checks apply (an unavailable brain is refused, voice
// settings are saved the same way). parseRemoteAction already refused the rest.
setActionHandler(async (action) => {
  let result: { ok: boolean; message?: string };
  if (action.type === "switch-model") result = await handleControlAction({ type: "switch-model", provider: action.provider });
  else if (action.type === "set-voice") result = await handleControlAction({ type: "save-settings", settings: { voice: { [action.key]: action.value } } as any });
  else if (action.type === "open-neural") result = await handleControlAction({ type: "neural" });
  // Face ID was checked by the remote before this is reached.
  else if (action.type === "power-off") result = await handleControlAction({ type: "shutdown" });
  else result = await handleControlAction({ type: "stop-mission", missionId: action.missionId });
  publishControlUpdate();
  return result;
});

function handleTelegramCommand(text: string): void {
  handleRemoteCommand(text, "telegram");
}

// Electron does not await will-quit handlers. Hold before-quit exactly once,
// finish asynchronous MCP teardown, then allow the second quit attempt.
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  requestAppShutdown("application quit");
});
// Reachable from the switch_brain tool, which force-exits and would otherwise
// leave the speech process and whisper server orphaned.
setCodingEventHandler(event=>{
  send("message",{kind:"assistant",text:`[Build] ${event.text}`});
  if(event.kind==='question'||event.kind==='error'){tts.say(event.text);expectAnswer=event.kind==='question';if(expectAnswer&&!cfg.voice.ttsEnabled)maybeAutoListen();}
});
setShutdownHandler(shutdown);

// Keep running in the background even with no windows (it's a menu-bar-style agent).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
