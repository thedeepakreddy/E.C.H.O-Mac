import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { getControlWeather, type ControlWeatherRequest } from "./control-weather.js";
import { getControlWorld } from "./control-world.js";
import type { MissionState } from "./frontier/swarm.js";
import type { JarvisConfig } from "./config.js";
import { KEY_FIELDS, keyStatus, keysPath } from "./keystore.js";
import { listFleet, grantableTools, MAX_CUSTOM as FLEET_MAX_CUSTOM } from "./frontier/fleet.js";
import { recentIntel } from "./tools/intel-feeds.js";

const nodeRequire = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export type ControlTaskStatus = "working" | "queued" | "done" | "failed" | "stopped";
export interface ControlTask {
  id: string; title: string; status: ControlTaskStatus; agent: string;
  startedAt: number; finishedAt?: number; privateMode?: boolean;
}
export interface ControlLog { id: number; at: number; kind: string; text: string }
export interface ControlSettings {
  // Derived, not repeated. This union lived in three files and they drifted
  // the moment a fifth brain arrived; config.ts is the one that decides.
  brain: JarvisConfig["brain"];
  voice: {
    ttsEnabled: boolean; wakeWord: boolean; conversationMode: boolean; bargeIn: boolean;
    sttStreaming: boolean; ttsStreaming: boolean; sendAudioToBrain: boolean;
    sttProvider: "whisper" | "sarvam" | "apple"; sttLanguage: string;
    ttsEngine: "mac" | "fakeyou" | "elevenlabs" | "sarvam" | "gemini" | "piper" | "vibevoice";
    vibeVoiceUrl?: string;
    vibeVoiceSpeaker?: string;
    maxSpokenSentences: number; conversationWindowMs: number;
  };
  hud: { startListeningOnLaunch: boolean };
  memory: { enabled: boolean; cloudRecall: boolean; retentionDays: number };
  helpers: { shadow: boolean; ghost: boolean; autoDebug: boolean; shadowIntervalSeconds: number };
  dreaming: { enabled: boolean };
  learning: { enabled: boolean; captureScreens: boolean; maxStepsPerTurn: number };
  configPath: string;
}
export interface ControlAction {
  type: "phone-updates" | "memory-save" | "memory-forget" | "answer-approval" | "answer-project" | "retry-work" | "command" | "listen" | "interrupt" | "toggle-voice" | "settings" | "neural" | "osiris" |
    "refresh-connections" | "switch-model" | "spawn-agent" | "assign-agent" | "api-keys" | "save-settings" |
    "save-api-keys" | "run-board" | "run-fleet-agent" | "stop-mission" | "stop-mission-task" |
    "delete-mission" |
    "save-agent" | "remove-agent" | "shutdown" |
    "chatgpt-sign-in" | "chatgpt-cancel-sign-in" | "chatgpt-sign-out" |
    "openrouter-sign-in" | "openrouter-sign-out" | "openrouter-set-model";
  projectId?:string; id?:string; revision?:number; questionId?:string; approved?:boolean; enabled?:boolean; kind?:string;
  text?: string; goal?: string; provider?: string; name?: string;
  settings?: Partial<ControlSettings>;
  /** For save-api-keys: env var name -> new value. A blank/omitted value leaves that key unchanged. */
  apiKeys?: Record<string, string>;
  /** For run-board: which fleet member ids get the task. */
  agentIds?: string[];
  /** For stop-mission / stop-mission-task / delete-mission. */
  missionId?: string;
  /** For save-agent: the fleet member being added or updated. */
  agent?: { id: string; name: string; description: string; brief: string; tier: string; tools: string[] };
}
export interface ControlResult { ok: boolean; message?: string; data?: Record<string, unknown> }
export interface ControlRuntime {
  voiceEnabled: boolean;
  agents: Array<{ id: string; name: string; goal: string; status: string; startedAt: number; progress: string;
    missionId?: string; agentTaskId?: string; lane?: "knowledge" | "gui" }>;
  missions: MissionState[];
  settings: ControlSettings;
  models: Array<{
    id: string; label: string; model: string; active: boolean; available: boolean; reason?: string;
    /** OpenAI only: how it pays, and the ChatGPT sign-in state. */
    account?: {
      billing: "chatgpt" | "apiKey" | "none";
      chatgpt: { status: string; planUsage: boolean; email?: string; error?: string };
    };
    /**
     * OpenRouter only: the models it can be switched to, and whether it has a
     * key. The list is fetched live rather than hardcoded — OpenRouter retires
     * free tiers without notice, and a picker offering a model that no longer
     * exists is worse than no picker.
     */
    catalogue?: {
      signedIn: boolean;
      models: Array<{ id: string; label: string; contextLength: number }>;
      note?: string;
    };
  }>;
  connections: Array<{ name: string; status: string; tools: number | null; error?: string; lastActivityAt?: number }>;
}

/** Session observations only: no fabricated traffic, tasks, or model usage. */
export class ControlTelemetry {
  readonly sessionStartedAt = Date.now();
  state: Record<string, unknown> = { status: "idle" };
  logs: ControlLog[] = [];
  tasks: ControlTask[] = [];
  commands = 0;
  toolCalls = 0;
  errors = 0;
  completedTasks = 0;
  private sequence = 0;
  private taskSequence = 0;
  private mcpActivity = new Map<string, number>();
  /**
   * Bumped on every mutation of `logs`/`tasks`. The renderer's dirty-check used
   * to `JSON.stringify` the full arrays on every refresh tick to decide whether
   * to re-render — paying for the content on every tick whether or not it had
   * changed. A plain counter is a single number to compare instead.
   */
  logRevision = 0;
  taskRevision = 0;

  observe(channel: string, payload: any): void {
    if (channel === "state") this.state = { ...this.state, ...payload };
    if (channel === "message" && typeof payload?.text === "string") {
      const kind = String(payload.kind ?? "info");
      if (kind === "user") this.commands++;
      this.log(kind, payload.text);
    }
    if (channel === "notice" && typeof payload?.text === "string") {
      if (payload.level === "error") this.errors++;
      this.log(String(payload.level ?? "info"), payload.text);
    }
  }
  log(kind: string, text: string): void {
    this.logRevision++;
    // The panel only ever shows one truncated, single-line preview per entry
    // (see .activity-copy in control-panel.css — nowrap + ellipsis); nothing
    // else reads controlTelemetry.logs. The old 12000-char cap meant a single
    // long assistant reply or tool result could sit in memory at ~12KB, times
    // up to 240 entries — and that whole array got JSON.stringify'd by the
    // renderer's dirty-check on every refresh tick. 500 is generous for a
    // preview line and cuts the worst case by ~24x.
    this.logs.push({ id: ++this.sequence, at: Date.now(), kind, text: text.slice(0, 500) });
    if (this.logs.length > 240) this.logs.splice(0, this.logs.length - 240);
  }
  tool(name: string): void {
    this.toolCalls++;
    const server = /^mcp__([^]+?)__/.exec(name)?.[1];
    if (server) this.mcpActivity.set(server, Date.now());
  }
  connectionActivity(name: string): number | undefined {
    return this.mcpActivity.get(name.replace(/[^a-zA-Z0-9_]/g, "_"));
  }
  beginTask(title: string, agent = "Echo", privateMode = false): string {
    this.taskRevision++;
    const id = `session-${++this.taskSequence}`;
    this.tasks.push({ id, title: title.slice(0, 2000), agent, privateMode, startedAt: Date.now(),
      status: this.tasks.some((task) => task.agent === agent && task.status === "working") ? "queued" : "working" });
    // Retain active work, and the most recent sixty finished turns.
    const finished = this.tasks.filter((task) => task.finishedAt);
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - 60)).map((task) => task.id));
    this.tasks = this.tasks.filter((task) => !drop.has(task.id));
    return id;
  }
  finishTask(status: "done" | "failed" | "stopped", agent = "Echo"): void {
    const task = this.tasks.find((item) => item.agent === agent && item.status === "working");
    if (!task) return;
    this.taskRevision++;
    task.status = status;
    task.finishedAt = Date.now();
    if (status === "done") this.completedTasks++;
    const queued = this.tasks.find((item) => item.agent === agent && item.status === "queued");
    if (queued) queued.status = "working";
  }
  stopMainTasks(): void {
    let changed = false;
    for (const task of this.tasks) {
      if (task.agent === "Echo" && (task.status === "working" || task.status === "queued")) {
        task.status = "stopped"; task.finishedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.taskRevision++;
  }
  snapshot(runtime: ControlRuntime) {
    return { ...runtime, state: this.state, sessionStartedAt: this.sessionStartedAt, intel: recentIntel(),
      logs: this.logs, tasks: this.tasks, logRevision: this.logRevision, taskRevision: this.taskRevision,
      analytics: { commands: this.commands, toolCalls: this.toolCalls, errors: this.errors,
        completedTasks: this.completedTasks, uptimeSeconds: Math.floor((Date.now() - this.sessionStartedAt) / 1000) } };
  }
}

export const controlTelemetry = new ControlTelemetry();
let panel: BrowserWindow | null = null;
let runtime: (() => ControlRuntime) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;

export function publishControlUpdate(): void {
  if (!panel || panel.isDestroyed() || !panel.isVisible() || panel.isMinimized() || publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    if (panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized() && runtime) panel.webContents.send("control:update", controlTelemetry.snapshot(runtime()));
  }, 150);
}

export function observeControlEvent(channel: string, payload: unknown): void {
  controlTelemetry.observe(channel, payload);
  if (panel && !panel.isDestroyed() && (channel === "state" || channel === "level")) {
    panel.webContents.send(channel, payload);
  }
  if (channel !== "level") publishControlUpdate();
}

export function openControlPanel(anchor?: BrowserWindow | null): void {
  const { BrowserWindow, screen } = nodeRequire("electron") as typeof import("electron");
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  const display = anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(1180, Math.max(320, area.width - 48));
  const height = Math.min(760, Math.max(320, area.height - 48));
  panel = new BrowserWindow({ width, height,
    x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
    title: "ECHO — Intelligence Control", frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, fullscreenable: false, roundedCorners: true, show: false,
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); closeControlPanel(); }
  });
  panel.once("ready-to-show", () => { panel?.show(); panel?.focus(); publishControlUpdate(); });
  panel.on("restore", publishControlUpdate);
  panel.on("show", publishControlUpdate);
  panel.on("closed", () => {
    panel = null;
    if (refreshTimer) clearInterval(refreshTimer);
    if (publishTimer) clearTimeout(publishTimer);
    refreshTimer = null; publishTimer = null;
  });
  // Runtime events publish immediately. This slow heartbeat only keeps
  // time-based labels fresh when an idle session has no events at all.
  refreshTimer = setInterval(publishControlUpdate, 15_000);
  refreshTimer.unref();
  void panel.loadFile(join(here, "..", "renderer", "control-panel.html"));
}

export function closeControlPanel(): void {
  if (panel && !panel.isDestroyed()) panel.close();
}

function authorized(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!panel && !panel.isDestroyed() && event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame;
}

export function wireControlPanel(deps: {
  runtime: () => ControlRuntime;
  action: (action: ControlAction) => Promise<ControlResult>;
  companion?: (request?:{query?:string;memory?:boolean})=>unknown;
}): void {
  runtime = deps.runtime;
  const { ipcMain } = nodeRequire("electron") as typeof import("electron");
  ipcMain.handle("control:snapshot", (event) => {
    if (!authorized(event)) throw new Error("Only the control panel can read its session.");
    return controlTelemetry.snapshot(deps.runtime());
  });
  ipcMain.handle("control:action", async (event, input: unknown) => {
    if (!authorized(event)) return { ok: false, message: "Untrusted control-panel sender." };
    if (!input || typeof input !== "object" || typeof (input as any).type !== "string") return { ok: false, message: "Invalid action." };
    try {
      const result = await deps.action(input as ControlAction);
      publishControlUpdate();
      return result;
    } catch (error: any) {
      const message = String(error?.message ?? error);
      controlTelemetry.observe("notice", { level: "error", text: message });
      publishControlUpdate();
      return { ok: false, message };
    }
  });
  ipcMain.handle("control:weather", (event, request?: ControlWeatherRequest) => {
    if (!authorized(event)) throw new Error("Untrusted control-panel sender.");
    return getControlWeather(request);
  });
  ipcMain.handle('control:companion',(event,request?:{query?:string;memory?:boolean})=>{
    if(!authorized(event))throw new Error('Untrusted control-panel sender.');
    if(request && (typeof request!=='object'||Array.isArray(request)||request.memory!==undefined&&typeof request.memory!=='boolean'||request.query!==undefined&&typeof request.query!=='string'||request.query&&request.query.length>500))throw new Error('Invalid search.');
    return deps.companion?.(request)??null;
  });
  ipcMain.handle("control:world", (event) => {
    if (!authorized(event)) throw new Error("Untrusted control-panel sender.");
    return getControlWorld();
  });
  ipcMain.handle("control:fleet", (event) => {
    if (!authorized(event)) throw new Error("Untrusted control-panel sender.");
    return { members: listFleet(), grantableTools: grantableTools(), maxCustom: FLEET_MAX_CUSTOM };
  });
  ipcMain.handle("control:api-keys", (event) => {
    if (!authorized(event)) throw new Error("Untrusted control-panel sender.");
    // Presence only, never a stored value — see keystore.ts's KEY_FIELDS/keyStatus.
    // Continuous telemetry (control:update) never carries this; it is fetched
    // only when the API-keys panel is actually opened.
    return {
      fields: KEY_FIELDS.map((f) => ({ env: f.env, label: f.label, help: f.help, url: f.url, optional: f.optional })),
      status: keyStatus(),
      path: keysPath,
    };
  });
  ipcMain.on("control:close", (event) => { if (authorized(event)) closeControlPanel(); });
  // Diagnostic for the "the panel got slow" reports a code-reading pass
  // couldn't reproduce: the renderer reports its own dropped compositor
  // frames, which the main process's own event-loop-lag check (main.ts)
  // cannot see — that one only catches the JS thread blocking, not GPU or
  // compositor backlog from something like Osiris's WebGL globe competing
  // for the same shared GPU process. Remove once the cause is found.
  ipcMain.on("control:perf", (event, payload: { droppedMs?: number } | undefined) => {
    if (!authorized(event) || !payload) return;
    console.warn(`[perf] control panel renderer dropped a frame by ~${Math.round(payload.droppedMs ?? 0)}ms`);
  });
  ipcMain.on("control:open-url", (event, url: unknown) => {
    // Only ever hand a real https link to the OS — same rule setup.ts uses for
    // the same reason: the panel must never be a way to launch an arbitrary
    // scheme or a local file path.
    if (authorized(event) && typeof url === "string" && /^https:\/\//.test(url)) {
      const { shell } = nodeRequire("electron") as typeof import("electron");
      shell.openExternal(url);
    }
  });
}
