import {isBotRunId,TEAM_BOT_ID} from "./bots.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";
import { readVitals } from "./remote-vitals.js";
import { screenFrame } from "./remote-frame.js";
import { transcribeRemoteVoice, RemoteVoiceError } from "./remote-voice.js";
import { RelayAgent, CLIENT_IP_HEADER } from "./relay-agent.js";
import { ChatLog } from "./remote-chat.js";
import { PasskeyStore } from "./passkeys.js";
import { signPass, PassGeneration, DEVICE_ID } from "./cloudpass.js";
import { collectDigest, DIGEST_EVERY_MS } from "./phone-digest.js";
import { processHandoffs, taskChallenge, SeenTasks, type HandoffTask } from "./handoff.js";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { dataRoot } from "../memory/paths.js";
import {
  SessionStore, sessionFrom, verifyPassword, hasPassword, getStableToken,
} from "./remoteauth.js";
import {
  Signalling, ConfirmRelay, normaliseCommand, type Sdp, type IceCandidate,
} from "./remotesignal.js";
import { moveMouseBy, clickHere, hotkey, scroll, typeText } from "../tools/computer-actions.js";

/**
 * Watching a long job from your phone.
 *
 * A refactor running on the Mac is a job you cannot watch, and a job you cannot
 * watch is a job you cannot trust. The action feed already exists as a stream
 * of events; this puts it somewhere you can see from the sofa.
 *
 * The security thinking matters more than the feature. This opens a port on
 * whatever network the machine is on — which may be a cafe, an airport, or an
 * office full of strangers — so the assumptions are:
 *
 *   - OFF by default, and started only when asked. It is not a background
 *     service; it exists for the duration of a job you are watching.
 *   - A long random token is required on EVERY request. Without one the server
 *     answers 404, not 401: a 401 confirms something is listening, which is
 *     information a scanner should not get for free.
 *   - The token is new every time it starts. A link you showed someone once
 *     does not work tomorrow.
 *   - Control sits behind a password session on top of the link: commands,
 *     voice, the trackpad and keyboard, approvals, and a short allowlist of
 *     settings (brain, three voice switches, stopping a task). API keys,
 *     settings files, agents and quitting Echo are never reachable from here —
 *     a signed-in phone can still end up in someone else's hand.
 *   - It expires on its own, so forgetting to turn it off is not a permanent
 *     hole in the network.
 */

export interface FeedItem {
  at: number;
  line: string;
  kind: string;
}

/** Events kept for the phone to catch up on. */
export const MAX_ITEMS = 200;
/** Shut down on its own after this long. Long, since the link is meant to be
 *  saved and reused; a forgotten-open port on a private tailnet behind a
 *  password is a small risk, and the whole point is that it stays reachable. */
export const DEFAULT_TTL_MS = 12 * 3600_000;
/** Wrong tokens from one address before it stops answering that address. */
export const MAX_BAD_ATTEMPTS = 5;

export function newToken(): string {
  // 32 hex characters. Long enough that guessing is not a strategy, short
  // enough to type from a screen if the QR code will not scan.
  return randomBytes(16).toString("hex");
}

/**
 * Compare tokens without leaking their contents through timing.
 *
 * `a === b` on a secret returns as soon as it finds a differing character, so
 * how long it takes reveals how much of the prefix was right. That is a real
 * attack against something reachable over a network.
 */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  // timingSafeEqual throws on a length mismatch, which is itself a leak — but
  // only of the length, which is fixed and public here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token out of a request URL. */
export function tokenFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf("?");
  if (q < 0) return undefined;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get("t") ?? undefined;
}

export type Route =
  | "page"
  | "events"
  | "stop"
  | "login"
  | "command"
  | "confirm"
  | "confirm-poll"
  | "rtc-offer"
  | "rtc-answer"
  | "rtc-ice-phone"
  | "rtc-ice-mac"
  | "voice"
  | "mouse"
  | "log"
  | "asset"
  | "status"
  | "action"
  | "keys"
  | "signout-all"
  | "close"
  | "frame"
  | "ping"
  | "chat"
  | "chat-voice"
  | "chat-import"
  | "passkey-options"
  | "passkey-register"
  | "passkey-login"
  | "unknown";

/** Files the phone page may load from renderer/remote. Anything else is not a route. */
export const ASSET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:css|js|png)$/;

export function routeOf(url: string | undefined): Route {
  const path = (url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/") return "page";
  if (path === "/events") return "events";
  if (path === "/stop") return "stop";
  if (path === "/login") return "login";
  if (path === "/command") return "command";
  if (path === "/confirm") return "confirm"; // phone POSTs an answer
  if (path === "/pending") return "confirm-poll"; // phone GETs the current question
  if (path === "/rtc/offer") return "rtc-offer"; // phone POSTs its SDP offer
  if (path === "/rtc/answer") return "rtc-answer"; // phone GETs the Mac's answer + ICE
  if (path === "/rtc/ice") return "rtc-ice-phone"; // phone POSTs a candidate
  if (path === "/rtc/ice-mac") return "rtc-ice-mac"; // phone GETs the Mac's candidates
  if (path === "/voice") return "voice"; // phone POSTs raw wav audio
  if (path === "/mouse") return "mouse"; // phone POSTs mouse events
  if (path === "/log") return "log"; // phone POSTs client logs
  if (path === "/status") return "status"; // phone GETs everything its pages show
  if (path === "/action") return "action"; // phone POSTs one allow-listed control
  if (path === "/keys") return "keys"; // phone POSTs text or a key chord for the Mac
  if (path === "/signout-all") return "signout-all";
  if (path === "/close") return "close";
  if (path === "/frame") return "frame"; // phone GETs a still of the screen
  if (path === "/chat") return "chat"; // phone GETs the conversation, POSTs a message
  if (path === "/chat/voice") return "chat-voice"; // phone POSTs a voice note (wav)
  if (path === "/chat/import") return "chat-import"; // phone POSTs what Phone mode said while the Mac was away
  if (path === "/passkey/options") return "passkey-options";
  if (path === "/passkey/register") return "passkey-register";
  if (path === "/passkey/login") return "passkey-login";
  if (path === "/ping") return "ping"; // a cheap "are you there?" behind the link token
  if (path.startsWith("/app/") && ASSET_NAME.test(path.slice(5))) return "asset";
  return "unknown";
}

/**
 * A Tailscale address on this machine, if it is on a tailnet.
 *
 * Tailscale hands every device an address in the 100.64.0.0/10 range (the
 * carrier-grade NAT block it borrows for the purpose). Preferring it over the
 * ordinary LAN address is what makes the remote reachable from anywhere: the
 * phone and the Mac are on the same private, encrypted tailnet even when they
 * are on opposite sides of the world, and nothing is ever exposed to the public
 * internet.
 */
export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      // 100.64.0.0 – 100.127.255.255
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

export type HostKind = "tailscale" | "lan";

/**
 * The address to hand the phone, preferring the tailnet.
 *
 * Tailscale first, because it works from anywhere; the LAN address is the
 * fallback for when you are on the same Wi-Fi and have not set Tailscale up.
 */
export function preferredHost(): { host: string; kind: HostKind } | null {
  const ts = tailscaleAddress();
  if (ts) return { host: ts, kind: "tailscale" };
  const lan = lanAddress();
  if (lan) return { host: lan, kind: "lan" };
  return null;
}

// ---- what the phone is shown ---------------------------------------------

const items: FeedItem[] = [];
let running = false;
let startedAt = 0;
/** When the link closes on its own; 0 when it is always on. */
let expiresAt = 0;
let token = "";
let server: any = null;
/** The loopback listener the relay agent replays phone requests against. */
let loopServer: any = null;
let relay: RelayAgent | null = null;
/** The phone app's permanent address while Echo is connected to it, else null. */
let relayBase: string | null = null;
/** Where the phone app is served from: its origin and passkey relying-party id. */
let appSite: { origin: string; rpId: string } | null = null;
/** Files live with the link token and password, so tests can point them elsewhere. */
const remoteDir = () => process.env.JARVIS_REMOTE_DIR || dataRoot();
let chatLog: ChatLog | null = null;
let passkeys: PasskeyStore | null = null;
function chat(): ChatLog { return (chatLog ??= new ChatLog(join(remoteDir(), "remote-chat.json"))); }
function keys(): PasskeyStore { return (passkeys ??= new PasskeyStore(join(remoteDir(), "remote-passkeys.json"))); }
/** The relay secret while the phone app's relay is in use: it signs cloud passes. */
let relaySecret: string | null = null;
let passGenStore: PassGeneration | null = null;
/**
 * The briefing digest (phone-digest.ts): sent to the relay a minute after it
 * connects and then hourly, so the morning briefing has your day even if the
 * Mac is off by then.
 */
let digestTimer: NodeJS.Timeout | null = null;
function scheduleDigest(delay: number) {
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = setTimeout(async () => {
    digestTimer = null;
    if (!relay || !relayBase) return;
    try {
      const digest = await collectDigest(() => statusProvider?.(0) ?? {});
      const sent = await relay.post("/agent/digest", digest);
      remoteLog(sent ? `briefing digest sent (${digest.calendar?.length ?? "no"} events, ${digest.email?.length ?? "no"} emails)` : "briefing digest not accepted");
    } catch (e: any) {
      remoteLog(`briefing digest failed: ${e?.message ?? e}`);
    }
    if (relay && relayBase) scheduleDigest(DIGEST_EVERY_MS);
  }, delay);
}
function passGen(): PassGeneration { return (passGenStore ??= new PassGeneration(join(remoteDir(), "remote-pass-gen.json"))); }
/**
 * A cloud pass for this phone (see cloudpass.ts): Phone mode's key for while the
 * Mac is off. Only through the phone app, and only for a well-formed device id.
 */
function issuePass(device: unknown): string | undefined {
  if (!relaySecret || typeof device !== "string" || !DEVICE_ID.test(device)) return undefined;
  return signPass(relaySecret, { device, gen: passGen().get() });
}

/** What to do with a chat message from the phone app. Set by the process that owns the brain. */
let chatHandler: ((text: string, via: "typed" | "voice") => void) | null = null;
export function setChatHandler(fn: (text: string, via: "typed" | "voice") => void) {
  chatHandler = fn;
}
/** Echo's answer in the chat, from the turn the phone app started. */
export function chatReply(text: string): void {
  if (!text.trim()) return;
  chat().add("echo", text.trim());
  handoffTurn?.replies.push(text.trim());
}
/** A turn ended (or failed, with its error): clear "typing…", and finish a running hand-off job. */
export function chatIdle(error?: string): void {
  chatLog?.setTyping(false);
  const turn = handoffTurn;
  if (!turn) return;
  handoffTurn = null;
  clearTimeout(turn.timer);
  turn.resolve(error
    ? { ok: false, summary: `Echo hit a problem: ${String(error).slice(0, 300)}` }
    : { ok: true, summary: turn.replies.at(-1) ?? "Done." });
}

/**
 * Hand-off jobs (handoff.ts): left on the phone with Face ID while the Mac was
 * away; checked here and run as ordinary chat turns, one at a time.
 */
let handoffTurn: { replies: string[]; resolve: (r: { ok: boolean; summary: string }) => void; timer: NodeJS.Timeout } | null = null;
let handoffTimer: NodeJS.Timeout | null = null;
let handoffRunning = false;
let seenTasks: SeenTasks | null = null;
const HANDOFF_TURN_MS = 20 * 60_000;
function runHandoff(task: HandoffTask): Promise<{ ok: boolean; summary: string }> {
  return new Promise((resolve) => {
    if (!chatHandler) return resolve({ ok: false, summary: "Echo's chat isn't ready yet." });
    chat().add("you", task.text, "text", Date.now(), "handoff");
    chat().setTyping(true);
    const timer = setTimeout(() => {
      if (handoffTurn?.resolve === resolve) handoffTurn = null;
      resolve({ ok: true, summary: "Started on your Mac; it's still working on it." });
    }, HANDOFF_TURN_MS);
    handoffTurn = { replies: [], resolve, timer };
    try { chatHandler(task.text, "typed"); } catch (e: any) { chatIdle(String(e?.message ?? e)); }
  });
}
function scheduleHandoffs(delay: number) {
  if (handoffTimer || handoffRunning) return;
  handoffTimer = setTimeout(async () => {
    handoffTimer = null;
    if (!relay || !relayBase || !appSite) return;
    handoffRunning = true;
    let busy = false;
    try {
      const site = appSite;
      await processHandoffs({
        list: async () => ((await relay?.get("/agent/handoff"))?.items ?? []),
        update: async (id, status, summary) => { await relay?.post("/agent/handoff/update", { id, status, summary }); },
        verify: (task, assertion) => { keys().verifySigned(assertion, site.origin, site.rpId, taskChallenge(task)); },
        run: runHandoff,
        busy: () => (busy = String((statusProvider?.(0) as any)?.status ?? "idle") !== "idle" || chat().typing()),
        seen: (seenTasks ??= new SeenTasks(join(remoteDir(), "remote-handoffs-seen.json"))),
        log: remoteLog,
      });
    } catch (e: any) {
      remoteLog(`hand-off check failed: ${e?.message ?? e}`);
    } finally {
      handoffRunning = false;
    }
    if (busy) scheduleHandoffs(60_000); // Echo was busy: look again in a minute
  }, delay);
}

/** Told the full link (with token) when the phone app connects, and null when it drops. */
let publicUrlListener: ((url: string | null) => void) | null = null;
export function setPublicUrlListener(fn: (url: string | null) => void) {
  publicUrlListener = fn;
}

/** Is the phone app's relay set up, and its full link while Echo is connected to it. */
export function publicLinkState(): { enabled: boolean; url: string | null } {
  return { enabled: !!relay, url: running && relayBase ? `${relayBase}/?t=${token}` : null };
}

/**
 * The remote's own log, because Echo's console often lives in a terminal
 * nobody is reading. Small and rolling: cleared once it passes 256 KB.
 */
export function remoteLog(line: string): void {
  try {
    const file = join(dataRoot(), "remote.log");
    try { if (statSync(file).size > 256 * 1024) writeFileSync(file, ""); } catch { /* not yet written */ }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* a log must never break the remote */ }
}

let expiry: NodeJS.Timeout | null = null;
let onStop: (() => void) | null = null;
const badAttempts = new Map<string, number>();

// The three relays that make full remote control work, shared between the HTTP
// server (which talks to the phone) and the Electron side (which owns the
// WebRTC peer and the brain). Created once; reset when the remote restarts.
const sessions = new SessionStore();
const signalling = new Signalling();
const confirmRelay = new ConfirmRelay();

/** What to do with a command the phone sends. Set by the process that owns the brain. */
let commandHandler: ((text: string, via: "typed" | "voice") => void) | null = null;
export function setCommandHandler(fn: (text: string, via: "typed" | "voice") => void) {
  commandHandler = fn;
}

/**
 * What the phone's pages show: Echo's state, brain, tasks, projects, voice
 * settings and the log after `logsAfter`. Set by the process that owns the
 * brain; this module adds the Mac's vitals and the link's own lifetime.
 */
export type StatusProvider = (logsAfter: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
let statusProvider: StatusProvider | null = null;
export function setStatusProvider(fn: StatusProvider) {
  statusProvider = fn;
}

/**
 * The controls the phone may use beyond talking and stopping. Deliberately a
 * short list: brain, three voice switches, and stopping one task. API keys,
 * settings files and agent-profile management stay at the Mac — a phone can be
 * picked up by someone else while it is still signed in.
 */
export type RemoteAction =
  | {type:"run-bot";name:string;goal:string;requestId:string;botRevision:string;parentId?:string;agentIds?:string[]}
  | {type:"stop-bot";missionId:string}
  | { type: "switch-model"; provider: string }
  | { type: "set-voice"; key: "ttsEnabled" | "wakeWord" | "bargeIn"; value: boolean }
  | { type: "stop-mission"; missionId: string }
  | { type: "open-neural" }
  /** Only after a fresh Face ID confirmation, checked in the route. */
  | { type: "power-off" };
export type ActionHandler = (action: RemoteAction) => Promise<{ ok: boolean; message?: string; data?:Record<string,unknown> }>;
let actionHandler: ActionHandler | null = null;
export function setActionHandler(fn: ActionHandler) {
  actionHandler = fn;
}

/** Validate a phone's action against the allowlist; anything else is null. */
export function parseRemoteAction(body: any): RemoteAction | null {
  const type = body?.type;
  if(type==='run-bot' && typeof body.name==='string' && (body.name===TEAM_BOT_ID||/^[a-z][a-z0-9-]{0,23}$/.test(body.name)) && typeof body.goal==='string' && body.goal.trim() && body.goal.length<=4000 && typeof body.requestId==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.requestId) && typeof body.botRevision==='string' && /^[a-f0-9]{24}$/.test(body.botRevision) && (body.parentId===undefined||typeof body.parentId==='string'&&isBotRunId(body.parentId)) && (body.agentIds===undefined||body.name===TEAM_BOT_ID&&Array.isArray(body.agentIds)&&body.agentIds.length>0&&body.agentIds.length<=12&&body.agentIds.every((id:unknown)=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,23}$/.test(id))))return {type,name:body.name,goal:body.goal,requestId:body.requestId,botRevision:body.botRevision,parentId:body.parentId,...(body.agentIds?{agentIds:[...new Set<string>(body.agentIds)]}:{})};
  if(type==='stop-bot' && typeof body.missionId==='string' && isBotRunId(body.missionId))return {type,missionId:body.missionId};
  if (type === "switch-model" && typeof body.provider === "string" && /^[a-z]{2,20}$/.test(body.provider)) {
    return { type, provider: body.provider };
  }
  if (type === "set-voice" && ["ttsEnabled", "wakeWord", "bargeIn"].includes(body.key) && typeof body.value === "boolean") {
    return { type, key: body.key, value: body.value };
  }
  if (type === "stop-mission" && typeof body.missionId === "string" && /^[\w.:-]{1,200}$/.test(body.missionId)) {
    return { type, missionId: body.missionId };
  }
  if (type === "open-neural") return { type };
  if (type === "power-off" && body.assertion && typeof body.assertion === "object") return { type };
  return null;
}

/** The key chords the phone's keyboard page offers, and nothing else. */
export const REMOTE_KEYS: Record<string, [string[], string]> = {
  "esc": [[], "esc"], "tab": [[], "tab"], "return": [[], "return"], "space": [[], "space"],
  "delete": [[], "delete"], "arrow-up": [[], "arrow-up"], "arrow-down": [[], "arrow-down"],
  "arrow-left": [[], "arrow-left"], "arrow-right": [[], "arrow-right"],
  "cmd+tab": [["cmd"], "tab"], "cmd+c": [["cmd"], "c"], "cmd+v": [["cmd"], "v"], "cmd+z": [["cmd"], "z"],
};
/** Longest text the phone may type in one go. */
export const MAX_TYPED = 500;

/**
 * Trackpad drags arrive many times a second. Each move is a process spawn, so
 * deltas pile up here and one worker applies them — a burst becomes one move
 * instead of a queue of stale ones replaying after the finger has stopped.
 */
let pendingMove = { dx: 0, dy: 0 };
let moving = false;
function queueMove(dx: number, dy: number): void {
  pendingMove.dx += dx;
  pendingMove.dy += dy;
  if (moving) return;
  moving = true;
  void (async () => {
    while (pendingMove.dx || pendingMove.dy) {
      const { dx: x, dy: y } = pendingMove;
      pendingMove = { dx: 0, dy: 0 };
      await moveMouseBy(x, y).catch(() => {});
    }
    moving = false;
  })();
}

/** The Mac side (main process) reaches the WebRTC mailbox and the confirm relay through these. */
export function macSignalling(): Signalling {
  return signalling;
}
export function macConfirmRelay(): ConfirmRelay {
  return confirmRelay;
}
/** True while a phone has a live session — so confirmations know to also ask it. */
export function hasLiveSession(): boolean {
  return sessions.count() > 0;
}

/** Record something for the phone to see. */
export function record(line: string, kind = "") {
  if (!running || !line) return;
  items.push({ at: Date.now(), line, kind });
  // A ring buffer: a long job would otherwise grow this without limit.
  if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
}

export function recentItems(sinceIndex = 0): { items: FeedItem[]; nextIndex: number } {
  const from = Math.max(0, Math.min(sinceIndex, items.length));
  return { items: items.slice(from), nextIndex: items.length };
}

export function isRunning(): boolean {
  return running;
}

/** The address to open on the phone, or null when not running. */
export function remoteUrl(port: number): string | null {
  if (!running) return null;
  // The phone app reaches the phone from any network, so it wins when connected.
  if (relayBase) return `${relayBase}/?t=${token}`;
  const pref = preferredHost();
  return pref ? `http://${pref.host}:${port}/?t=${token}` : null;
}

/**
 * This machine's address on the local network.
 *
 * Explicitly not the loopback address — the whole point is reaching it from
 * another device, and a link to 127.0.0.1 would work perfectly on the Mac and
 * fail silently on the phone, which is the most confusing possible outcome.
 */
export function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** Has this address failed too many times to keep answering? */
export function isLockedOut(ip: string): boolean {
  return (badAttempts.get(ip) ?? 0) >= MAX_BAD_ATTEMPTS;
}

export function noteBadAttempt(ip: string): void {
  badAttempts.set(ip, (badAttempts.get(ip) ?? 0) + 1);
}

export function resetAttempts(): void {
  badAttempts.clear();
}

/** Where the phone app's files live: renderer/remote, beside the other windows. */
export function remoteAssetDir(): string {
  return join(getAppPath(), "renderer", "remote");
}

/**
 * The phone app's page, with the link token baked in.
 *
 * Login first — the live reactor and a password — then five pages: Core,
 * Screen, Work, Feed and System. The markup, stylesheet, script and reactor
 * art are files in renderer/remote, served under /app/ behind the same link
 * token as the page; nothing is loaded from anywhere else. The token goes into
 * every URL so the phone never has to retype it. It is hex, so it cannot break
 * out of the attributes it is written into.
 */
export function renderPage(tok: string): string {
  if (!/^[0-9a-f]+$/.test(tok)) throw new Error("Invalid link token.");
  const file = join(remoteAssetDir(), "index.html");
  if (!existsSync(file)) return "<!doctype html><title>Echo</title><p>The phone app files are missing from this install.</p>";
  return readFileSync(file, "utf8").replaceAll("__T__", tok);
}

const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
};

// ---- the server -----------------------------------------------------------

export interface StartResult {
  ok: boolean;
  url?: string;
  message: string;
}

/**
 * What "stop" does.
 *
 * Registered once at startup by the process that owns the brain. The tool that
 * opens the remote has no handle on it, and threading one through would mean
 * the registry holding a reference to the running agent — which is exactly the
 * coupling the tool layer avoids everywhere else.
 */
let interruptHandler: (() => void) | null = null;

export function setInterruptHandler(fn: () => void) {
  interruptHandler = fn;
}

/** Read a JSON request body, capped so a flood cannot exhaust memory. */
function readJsonBody(req: any, cb: (body: any | null) => void): void {
  let data = "";
  let aborted = false;
  req.on("data", (chunk: any) => {
    data += chunk;
    if (data.length > 256 * 1024) {
      aborted = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    console.log(`[jarvis] readJsonBody received payload of length ${data.length}`);
    if (aborted) return cb(null);
    if (!data) return cb({});
    try {
      cb(JSON.parse(data));
    } catch (e) {
      console.log(`[jarvis] readJsonBody JSON parse failed:`, e);
      cb(null);
    }
  });
  req.on("error", () => cb(null));
}

export async function startRemote(opts: {
  port?: number;
  ttlMs?: number;
  onStop?: () => void;
  /** The phone app's relay (echo-remote on Render): reachable from any network. */
  relay?: { url: string; secret: string };
  /** Host-side transcription dependency; never selectable by an HTTP request. */
  transcribeVoice?: (path: string) => Promise<string>;
} = {}): Promise<StartResult> {
  if (running) {
    return { ok: true, url: remoteUrl(currentPort) ?? undefined, message: "The remote is already running." };
  }
  const pref = preferredHost();
  const useRelay = !!(opts.relay?.url && opts.relay.secret);
  if (!pref && !useRelay) {
    return { ok: false, message: "I can't find a network address — is this machine on Wi-Fi or Tailscale?" };
  }
  // Full control from a phone with no password is a door with no lock. Refuse.
  if (!hasPassword()) {
    return {
      ok: false,
      message: "Set a remote password first — I won't open control of the machine without one.",
    };
  }

  const http = await import("node:http");

  const port = opts.port ?? 7717;
  // The SAME token every time, so the link can be saved on the phone once and
  // reused forever. The password is what actually guards control.
  token = getStableToken();
  onStop = opts.onStop ?? null;
  items.length = 0;
  resetAttempts();
  sessions.revokeAll(); // a restart re-authenticates everyone
  signalling.reset();
  confirmRelay.cancel();

  const handle = (req: any, res: any) => {
    // Through the phone app every request is replayed by the relay agent on
    // the loopback, and the phone's real address rides in a header. That
    // header is believed only on the loopback listener: on the LAN listener
    // anyone could send it to dodge the lockout.
    const forwarded = /127\.0\.0\.1$/.test(req.socket?.localAddress ?? "") ? req.headers?.[CLIENT_IP_HEADER] : undefined;
    const viaApp = typeof forwarded === "string" && forwarded.length > 0;
    const ip = viaApp ? forwarded : req.socket?.remoteAddress ?? "?";
    const route = routeOf(req.url);
    // The path only: the query carries the link token and the session, which
    // do not belong in a log. Polls are left out, or they would bury the rest.
    if (!["status", "confirm-poll", "events", "rtc-answer", "frame", "asset", "mouse"].includes(route)) {
      console.log(`[jarvis] HTTP ${req.method} ${(req.url ?? "").split("?")[0]} -> route=${route}${viaApp ? " (phone app)" : ""}`);
    }

    // Never let a page on another site drive this, and never let it be framed.
    const secure = {
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "connection": "close",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'",
    };

    // Anything without the right LINK TOKEN is indistinguishable from a path
    // that does not exist. No headers, no hint, no difference in shape.
    const deny = () => {
      noteBadAttempt(ip);
      res.writeHead(404, { "content-type": "text/plain", ...secure });
      res.end("Not found");
    };
    const json = (obj: any, code = 200, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...secure, ...extra });
      res.end(JSON.stringify(obj));
    };

    if (isLockedOut(ip)) return deny();
    if (!tokenMatches(token, tokenFrom(req.url))) return deny();
    if (route === "unknown") return deny();

    // ---- routes reachable with only the link token ----
    if (route === "page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...secure });
      return res.end(renderPage(token));
    }
    if (route === "asset") {
      // The login screen needs its stylesheet, script and reactor before any
      // password, so assets sit behind the link token only. ASSET_NAME already
      // refused anything with a slash or a dot-dot in it.
      const name = (req.url ?? "").split("?")[0].slice("/app/".length);
      const file = join(remoteAssetDir(), name);
      if (req.method !== "GET" || !existsSync(file)) return deny();
      res.writeHead(200, {
        "content-type": ASSET_TYPES[name.split(".").pop()!] ?? "application/octet-stream",
        ...secure,
        "cache-control": "private, max-age=3600",
      });
      return res.end(readFileSync(file));
    }
    if (route === "ping") {
      // Token-gated like everything else, so it reveals nothing without the link.
      res.writeHead(204, secure);
      return res.end();
    }
    if (route === "login") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        if (!verifyPassword(String(body?.password ?? ""))) {
          // A wrong PASSWORD (they have the link) counts toward lockout, then a
          // plain 401 — they have already proven they hold the link.
          noteBadAttempt(ip);
          return json({ ok: false }, 401);
        }
        return signIn("password", body?.device);
      });
    }
    // Bound to the address on a LAN, where it stays put. Not through the phone
    // app: a phone on mobile data changes address between cell towers, and
    // https already keeps the session from being sniffed.
    function signIn(how: string, device?: unknown) {
      const s = sessions.issue(viaApp ? "?" : ip);
      badAttempts.delete(ip); // a correct sign-in clears this address's strikes
      record(how === "faceid" ? "A phone signed in with Face ID" : "A phone signed in", "go");
      return json({ ok: true, s, cloudPass: viaApp ? issuePass(device) : undefined }, 200, {
        "set-cookie": `js=${s}; Path=/; HttpOnly; SameSite=Strict${viaApp ? "; Secure" : ""}`,
      });
    }
    // ---- Face ID (passkeys): only through the phone app, which is https ----
    if (route === "passkey-options" || route === "passkey-login" || route === "passkey-register") {
      if (!appSite) return json({ error: "Face ID works in the Echo app, not on this link." }, 400);
      const site = appSite;
      const signedIn = sessions.valid(sessionFrom(req.headers?.cookie, req.url), ip);
      if (route === "passkey-options") {
        const purpose = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("purpose");
        if (purpose !== "login" && purpose !== "register" && purpose !== "confirm") return json({ error: "purpose?" }, 400);
        // Registering a new Face ID, or confirming an action, needs you signed in already.
        if (purpose !== "login" && !signedIn) return json({ error: "unauthorized" }, 401);
        if (purpose !== "register" && keys().count === 0) return json({ error: "Face ID isn't set up yet. Sign in with your password, then turn it on in Settings." }, 409);
        return json(keys().options(purpose, site.rpId));
      }
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        try {
          if (route === "passkey-register") {
            if (!signedIn) return json({ error: "unauthorized" }, 401);
            keys().register(body?.credential, site.origin, site.rpId, String(body?.name ?? "iPhone"));
            record("Face ID turned on for a phone", "go");
            return json({ ok: true, count: keys().count });
          }
          keys().verify(body?.credential, site.origin, site.rpId, "login");
          return signIn("faceid", body?.device);
        } catch (e: any) {
          if (route === "passkey-login") noteBadAttempt(ip);
          return json({ ok: false, error: String(e?.message ?? e) }, 401);
        }
      });
    }

    // ---- everything past here needs a valid PASSWORD SESSION ----
    // This is the line that actually enforces "the password guards control".
    // With it commented out, anyone holding the link could drive the machine
    // without ever proving the password — the whole security model rests here.
    const sess = sessionFrom(req.headers?.cookie, req.url);
    if (!sessions.valid(sess, ip)) return json({ error: "unauthorized" }, 401);

    if (route === "events") {
      const since = parseInt(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("since") ?? "0", 10);
      // The whole {items, nextIndex} shape, so the phone knows where to resume.
      return json(recentItems(Number.isFinite(since) ? since : 0));
    }
    if (route === "log") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        console.error("[jarvis] phone JS error:", body);
        return json({ ok: true });
      });
    }
    if (route === "stop") {
      if (req.method !== "POST") return deny();
      record("Stopped from your phone", "stop");
      try {
        (onStop ?? interruptHandler)?.();
      } catch {
        /* stopping must never throw back at the network */
      }
      return json({ stopped: true });
    }
    if (route === "mouse") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, async (body) => {
        try {
          const action = body?.action;
          const step = (n: unknown) => Math.max(-400, Math.min(400, Number(n) || 0));
          if (action === "move") queueMove(step(body.dx), step(body.dy));
          else if (action === "click") await clickHere("left");
          else if (action === "rclick") await clickHere("right");
          else if (action === "dclick") await clickHere("double");
          else if (action === "scroll-up" || action === "scroll-down") await scroll(action === "scroll-up" ? "up" : "down", 3);
          // The arrow pad of the old page, kept so a stale tab keeps working.
          else if (action === "up") queueMove(0, -40);
          else if (action === "down") queueMove(0, 40);
          else if (action === "left") queueMove(-40, 0);
          else if (action === "right") queueMove(40, 0);
          else return json({ ok: false }, 400);
          return json({ ok: true });
        } catch {
          return json({ ok: false }, 500);
        }
      });
    }
    if (route === "keys") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, async (body) => {
        try {
          if (typeof body?.text === "string") {
            const text = body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
            if (!text || text.length > MAX_TYPED) return json({ ok: false, reason: `Type 1–${MAX_TYPED} characters.` }, 400);
            await typeText(text);
            record(`Typed ${text.length} characters on the Mac from your phone`, "go");
            return json({ ok: true });
          }
          const chord = REMOTE_KEYS[String(body?.key ?? "")];
          if (!chord) return json({ ok: false }, 400);
          await hotkey(chord[0], chord[1]);
          return json({ ok: true });
        } catch {
          return json({ ok: false }, 500);
        }
      });
    }
    if (route === "status") {
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const after = Number(query.get("logs") ?? "0");
      // The phone renews its cloud pass from here while the Mac is reachable.
      const cloudPass = viaApp && query.get("pass") ? issuePass(query.get("pass")) : undefined;
      void (async () => {
        try {
          const [core, vitals] = await Promise.all([
            Promise.resolve(statusProvider?.(Number.isFinite(after) ? after : 0) ?? {}),
            readVitals(),
          ]);
          json({ ...core, vitals, remote: { startedAt, expiresAt: expiresAt || null, host: preferredHost()?.kind ?? null },
            faceId: { available: !!appSite, registered: appSite ? keys().count : 0 }, ...(cloudPass ? { cloudPass } : {}) });
        } catch (e: any) {
          json({ error: String(e?.message ?? e) }, 500);
        }
      })();
      return;
    }
    if (route === "action") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, async (body) => {
        const action = parseRemoteAction(body);
        if (!action || !actionHandler) return json({ ok: false, message: "That control isn't available from the phone." }, 400);
        // Powering Echo off needs Face ID right now, not just a signed-in phone:
        // a phone left unlocked on a table should not be able to switch it off.
        if (action.type === "power-off") {
          if (!appSite) return json({ ok: false, message: "Power off needs Face ID in the Echo app." }, 403);
          try { keys().verify(body.assertion, appSite.origin, appSite.rpId, "confirm"); }
          catch (e: any) { return json({ ok: false, message: String(e?.message ?? e) }, 403); }
        }
        try {
          const result = await actionHandler(action);
          record(`Phone: ${action.type}${result.message ? ` — ${result.message}` : ""}`, result.ok ? "go" : "stop");
          return json(result);
        } catch (e: any) {
          return json({ ok: false, message: String(e?.message ?? e) }, 500);
        }
      });
    }
    if (route === "chat") {
      if (req.method === "GET") {
        const since = Number(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("since") ?? "0");
        return json({ messages: chat().since(Number.isFinite(since) ? since : 0), typing: chat().typing() });
      }
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const norm = normaliseCommand(body?.text);
        if (!norm.ok) return json({ ok: false, reason: norm.reason }, 400);
        const message = chat().add("you", norm.text);
        chat().setTyping(true);
        try { chatHandler?.(norm.text, "typed"); } catch { /* a bad message must not crash the server */ }
        return json({ ok: true, message });
      });
    }
    if (route === "chat-import") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const list = Array.isArray(body?.messages) ? body.messages.slice(0, 200) : [];
        const imported = chat().importFromPhone(list);
        if (imported) record(`Phone mode: ${imported} message${imported === 1 ? "" : "s"} from while the Mac was away`, "go");
        return json({ ok: true, imported });
      });
    }
    if (route === "frame") {
      if (req.method !== "GET") return deny();
      void screenFrame()
        .then((jpeg) => {
          res.writeHead(200, { "content-type": "image/jpeg", ...secure });
          res.end(jpeg);
        })
        .catch((e: any) => json({ error: String(e?.message ?? e) }, 503));
      return;
    }
    if (route === "signout-all") {
      if (req.method !== "POST") return deny();
      sessions.revokeAll();
      passGen().bump(); // and every Phone mode pass: the relay hears on Echo's next poll
      record("Every phone was signed out", "stop");
      return json({ ok: true });
    }
    if (route === "close") {
      if (req.method !== "POST") return deny();
      record("Remote closed from your phone", "stop");
      json({ ok: true });
      setTimeout(() => void stopRemote(), 150);
      return;
    }
    if (route === "command") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {

        const norm = normaliseCommand(body?.text);
        if (!norm.ok) return json({ ok: false, reason: norm.reason }, 400);
        const via = body?.via === "voice" ? "voice" : "typed";
        record(`You (phone): ${norm.text}`, "go");
        try {
          commandHandler?.(norm.text, via);
        } catch {
          /* a bad command must not crash the server */
        }
        return json({ ok: true });
      });
    }
    if (route === "voice" || route === "chat-voice") {
      if (req.method !== "POST") return deny();
      const transcribe = opts.transcribeVoice ?? (async (path: string) => {
        const { transcribe } = await import("../voice/stt.js");
        const { activeConfig } = await import("../config.js");
        return transcribe(path, activeConfig(getAppPath()));
      });
      void (async () => {
        try {
          const text = await transcribeRemoteVoice(req, transcribe);
          // A timed-out or cancelled upload must never start a late command.
          if (res.destroyed || res.writableEnded) return;
          const handler = route === "chat-voice" ? chatHandler : commandHandler;
          if (!handler) return json({ ok: false, error: "Echo's brain is still starting. Try again shortly.", code: "voice_not_ready" }, 503);
          if (route === "chat-voice") {
            const message = chat().add("you", text, "voice");
            chat().setTyping(true);
            try { handler(text, "voice"); } catch (error) { chat().setTyping(false); throw error; }
            return json({ ok: true, message, text });
          }
          record(`You (phone): ${text}`, "go");
          handler(text, "voice");
          remoteLog("phone voice transcribed and delivered to the brain");
          return json({ ok: true, text });
        } catch (error) {
          if (res.destroyed || res.writableEnded) return;
          const status = error instanceof RemoteVoiceError ? error.status : 503;
          const code = error instanceof RemoteVoiceError ? error.code : "voice_transcription_failed";
          // Provider errors can contain private paths or keys; keep them local.
          remoteLog(`phone voice failed (${code})`);
          console.error("[jarvis] remote voice failed:", error);
          return json({ ok: false, code, error: error instanceof RemoteVoiceError ? error.message : "Your Mac couldn't transcribe the recording. Check its speech-recognition settings and try again." }, status);
        }
      })();
      return;
    }
    if (route === "confirm") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const id = String(body?.id ?? "");
        const approved = body?.approved === true;
        const matched = confirmRelay.answer(id, approved);
        return json({ ok: matched });
      });
    }
    if (route === "confirm-poll") {
      return json({ pending: confirmRelay.current() });
    }
    if (route === "rtc-offer") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const sdp = body?.sdp;
        if (!sdp || (sdp.type !== "offer") || typeof sdp.sdp !== "string") {
          return json({ ok: false }, 400);
        }
        const generation = signalling.setOffer(sdp as Sdp);
        return json({ ok: true, generation });
      });
    }
    if (route === "rtc-answer") {
      // The phone polls this for the Mac's answer and the Mac's ICE trickle.
      return json({ answer: signalling.getAnswer(), ice: signalling.drainCandidates("phone") });
    }
    if (route === "rtc-ice-phone") {
      if (req.method !== "POST") return deny();
      return readJsonBody(req, (body) => {
        const c = body?.candidate;
        if (c && typeof c.candidate === "string") signalling.addCandidate("phone", c as IceCandidate);
        return json({ ok: true });
      });
    }
    return deny();
  };
  // The LAN or Tailscale listener, bound to that one address rather than every
  // interface, and with the phone app a second one on the loopback for the
  // relay agent to replay requests against. Nothing listens anywhere else.
  server = pref ? http.createServer(handle) : null;
  loopServer = useRelay ? http.createServer(handle) : null;

  currentPort = port;
  return new Promise<StartResult>((resolve) => {
    const listeners = [server, loopServer].filter(Boolean);
    let waiting = listeners.length;
    let failed = false;
    const fail = (err: any) => {
      if (failed) return;
      failed = true;
      running = false;
      for (const l of listeners) { try { l.close(); } catch { /* not listening */ } }
      server = loopServer = null;
      resolve({
        ok: false,
        message:
          err?.code === "EADDRINUSE"
            ? `Port ${port} is already in use.`
            : `I couldn't start the remote: ${err?.message ?? err}`,
      });
    };
    const ready = async () => {
      if (failed || --waiting > 0) return;
      running = true;
      startedAt = Date.now();
      const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
      // ttl of 0 means "always on" — no auto-close. Otherwise, forgetting to
      // turn it off must not leave a port open indefinitely.
      expiry = ttl > 0 ? setTimeout(() => void stopRemote(), ttl) : null;
      expiresAt = ttl > 0 ? Date.now() + ttl : 0;
      record("Remote opened", "go");
      if (useRelay) {
        const site = new URL(opts.relay!.url);
        appSite = { origin: site.origin, rpId: site.hostname };
        relaySecret = opts.relay!.secret;
        relay = new RelayAgent(opts.relay!.url, opts.relay!.secret, `http://127.0.0.1:${port}`, (connected) => {
          relayBase = connected ? relay!.base : null;
          if (connected && !digestTimer) scheduleDigest(60_000);
          if (connected) scheduleHandoffs(5_000);
          record(connected ? "Phone app connected" : "Phone app disconnected — reconnecting", connected ? "go" : "stop");
          try { publicUrlListener?.(connected ? `${relay!.base}/?t=${token}` : null); } catch { /* a listener must not break the agent */ }
        }, remoteLog, { get: () => passGen().get(), adopt: (n) => passGen().adopt(n) }, () => scheduleHandoffs(2_000));
        relay.start();
      }
      const life = ttl > 0 ? "Reopen the remote if it's been closed." : "It stays on, even across restarts.";
      const reach = useRelay
        ? `Open your Echo app (${opts.relay!.url.replace(/\/+$/, "")}) on your phone from any network`
        : pref?.kind === "tailscale"
          ? "Open this on your phone from anywhere (both on your Tailscale)"
          : "Open this on your phone (same Wi-Fi)";
      const lasting = "This link is permanent — save it on your phone and sign in with your password any time.";
      resolve({
        ok: true,
        url: remoteUrl(port) ?? undefined,
        message: `${reach}: ${remoteUrl(port)}\n${lasting} ${life}`,
      });
    };
    for (const l of listeners) l.once("error", fail);
    server?.listen(port, pref!.host, ready);
    loopServer?.listen(port, "127.0.0.1", ready);
  });
}

let currentPort = 7717;

export async function stopRemote(): Promise<string> {
  if (!running) return "The remote isn't running.";
  running = false;
  if (expiry) {
    clearTimeout(expiry);
    expiry = null;
  }
  expiresAt = 0;
  // A new token next time, so the old link is dead the moment this closes.
  token = "";
  onStop = null;
  // Everyone signed out, the WebRTC mailbox emptied, any pending confirmation
  // denied — closing the remote leaves nothing behind that could still act.
  sessions.revokeAll();
  signalling.reset();
  confirmRelay.cancel();
  relay?.stop();
  relay = null;
  relayBase = null;
  appSite = null;
  relaySecret = null;
  if (digestTimer) { clearTimeout(digestTimer); digestTimer = null; }
  if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null; }
  chatLog?.setTyping(false);
  await Promise.all([server, loopServer].filter(Boolean).map((l: any) => new Promise<void>((resolve) => {
    try {
      l.close(() => resolve());
      // close() waits for open connections; the phone polls, so force it.
      l.closeAllConnections?.();
    } catch {
      resolve();
    }
  })));
  server = null;
  loopServer = null;
  return "Remote closed. That link won't work again.";
}

export function remoteStatus(): string {
  if (!running) return "The phone remote is off.";
  const mins = Math.round((Date.now() - startedAt) / 60_000);
  return `Remote has been open ${mins} minute${mins === 1 ? "" : "s"} at ${remoteUrl(currentPort)}`;
}

/** The current link (with its live token), or null when the remote is off. */
export function currentRemoteUrl(): string | null {
  return running ? remoteUrl(currentPort) : null;
}

/** Authenticated fixed-purpose owner updates; no new remote control surface. */
export async function phoneUpdateInventory() { return relay?.get('/agent/updates') ?? null; }
export async function sendPhoneUpdate(event:import('./phone-updates.js').PhoneUpdate) { return relay?.postJson('/agent/updates',event) ?? null; }
