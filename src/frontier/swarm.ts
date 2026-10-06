import { sendToOverlay } from "../overlay.js";
import { randomUUID } from "node:crypto";
import { loopLogRoot } from "../agent-replay/runtime.js";
import { nextCloneNumber, type RecoveryCheckpoint } from "../agent-replay/recovery.js";
import type { AgentIdentity } from "../agent-replay/context.js";
import {
  taskCoordinator,
  type TaskCoordinator,
  type TaskResult,
  type TaskResultStatus,
} from "../memory/task-state.js";
import { getFleetMember } from "./fleet.js";
import {desktopTaskBusy} from '../tasks/desktop-lane.js';
import {shutdownStep} from '../shutdown.js';

/**
 * The clone swarm: background sub-agents working in parallel.
 *
 * This used to be a scaffold that faked workers with timers, while the real
 * spawning lived inline in the `spawn_subagent` tool. Now this is the single
 * home for it — a sub-agent is an in-process brain (via createBrain), not an OS
 * worker thread, because that is what actually works and is what the tool was
 * already doing.
 *
 * Two honest limits are enforced here:
 *   - A concurrency CAP. Each clone can drive the mouse and keyboard, and there
 *     is only one of each, so an unbounded swarm would trample the user. Beyond
 *     the cap, spawning is refused rather than queued.
 *   - Clones are tracked and cleaned up on completion, so the overlay shows a
 *     true picture and finished brains do not leak.
 *
 * The manager takes its dependencies (how to make a brain, how to broadcast)
 * as arguments, so the whole thing tests without Electron or a real model.
 */

export type CloneStatus = "working" | "done" | "failed";
export type AgentTaskLane = "knowledge" | "gui";

export interface AgentTaskBudget {
  timeoutMs: number;
  maxIterations: number;
  maxRecoveryAttempts: number;
}

export const DEFAULT_AGENT_TASK_BUDGET: Readonly<AgentTaskBudget> = Object.freeze({
  timeoutMs: 10 * 60_000,
  maxIterations: 50,
  maxRecoveryAttempts: 2,
});

export interface AgentTaskSpec {
  id: string;
  goal: string;
  dependsOn?: string[];
  lane?: AgentTaskLane;
  acceptanceCriteria?: string[];
  profile?: string;
  budget?: Partial<AgentTaskBudget>;
}

export interface MissionSpec {
  id?: string;
  goal: string;
  tasks: AgentTaskSpec[];
  scope?: Record<string, unknown>;
}

export type MissionTaskStatus = "pending" | "working" | TaskResultStatus;

export interface MissionTaskState extends AgentTaskSpec {
  lane: AgentTaskLane;
  budget: AgentTaskBudget;
  status: MissionTaskStatus;
  recoveryAttempts: number;
  taskId?: string;
  actorId?: string;
  actorName?: string;
  startedAt?: number;
  result?: TaskResult;
}

export type MissionStatus = "running" | TaskResultStatus;

export interface MissionState {
  schemaVersion: 1;
  id: string;
  taskId: string;
  goal: string;
  status: MissionStatus;
  scope: Record<string, unknown>;
  tasks: Record<string, MissionTaskState>;
  createdAt: number;
  updatedAt: number;
  result?: TaskResult;
}

export interface SwarmClone {
  id: string;
  name: string;
  goal: string;
  status: CloneStatus;
  startedAt: number;
  progress: string;
  missionId?: string;
  agentTaskId?: string;
  lane?: AgentTaskLane;
}

/** The slice of a brain a clone needs. Structural, so a fake satisfies it in tests. */
export interface CloneBrain {
  on(event: "text" | "turnEnd" | "error", cb: (arg?: any) => void): unknown;
  send(text: string, audio?: unknown, opts?: Record<string, unknown>): void;
  interrupt?(): void;
  stop?(): Promise<void>;
  recoverFromCheckpoint?(checkpoint: RecoveryCheckpoint): boolean;
}

export interface SwarmDeps {
  /** Make a fresh background brain for one clone. */
  makeBrain: (identity: AgentIdentity, task?: MissionTaskState) => CloneBrain;
  coordinator?: TaskCoordinator;
  /** Push the current roster to the UI. Defaults to the overlay. */
  broadcast?: (clones: Array<{ name: string; progress: string }>) => void;
  now?: () => number;
}

/** At most this many clones at once — they share one mouse and keyboard. */
export const MAX_CONCURRENT_CLONES = 4;

const systemPrompt = (name: string, goal: string) =>
  `[SYSTEM: You are ${name}, an Echo agent working quietly in the background.] Your goal: ${goal}. ` +
  `Work autonomously. Do not use remember as a task handoff. Before ending, you MUST call ` +
  `'submit_agent_result' with a structured outcome, artifacts, blockers, and verification evidence.`;

const safePart = (value: string, fallback: string) => {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/(^[-.]|[-.]$)/g, "").slice(0, 60);
  return cleaned || fallback;
};

const resultStatus = (status: MissionTaskStatus): status is TaskResultStatus =>
  ["completed", "partial", "blocked", "failed", "cancelled"].includes(status);

function taskBudget(input: Partial<AgentTaskBudget> | undefined): AgentTaskBudget {
  const positive = (value: unknown, fallback: number) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
  return {
    timeoutMs: positive(input?.timeoutMs, DEFAULT_AGENT_TASK_BUDGET.timeoutMs),
    maxIterations: positive(input?.maxIterations, DEFAULT_AGENT_TASK_BUDGET.maxIterations),
    maxRecoveryAttempts: Math.max(0, Number.isFinite(Number(input?.maxRecoveryAttempts))
      ? Math.floor(Number(input?.maxRecoveryAttempts))
      : DEFAULT_AGENT_TASK_BUDGET.maxRecoveryAttempts),
  };
}

function validateMission(spec: MissionSpec): string | null {
  if (!spec.goal?.trim()) return "a Mission needs a goal";
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) return "a Mission needs at least one Agent Task";
  const ids = new Set<string>();
  for (const task of spec.tasks) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(task.id ?? "")) return `invalid Agent Task id: ${task.id ?? ""}`;
    if (ids.has(task.id)) return `duplicate Agent Task id: ${task.id}`;
    if (!task.goal?.trim()) return `Agent Task ${task.id} needs a goal`;
    ids.add(task.id);
  }
  for (const task of spec.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) return `Agent Task ${task.id} depends on missing task ${dependency}`;
      if (dependency === task.id) return `Agent Task ${task.id} cannot depend on itself`;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(spec.tasks.map((task) => [task.id, task]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of ids) if (!visit(id)) return "Mission dependency graph contains a cycle";
  return null;
}

export class SwarmManager {
  private clones = new Map<string, SwarmClone>();
  private brains = new Map<string, CloneBrain>();
  private missions = new Map<string, MissionState>();
  private missionDeps = new Map<string, SwarmDeps>();
  private taskTimers = new Map<string, NodeJS.Timeout>();
  private taskErrors = new Map<string, string>();
  private counter = 0;
  private closing = false;
  private stopping = new Set<Promise<unknown>>();
  private extraRoster: () => Array<{name:string;progress:string}> = () => [];
  private reservedCapacity: () => number = () => 0;

  setExtraRoster(read: () => Array<{name:string;progress:string}>): void {this.extraRoster=read;}
  setReservedCapacity(read:()=>number):void {this.reservedCapacity=read;}
  wake(): void {this.scheduleAll();}
  async close(): Promise<void> {
    this.closing=true;
    for(const mission of this.missions.values()) if(mission.status==='running') this.cancelMission(mission.id);
    await Promise.allSettled([...this.stopping]);
  }

  count(): number {
    return this.clones.size;
  }
  list(): SwarmClone[] {
    return [...this.clones.values()];
  }

  send(name: string, message: string): boolean {
    const matches = [...this.clones.values()].filter(clone => clone.id === name || clone.name === name);
    const brain = matches.length === 1 ? this.brains.get(matches[0].id) : undefined;
    if (!brain) return false;
    brain.send(`[Message from Main]: ${message}`);
    return true;
  }

  updateProgress(name: string, progress: string, deps: Pick<SwarmDeps, "broadcast"> = {}): boolean {
    const matches = [...this.clones.values()].filter(item => item.id === name || item.name === name);
    const clone = matches.length === 1 ? matches[0] : undefined;
    if (!clone) return false;
    clone.progress = String(progress).slice(0, 200);
    this.broadcast(deps as SwarmDeps);
    return true;
  }

  /** Submit a durable dependency graph of Agent Tasks. */
  submitMission(spec: MissionSpec, deps: SwarmDeps): { ok: boolean; missionId?: string; reason?: string } {
    if(this.closing) return {ok:false,reason:'Agent scheduler is shutting down'};
    const invalid = validateMission(spec);
    if (invalid) return { ok: false, reason: invalid };
    const now = deps.now ?? Date.now;
    const id = safePart(spec.id ?? `mission-${randomUUID()}`, "mission");
    if (this.missions.has(id)) return { ok: false, reason: `Mission ${id} already exists` };
    const coordinator = deps.coordinator ?? taskCoordinator;
    const rootTaskId = `mission.${id}`;
    if (coordinator.get(rootTaskId)) return { ok: false, reason: `Mission ${id} already exists on disk` };
    coordinator.create({
      taskId: rootTaskId,
      ownerActorId: `mission:${id}`,
      goal: spec.goal,
      scope: spec.scope ?? {},
    });
    const tasks = Object.fromEntries(spec.tasks.map((task) => [task.id, {
      ...task,
      dependsOn: [...new Set(task.dependsOn ?? [])],
      acceptanceCriteria: (task.acceptanceCriteria ?? []).map(String).filter(Boolean),
      lane: task.lane ?? "knowledge",
      budget: taskBudget(task.budget),
      status: "pending" as const,
      recoveryAttempts: 0,
    }]));
    const mission: MissionState = {
      schemaVersion: 1,
      id,
      taskId: rootTaskId,
      goal: spec.goal.trim(),
      status: "running",
      scope: structuredClone(spec.scope ?? {}),
      tasks,
      createdAt: now(),
      updatedAt: now(),
    };
    this.missions.set(id, mission);
    this.missionDeps.set(id, deps);
    this.persistMission(mission, coordinator);
    this.schedule(id);
    return { ok: true, missionId: id };
  }

  getMission(id: string): MissionState | null {
    const active = this.missions.get(id);
    if (active) return structuredClone(active);
    const saved = taskCoordinator.lookup<MissionState>(`mission.${safePart(id, "mission")}`, "mission");
    return saved ? structuredClone(saved) : null;
  }

  listMissions(): MissionState[] {
    return this.persistedMissions(taskCoordinator);
  }

  /** The same view, from a given coordinator — reconciliation must read what it will write. */
  private persistedMissions(coordinator: TaskCoordinator, limit=20): MissionState[] {
    const all = new Map<string, MissionState>();
    for (const state of coordinator.listBindings<MissionState>('mission',limit)) {
      if (!state.taskId.startsWith("mission.")) continue;
      const saved = state.value;
      if (saved?.id) all.set(saved.id, saved);
    }
    for (const mission of this.missions.values()) all.set(mission.id, mission);
    return [...all.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((mission) => structuredClone(mission));
  }

  /** Cancel pending and active work. Late Results are rejected by generation. */
  cancelMission(id: string): boolean {
    const mission = this.missions.get(id);
    const deps = this.missionDeps.get(id);
    if (!mission || !deps || mission.status !== "running") return false;
    const coordinator = deps.coordinator ?? taskCoordinator;
    for (const task of Object.values(mission.tasks)) {
      this.cancelOneTask(task, coordinator, "Mission cancelled");
    }
    mission.status = "cancelled";
    mission.result = this.aggregateResult(mission, "cancelled", "Mission cancelled");
    mission.updatedAt = (deps.now ?? Date.now)();
    this.commitMissionResult(mission, coordinator);
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
    this.scheduleAll();
    return true;
  }

  /**
   * Close out Missions that cannot still be running, after a restart.
   *
   * An Agent Task's wall-time budget is enforced by a `setTimeout` living in
   * the process that started it. Kill Echo and the timer dies with it, while
   * the Mission stays on disk saying "working" — so the next start restores a
   * board full of agents that do not exist. Measured here before this existed:
   * six tasks reported "working" 19.8 HOURS into a 10-minute cap, because no
   * run since had any reason to look at them.
   *
   * Runs after checkpoint recovery, so a task that genuinely resumed is left
   * alone; anything still unattached to a live brain is written off with the
   * reason it actually ended — over budget, or abandoned when Echo exited.
   */
  reconcileAbandoned(deps: SwarmDeps & { now?: () => number } = {} as SwarmDeps): { missions: number; tasks: number } {
    const coordinator = deps.coordinator ?? taskCoordinator;
    const now = (deps.now ?? Date.now)();
    let missionCount = 0;
    let taskCount = 0;

    for (const saved of this.persistedMissions(coordinator,Infinity)) {
      if (saved.status !== "running") continue;
      if (this.missions.has(saved.id)) continue;   // this process owns it, timers and all

      // This runs during startup over whatever is on disk: a half-written
      // record, an older schema, or a task some other actor owns. One bad
      // mission must not take the boot sequence with it.
      try {
      const mission = structuredClone(saved);
      let touched = false;
      for (const task of Object.values(mission.tasks)) {
        if (resultStatus(task.status)) continue;
        // A recovered task has a live brain in THIS process; leave it be.
        if (task.actorId && this.brains.has(task.actorId)) continue;

        const startedAt = task.startedAt ?? mission.createdAt;
        const overBudget = !!task.startedAt && now - startedAt > task.budget.timeoutMs;
        const summary = overBudget
          ? `Agent Task exceeded its ${task.budget.timeoutMs}ms time budget while Echo was not running`
          : "Agent Task was abandoned when Echo exited";
        task.status = overBudget ? "failed" : "cancelled";
        task.result = {
          status: task.status,
          summary,
          artifacts: [],
          verificationRefs: [],
          blockers: [overBudget ? "budget:timeout" : "abandoned:restart"],
          completedAt: new Date(now).toISOString(),
        };
        if (task.taskId && coordinator.get(task.taskId) && coordinator.get(task.taskId)!.status !== "cancelled") {
          coordinator.cancel(task.taskId);
        }
        touched = true;
        taskCount++;
      }

      if (!touched && Object.values(mission.tasks).some((task) => !resultStatus(task.status))) continue;
      const statuses = Object.values(mission.tasks).map((task) => task.status);
      mission.status = statuses.every((value) => value === "completed") ? "completed"
        : statuses.includes("failed") ? "failed" : "cancelled";
      mission.result = this.aggregateResult(mission, mission.status as TaskResultStatus,
        `Mission ended ${mission.status} — Echo restarted while it was running`);
      mission.updatedAt = now;
      // The Result is a courtesy to the coordinator; the persisted Mission is
      // the thing the board reads. If the first is refused, still write the
      // second — otherwise the board would go on showing work as running.
      try {
        this.commitMissionResult(mission, coordinator);
      } catch (err: any) {
        console.warn(`[swarm] mission ${mission.id}: could not file its Result (${err?.message ?? err})`);
      }
      this.persistMission(mission, coordinator);
      missionCount++;
      } catch (err: any) {
        console.warn(`[swarm] could not reconcile mission ${saved.id}: ${err?.message ?? err}`);
      }
    }

    if (missionCount) this.broadcast(deps);
    return { missions: missionCount, tasks: taskCount };
  }

  /**
   * Remove a mission from the board for good.
   *
   * A running mission is cancelled first: deleting the record of work that is
   * still executing would leave agents running with nothing left to report to,
   * and their Results would arrive for a mission that no longer exists. Each
   * Agent Task owns its own coordinator record, so those are forgotten too —
   * otherwise "deleted" would mean "hidden", with the task tree still on disk.
   */
  forgetMission(id: string, coordinator: TaskCoordinator = taskCoordinator): { ok: boolean; cancelled: boolean } {
    const mission = this.missions.get(id) ?? this.getMission(id);
    if (!mission) return { ok: false, cancelled: false };

    const cancelled = mission.status === "running" ? this.cancelMission(id) : false;
    const live = this.missions.get(id) ?? mission;
    for (const task of Object.values(live.tasks)) {
      if (task.taskId) coordinator.forget(task.taskId);
    }
    coordinator.forget(live.taskId);
    this.missions.delete(id);
    const deps = this.missionDeps.get(id);
    this.missionDeps.delete(id);
    if (deps) this.broadcast(deps);
    return { ok: true, cancelled };
  }

  /**
   * Stop just one Agent Task, leaving the rest of the mission running — the
   * board's per-card "stop" (Aira's onStopAgent), where cancelling the whole
   * mission would also kill agents the user never asked to stop.
   */
  cancelMissionTask(missionId: string, taskId: string): boolean {
    const mission = this.missions.get(missionId);
    const deps = this.missionDeps.get(missionId);
    const task = mission?.tasks[taskId];
    if (!mission || !deps || !task || resultStatus(task.status)) return false;
    const coordinator = deps.coordinator ?? taskCoordinator;
    this.cancelOneTask(task, coordinator, "Stopped");
    mission.updatedAt = (deps.now ?? Date.now)();
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
    this.scheduleAll(); // a task downstream of this one may now need to be marked blocked
    return true;
  }

  /** The cleanup one Agent Task needs when it is cut short — shared by both cancel paths above. */
  private cancelOneTask(task: MissionTaskState, coordinator: TaskCoordinator, summary: string): void {
    if (resultStatus(task.status)) return;
    if (task.taskId && coordinator.get(task.taskId)?.status !== "cancelled") coordinator.cancel(task.taskId);
    task.status = "cancelled";
    task.result = {
      status: "cancelled",
      summary,
      artifacts: [],
      verificationRefs: [],
      blockers: [],
      completedAt: new Date().toISOString(),
    };
    const timer = task.taskId ? this.taskTimers.get(task.taskId) : undefined;
    if (timer) clearTimeout(timer);
    if (task.taskId) this.taskTimers.delete(task.taskId);
    const brain = task.actorId ? this.brains.get(task.actorId) : undefined;
    brain?.interrupt?.();
    this.cleanupMissionTask(task);
  }

  /**
   * Spawn one clone toward a goal. Refuses (rather than queues) past the cap,
   * and refuses an empty goal.
   */
  spawn(goal: string, deps: SwarmDeps): { ok: boolean; name?: string; reason?: string } {
    const g = (goal ?? "").trim();
    if (!g) return { ok: false, reason: "empty goal" };
    if (this.clones.size + this.reservedCapacity() >= MAX_CONCURRENT_CLONES) {
      return { ok: false, reason: `already running ${this.clones.size} clones (max ${MAX_CONCURRENT_CLONES})` };
    }
    const missionId = `clone-${randomUUID()}`;
    const submitted = this.submitMission({ id: missionId, goal: g, tasks: [{ id: "work", goal: g, lane: "knowledge" }] }, deps);
    if (!submitted.ok) return { ok: false, reason: submitted.reason };
    const name = this.missions.get(missionId)?.tasks.work.actorName;
    return name ? { ok: true, name } : { ok: false, reason: "Agent Task could not start" };
  }

  /** Recreate a clone whose last process died with a running checkpoint. */
  recover(checkpoint: RecoveryCheckpoint, deps: SwarmDeps): boolean {
    if (this.closing || checkpoint.actor.parentTaskId?.startsWith('supervised.') || checkpoint.actor.kind !== "clone" || this.clones.size + this.reservedCapacity() >= MAX_CONCURRENT_CLONES) return false;
    if (this.brains.has(checkpoint.actor.id)) return false;
    if (checkpoint.actor.parentTaskId?.startsWith("mission.")) {
      return this.recoverMissionTask(checkpoint, deps);
    }
    const match = checkpoint.actor.name.match(/^Echo Clone (\d+)$/i);
    if (match) this.counter = Math.max(this.counter, Number(match[1]));
    let brain: CloneBrain;
    try { brain = deps.makeBrain(checkpoint.actor); }
    catch (error) { console.error('[swarm] clone recovery initialization failed', error); return false; }
    this.launch({
      id: checkpoint.actor.id,
      name: checkpoint.actor.name,
      goal: checkpoint.originalPrompt,
      status: "working",
      startedAt: checkpoint.createdAt,
      progress: `recovering attempt ${checkpoint.recoveryAttempts + 1}`,
    }, brain, deps);
    if (!brain.recoverFromCheckpoint?.(checkpoint)) {
      this.clones.delete(checkpoint.actor.id);
      this.brains.delete(checkpoint.actor.id);
      this.broadcast(deps);
      return false;
    }
    return true;
  }

  private recoverMissionTask(checkpoint: RecoveryCheckpoint, deps: SwarmDeps): boolean {
    const coordinator = deps.coordinator ?? taskCoordinator;
    const rootTaskId = checkpoint.actor.parentTaskId!;
    const missionId = rootTaskId.slice("mission.".length);
    let mission = this.missions.get(missionId);
    if (!mission) {
      const saved = coordinator.lookup<MissionState>(rootTaskId, "mission");
      if (!saved || saved.schemaVersion !== 1 || saved.id !== missionId || saved.status !== "running") return false;
      mission = structuredClone(saved);
      this.missions.set(missionId, mission);
      this.missionDeps.set(missionId, deps);
    }
    const task = Object.values(mission.tasks).find((item) => item.taskId === checkpoint.taskId);
    if (!task || task.status !== "working") return false;
    task.recoveryAttempts = Math.max(task.recoveryAttempts ?? 0, checkpoint.recoveryAttempts + 1);
    let brain: CloneBrain;
    try { brain = deps.makeBrain(checkpoint.actor, task); }
    catch (error) {
      if (task.taskId && task.actorId) {
        coordinator.submitResult(task.taskId, task.actorId, {status: 'failed', summary: String(error instanceof Error ? error.message : error), artifacts: [], verificationRefs: [], blockers: ['recovery:initialization']});
        task.result = coordinator.get(task.taskId)?.result;
      }
      task.status = 'failed';
      this.persistMission(mission, coordinator);
      this.broadcast(deps);
      this.scheduleAll();
      return false;
    }
    this.attachMissionBrain(mission, task, checkpoint.actor, brain, deps, checkpoint.createdAt, `recovering attempt ${checkpoint.recoveryAttempts + 1}`);
    if (!brain.recoverFromCheckpoint?.(checkpoint)) {
      if (task.taskId && task.actorId && !coordinator.get(task.taskId)?.result) {
        coordinator.submitResult(task.taskId, task.actorId, {
          status: "failed",
          summary: "The Agent Task could not resume from its recovery checkpoint",
          artifacts: [],
          verificationRefs: [],
          blockers: ["recovery:refused"],
        });
        task.result = coordinator.get(task.taskId)?.result;
        task.status = task.result?.status ?? "failed";
      }
      this.cleanupMissionTask(task);
      this.persistMission(mission, coordinator);
      this.broadcast(deps);
      this.scheduleAll();
      return false;
    }
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
    return true;
  }

  private launch(clone: SwarmClone, brain: CloneBrain, deps: SwarmDeps): void {
    this.clones.set(clone.id, clone);
    this.brains.set(clone.id, brain);
    brain.on("text", (t) => console.log(`[${clone.name}] ${t ?? ""}`));
    brain.on("error", () => this.finish(clone.id, "failed", deps));
    brain.on("turnEnd", () => this.finish(clone.id, "done", deps));
    this.broadcast(deps);
  }

  private schedule(missionId: string): void {
    const mission = this.missions.get(missionId);
    const deps = this.missionDeps.get(missionId);
    if (this.closing || !mission || !deps || mission.status !== "running") return;

    // A dependency that did not complete blocks everything downstream. This is
    // explicit state, not a pending task that silently never becomes ready.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of Object.values(mission.tasks)) {
        if (task.status !== "pending") continue;
        const failedDependency = (task.dependsOn ?? []).find((id) => {
          const status = mission.tasks[id]?.status;
          return status && resultStatus(status) && status !== "completed";
        });
        if (!failedDependency) continue;
        task.status = "blocked";
        task.result = {
          status: "blocked",
          summary: `Blocked by Agent Task ${failedDependency}`,
          artifacts: [],
          verificationRefs: [],
          blockers: [`dependency:${failedDependency}`],
          completedAt: new Date().toISOString(),
        };
        changed = true;
      }
    }

    for (const task of Object.values(mission.tasks)) {
      if (task.status !== "pending" || this.clones.size + this.reservedCapacity() >= MAX_CONCURRENT_CLONES) continue;
      const ready = (task.dependsOn ?? []).every((id) => mission.tasks[id]?.status === "completed");
      if (!ready) continue;
      if (task.lane === "gui" && this.guiLaneBusy()) continue;
      this.startMissionTask(mission, task, deps);
      if (resultStatus(task.status)) changed = true;
    }

    // Initialization failures must propagate to waiting dependants now.
    if (changed) { this.schedule(missionId); return; }

    const tasks = Object.values(mission.tasks);
    if (tasks.every((task) => resultStatus(task.status))) this.finishMission(mission, deps);
    else this.persistMission(mission, deps.coordinator ?? taskCoordinator);
  }

  private scheduleAll(): void {
    for (const id of this.missions.keys()) this.schedule(id);
  }

  private guiLaneBusy(): boolean {
    return desktopTaskBusy() || [...this.clones.values()].some((clone) => clone.status === "working" && clone.lane === "gui");
  }

  private startMissionTask(mission: MissionState, task: MissionTaskState, deps: SwarmDeps): void {
    const coordinator = deps.coordinator ?? taskCoordinator;
    const now = deps.now ?? Date.now;
    const root = loopLogRoot();
    const next = root ? nextCloneNumber(root) : this.counter + 1;
    this.counter = Math.max(this.counter + 1, next);
    const taskId = `${mission.taskId}.${safePart(task.id, "task")}`;
    const actorId = `${safePart(mission.id, "mission")}.${safePart(task.id, "task")}`;
    // Names are presentation only. Brain ownership and routing use actorId.
    const fleetMember = task.profile ? getFleetMember(task.profile) : null;
    const actorName = fleetMember?.name || task.profile?.trim() || `Echo Agent ${this.counter}`;
    const identity: AgentIdentity = { id: actorId, name: actorName, kind: "clone", parentTaskId: mission.taskId };
    coordinator.create({
      taskId,
      parentTaskId: mission.taskId,
      ownerActorId: actorId,
      goal: task.goal,
      scope: mission.scope,
    });
    task.taskId = taskId;
    task.actorId = actorId;
    task.actorName = actorName;
    task.startedAt = now();
    task.status = "working";
    mission.updatedAt = now();
    let brain: CloneBrain;
    try { brain = deps.makeBrain(identity, task); }
    catch (error) {
      coordinator.submitResult(taskId, actorId, {status: "failed", summary: String(error instanceof Error ? error.message : error), artifacts: [], verificationRefs: [], blockers: ["agent:initialization"]});
      task.result = coordinator.get(taskId)?.result;
      task.status = "failed";
      this.persistMission(mission, coordinator);
      this.broadcast(deps);
      return;
    }
    this.attachMissionBrain(mission, task, identity, brain, deps, task.startedAt, "working");
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
    try {
      brain.send(this.missionPrompt(mission, task, actorName), undefined, {
        taskId, parentTaskId: mission.taskId, scope: mission.scope, modality: "text",
      });
    } catch (error) {
      this.taskErrors.set(taskId, String(error instanceof Error ? error.message : error));
      this.finishMissionTask(mission.id, task.id);
    }
  }

  private attachMissionBrain(
    mission: MissionState,
    task: MissionTaskState,
    identity: AgentIdentity,
    brain: CloneBrain,
    deps: SwarmDeps,
    startedAt: number,
    progress: string
  ): void {
    const taskId = task.taskId!;
    const actorId = task.actorId ?? identity.id;
    const actorName = task.actorName ?? identity.name;
    task.actorId = actorId;
    task.actorName = actorName;
    task.startedAt ??= startedAt;
    this.clones.set(actorId, {
      id: actorId,
      name: actorName,
      goal: task.goal,
      status: "working",
      startedAt,
      progress,
      missionId: mission.id,
      agentTaskId: task.id,
      lane: task.lane,
    });
    this.brains.set(actorId, brain);
    brain.on("text", (text) => {
      const clone = this.clones.get(actorId);
      if (clone && text) clone.progress = String(text).slice(0, 200);
      console.log(`[${actorName}] ${text ?? ""}`);
      this.broadcast(deps);
    });
    brain.on("error", (error) => {
      this.taskErrors.set(taskId, String(error ?? "Agent failed"));
    });
    brain.on("turnEnd", () => this.finishMissionTask(mission.id, task.id));
    const elapsed = Math.max(0, (deps.now ?? Date.now)() - task.startedAt);
    const remaining = Math.max(1, task.budget.timeoutMs - elapsed);
    const timer = setTimeout(() => this.timeoutMissionTask(mission.id, task.id), remaining);
    this.taskTimers.set(taskId, timer);
  }

  private missionPrompt(mission: MissionState, task: MissionTaskState, actorName: string): string {
    const dependencies = (task.dependsOn ?? []).map((id) => ({ id, result: mission.tasks[id]?.result }));
    const criteria = task.acceptanceCriteria?.length
      ? task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "1. Deliver the requested work and verify it directly.";
    // task.profile doubles as a fleet member id (frontier/fleet.ts) — when it
    // resolves to one, that agent's own standing brief IS this task's
    // instructions, ahead of the generic "you are an Echo agent" framing.
    // This is the one place a fleet member's persona is ever read from, so
    // the board (main.ts) and a plain spawned clone never disagree about it.
    const member = task.profile ? getFleetMember(task.profile) : null;
    const brief = member ? `${member.brief}\n\n` : "";
    return `${brief}${systemPrompt(actorName, task.goal)}\n\n` +
      `Mission: ${mission.goal}\n` +
      `Execution lane: ${task.lane}\n` +
      `Acceptance criteria:\n${criteria}\n\n` +
      `Dependency Results:\n${JSON.stringify(dependencies, null, 2)}\n\n` +
      `Budget: ${task.budget.maxIterations} model iterations, ${task.budget.maxRecoveryAttempts} recovery attempts, ` +
      `${task.budget.timeoutMs}ms wall time. A normal text reply or turnEnd is NOT completion. ` +
      `Do not create another Mission or spawn another agent; this Agent Task is your complete scope.`;
  }

  private finishMissionTask(missionId: string, taskId: string): void {
    const mission = this.missions.get(missionId);
    const deps = this.missionDeps.get(missionId);
    const task = mission?.tasks[taskId];
    if (!mission || !deps || !task || task.status !== "working" || !task.taskId || !task.actorId) return;
    const coordinator = deps.coordinator ?? taskCoordinator;
    const persisted = coordinator.get(task.taskId);
    if (!persisted?.result) {
      coordinator.submitResult(task.taskId, task.actorId, {
        status: "failed",
        summary: this.taskErrors.get(task.taskId) ?? "Agent ended without submitting a structured Result",
        artifacts: [],
        verificationRefs: [],
        blockers: ["missing_result"],
      });
    }
    const result = coordinator.get(task.taskId)?.result!;
    task.result = result;
    task.status = result.status;
    mission.updatedAt = (deps.now ?? Date.now)();
    this.cleanupMissionTask(task);
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
    this.scheduleAll();
  }

  private timeoutMissionTask(missionId: string, taskId: string): void {
    const mission = this.missions.get(missionId);
    const deps = this.missionDeps.get(missionId);
    const task = mission?.tasks[taskId];
    if (!mission || !deps || !task || task.status !== "working" || !task.taskId || !task.actorId) return;
    const brain = task.actorId ? this.brains.get(task.actorId) : undefined;
    brain?.interrupt?.();
    const coordinator = deps.coordinator ?? taskCoordinator;
    coordinator.submitResult(task.taskId, task.actorId, {
      status: "failed",
      summary: `Agent Task exceeded its ${task.budget.timeoutMs}ms time budget`,
      artifacts: [],
      verificationRefs: [],
      blockers: ["budget:timeout"],
    });
    this.finishMissionTask(missionId, taskId);
  }

  private cleanupMissionTask(task: MissionTaskState): void {
    if (task.taskId) {
      const timer = this.taskTimers.get(task.taskId);
      if (timer) clearTimeout(timer);
      this.taskTimers.delete(task.taskId);
      this.taskErrors.delete(task.taskId);
    }
    if (task.actorId) this.clones.delete(task.actorId);
    if (task.actorId) {
      const brain = this.brains.get(task.actorId);
      this.brains.delete(task.actorId);
      if(brain) this.stopOwnedBrain(brain);
    }
  }

  private finishMission(mission: MissionState, deps: SwarmDeps): void {
    if (mission.status !== "running") return;
    const statuses = Object.values(mission.tasks).map((task) => task.status);
    const status: TaskResultStatus = statuses.every((value) => value === "completed") ? "completed"
      : statuses.includes("failed") ? "failed"
        : statuses.includes("blocked") ? "blocked"
          : statuses.includes("partial") ? "partial"
            : "cancelled";
    mission.status = status;
    mission.result = this.aggregateResult(
      mission,
      status,
      status === "completed" ? `Mission completed: ${mission.goal}` : `Mission ended ${status}: ${mission.goal}`
    );
    mission.updatedAt = (deps.now ?? Date.now)();
    const coordinator = deps.coordinator ?? taskCoordinator;
    this.commitMissionResult(mission, coordinator);
    this.persistMission(mission, coordinator);
    this.broadcast(deps);
  }

  private aggregateResult(mission: MissionState, status: TaskResultStatus, summary: string): TaskResult {
    const results = Object.values(mission.tasks).map((task) => task.result).filter((value): value is TaskResult => !!value);
    return {
      status,
      summary,
      artifacts: results.flatMap((result) => result.artifacts),
      verificationRefs: [...new Set(results.flatMap((result) => result.verificationRefs))],
      blockers: [...new Set(results.flatMap((result) => result.blockers))],
      completedAt: new Date().toISOString(),
    };
  }

  private commitMissionResult(mission: MissionState, coordinator: TaskCoordinator): void {
    if (!mission.result || coordinator.get(mission.taskId)?.result) return;
    coordinator.submitResult(mission.taskId, `mission:${mission.id}`, {
      status: mission.result.status,
      summary: mission.result.summary,
      artifacts: mission.result.artifacts,
      verificationRefs: mission.result.verificationRefs,
      blockers: mission.result.blockers,
    });
  }

  private persistMission(mission: MissionState, coordinator: TaskCoordinator): void {
    coordinator.bind(mission.taskId, "mission", mission);
  }

  private finish(id: string, status: CloneStatus, deps: SwarmDeps): void {
    const c = this.clones.get(id);
    if (!c) return;
    c.status = status;
    // Drop it from the roster; the summary it saved via `remember` is its
    // lasting output, so the brain object itself is no longer needed.
    this.clones.delete(id);
    const brain = this.brains.get(c.id);
    this.brains.delete(c.id);
    if(brain) this.stopOwnedBrain(brain);
    this.broadcast(deps);
    this.scheduleAll();
  }

  private broadcast(deps: SwarmDeps): void {
    const state = [...this.list().map((c) => ({ name: c.name, progress: c.progress || c.status })),...this.extraRoster()];
    (deps.broadcast ?? ((s) => sendToOverlay("clones", s)))(state);
  }
  private stopOwnedBrain(brain: CloneBrain): void {
    let stopping: Promise<void> | undefined;
    try {stopping=brain.stop?.();} catch(error) {console.error('[swarm] agent cleanup failed',error);}
    const stop=shutdownStep('background agent',()=>stopping,5000);
    this.stopping.add(stop);void stop.finally(()=>this.stopping.delete(stop));
  }
}

export const swarm = new SwarmManager();
