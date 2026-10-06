import type { ToolDef, ToolOutput } from '../tools/registry.js';
import type { AgentRunContext } from '../agent-replay/context.js';
import { inputFingerprint } from './tool-context.js';
import { taskCoordinator } from './task-state.js';

export const INTERNAL_TOOLS = new Set(['inspect_task', 'read_tool_result', 'update_task_plan', 'discover_tools', 'refresh_observations', 'verify_task',
  'inspect_supervised_task','read_supervised_evidence','submit_task_review','show_task_report']);
const VOLATILE = /^(?:inspect_project_recovery|inspect_vercel_deployment|prepare_vercel_deployment|inspect_project_preview|inspect_project_diagnostics|inspect_project_recipe|inspect_project|search_project|read_project_file|project_diff|read_process|project_git_status|wait|screenshot|read_screen_text|list_ui_elements|frontmost_app|get_mouse_position|system_sitrep|check_presence|presence_status|attention_status)$/;
const states = new WeakMap<AgentRunContext, {epoch: number; boundary: number; repeats: Map<string, number>; pending: Map<string, Promise<ToolOutput>>; fingerprints: Map<string, string>}>();

/** Successful observations may be reused briefly; actions are never cached. */
export async function runWithReadReuse(run: AgentRunContext | null, def: ToolDef,
  args: Record<string, unknown>, callId: string | undefined, action: () => Promise<ToolOutput>): Promise<ToolOutput> {
  if (!run || !callId) return action();
  let state = states.get(run);
  if (!state || state.epoch !== (run.observationEpoch ?? 0)) {
    state = {epoch: run.observationEpoch ?? 0, boundary: state ? Object.keys(taskCoordinator.get(run.taskId)?.calls ?? {}).length - 1 : -1, repeats: new Map(), pending: new Map(), fingerprints: new Map()}; states.set(run, state);
  }
  if (!def.readOnly && !INTERNAL_TOOLS.has(def.name)) {
    run.observationEpoch = state.epoch + 1; states.delete(run);
    return action();
  }
  if (!def.readOnly || INTERNAL_TOOLS.has(def.name)) return action();
  const observe = async () => {
    const out = await action();
    return out.status === 'success' && out.verification !== 'contradicted' ? {...out, verification: 'verified' as const,
      verificationRefs: [...new Set([...(out.verificationRefs ?? []), `observation:${run.taskId}:${callId}`])]} : out;
  };
  if (VOLATILE.test(def.name)) return observe();
  const hash = inputFingerprint(args);
  const calls = Object.values(taskCoordinator.get(run.taskId)?.calls ?? {});
  let boundary = state.boundary;
  calls.forEach((c, index) => {if (c.effect === 'action' || c.tool === 'refresh_observations') boundary = index;});
  // Reused results keep the original observation's time; reuse never renews freshness.
  const previous = calls.slice(boundary + 1).find(c => c.callId !== callId && c.tool === def.name && c.inputHash === hash
    && c.generation === taskCoordinator.get(run.taskId)?.generation && !c.late && c.status === 'success'
    && !c.result?.verificationRefs?.some(ref => ref.startsWith(`observation:${run.taskId}:`) && ref !== `observation:${run.taskId}:${c.callId}`)
    && c.endedAt && Date.now() - Date.parse(c.endedAt) < 30000);
  const key = `${def.name}:${hash}`;
  const stopLoop = (): ToolOutput => {
    run.onNoProgress?.();
    return {status: 'failed', text: 'Stopped a repeating read loop. Use saved evidence to answer or report the blocker; do not repeat the same request.', error: {category: 'no_progress', message: 'Repeated successful observation without new progress', retryable: false}};
  };
  if (previous) {
    const repeats = (state.repeats.get(key) ?? 0) + 1; state.repeats.set(key, repeats);
    if (repeats >= 5) return stopLoop();
    const saved = taskCoordinator.readCallResult(run.taskId, previous.callId)!;
    run.loop?.note('tool.observation_reused', {tool: def.name, sourceCallId: previous.callId, repeats});
    return {...saved, text: `${saved.text ?? ''}\n[Reused successful observation from call ${previous.callId}; do not re-fetch to verify a read. Use read_tool_result for more detail.]`};
  }
  const inFlight = state.pending.get(key);
  if (inFlight) {
    const shared = await inFlight;
    return {...shared, text: `${shared.text ?? ''}\n[Shared simultaneous observation; do not fetch again to verify a read.]`};
  }
  const pending = observe(); state.pending.set(key, pending);
  try {
    const value = await pending;
    if (value.status === 'success') {
      const fingerprint = inputFingerprint({text: value.text, data: value.data});
      const repeats = state.fingerprints.get(key) === fingerprint ? (state.repeats.get(key) ?? 0) + 1 : 0;
      state.fingerprints.set(key, fingerprint); state.repeats.set(key, repeats);
      if (repeats >= 5) return stopLoop();
    }
    return value;
  } finally {if (state.pending.get(key) === pending) state.pending.delete(key);}
}
