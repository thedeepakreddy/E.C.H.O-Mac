import {isBuildStatusRequest} from '../coding/progress.js';
import type {SupervisedSpec, SupervisedState} from './supervisor.js';

type TaskKind = 'coding' | 'research' | 'workflow';
const ACTIVE = new Set<SupervisedState['status']>(['executing','inspecting','repairing','verifying']);
const ACTION = /^(build|create|make|write|implement|develop|fix|debug|refactor|improve|optimize|audit|review|research|investigate|find|open|read|compare|organize|analyse|analyze)\b/i;
const SOFTWARE = /\b(?:app|web\s*app|website|application|backend|codebase|architecture|tool calling|REST API|GraphQL API)\b/i;
const COMPLEX = /\b(?:full[ -]?stack|complete|entire|whole|large|complex|comprehensive|end[ -]?to[ -]?end|production|regression|migrations?|authentication|database|multiple)\b/i;
const BUILD = new Set(['build','create','make','write','implement','develop']);
const CODE_ACTIONS = new Set([...BUILD,'fix','debug','refactor','improve','optimize','audit','review']);

function commandText(text: string): string {
  return text.trim().replace(/\n\n\(heard: [\s\S]*\)$/,'').replace(/^(?:hey[, ]+)?echo[, ]+/i,'')
    .replace(/^please\s+/i,'').replace(/^(?:can|could|will|would) you\s+(?:please\s+)?/i,'')
    .replace(/^i (?:want|need)(?: you)? to\s+/i,'').replace(/^help me\s+/i,'').replace(/^please\s+/i,'');
}

/** Cheap, conservative recognition of self-contained action requests. Ambiguous requests
 * stay with the foreground brain, which has the conversation needed to clarify/plan them. */
export function automaticTaskSpec(text: string): SupervisedSpec | null {
  const command = commandText(text), action = command.match(ACTION)?.[1].toLowerCase();
  if (!action || text.length > 12000 || isBuildStatusRequest(command)) return null;
  if (/^(?:build|create|make)\s+(?:nothing|no\b)/i.test(command) || /\b(?:not yet|not now|later instead)\b/i.test(command)) return null;
  if (/\b(?:we (?:discussed|planned)|as discussed|discussed earlier|those features|that plan)\b/i.test(command)) return null;
  if (/^(?:build|create|make|develop)\s+(?:(?:a|an|the)\s+)?(?:(?:full[ -]?stack|complete|large|complex)\s+)*(?:app|application|website|web\s*app)[.!?]*$/i.test(command)) return null;
  if (/^(?:create|make|open|read|find)\s+(?:(?:a|an|the|new)\s+)*(?:folder|file|directory|API key|Vercel API key)\b/i.test(command)) return null;
  if (/^(?:create|make|write|build)\s+(?:(?:a|an|the|new|detailed)\s+)*(?:diagram|icon|logo|picture|plan|list|explanation|tutorial)\b/i.test(command)) return null;
  if (/\b(?:app icon|API (?:key|token)|application token)\b/i.test(command)) return null;

  const actions = new Set(command.toLowerCase().match(/\b(?:build|create|implement|fix|debug|refactor|research|find|open|read|compare|save|test|verify|run|deploy|audit|organize|extract|summarize)\b/g));
  const sequence = /\b(?:and|then|after|finally)\b|[,;]/i.test(command) && actions.size >= 3;
  let kind: TaskKind;
  if (CODE_ACTIONS.has(action) && SOFTWARE.test(command) && (BUILD.has(action) || COMPLEX.test(command) || sequence)) kind = 'coding';
  else if (['research','investigate','analyse','analyze','compare','find'].includes(action) &&
    /\b(?:report|comparison|recommendations|analysis|dataset)\b/i.test(command) && (sequence || COMPLEX.test(command) || /\b(?:compare|evidence|sources)\b/i.test(command))) kind = 'research';
  else if (sequence) kind = 'workflow';
  else return null;

  const gui = /\b(?:open|control|click|type (?:in|into)|fill|navigate|interact with)\b.{0,60}\b(?:Safari|Chrome|browser|app|application)\b|\b(?:signed[ -]?in|on my screen|foreground|show me on my Mac|show on my Mac)\b/i.test(command);
  const steps = kind === 'coding' ? [
    'Inspect the requested scope, owned project and available tools; record requirements, assumptions and a concrete implementation plan before editing.',
    'Implement the requested architecture, features and user flows while preserving unrelated work.',
    'Run the relevant compiler/build, unit and integration checks; debug failures and rerun affected regression tests.',
    'Exercise the requested user flows and output/preview; verify each requirement against the current files and actual results.',
    'Submit the usable output, current verification evidence and any unresolved blockers for independent inspection.',
  ] : [
    'Inspect the requested scope and available tools; record a concrete ordered plan and observable postconditions.',
    kind === 'research' ? 'Gather the required sources and data; retain provenance and distinguish observations from assumptions.' : 'Execute the requested steps through guarded tools; observe each changed state before continuing.',
    'Produce every requested deliverable, verify accuracy and completeness, and correct discrepancies.',
    'Verify the final postconditions and submit output links, evidence and any unresolved blockers for independent inspection.',
  ];
  const acceptanceCriteria = [
    'Every requested behavior, deliverable and constraint in the original goal is covered by current observable evidence; missing scope is reported as a blocker.',
    kind === 'coding' ? 'Relevant build, tests and regression checks pass on the current source; requested user flows are exercised and their actual outcomes recorded.' : 'The final output and requested postconditions are independently checkable against actual source data, saved artifacts or observed application state.',
    'Usable output artifacts or links and a truthful verification summary are provided, with no unresolved failures or unsupported completion claims.',
  ];
  return {goal:text.trim(),steps,acceptanceCriteria,lane:gui?'gui':'knowledge'};
}

/** Keep actionable long requests/status in the shared dispatcher instead of a voice-only path. */
export function needsTaskDispatch(text: string): boolean {
  return !!automaticTaskSpec(text) || isBuildStatusRequest(commandText(text));
}

export interface AutomaticTaskDeps {
  start(spec: SupervisedSpec): SupervisedState;
  current(): SupervisedState | null;
  latest(): SupervisedState | null;
  cancel(id: string): Promise<void>;
}

/** One interface for voice, typed and remote requests; no second model call or mode switch. */
export class AutomaticTaskRouter {
  constructor(private readonly deps: AutomaticTaskDeps) {}
  control(text: string, foregroundBusy = false): string | null {
    const current=this.deps.current();
    if(current && /^(?:stop|cancel|pause)(?:\s+(?:the|this|my))?(?:\s+(?:task|build|project|coding|work))?[.!]?$/i.test(commandText(text))) {
      void this.deps.cancel(current.id).catch(error=>console.error('[tasks] cancellation failed:',error));
      return 'Stopping the task worker and inspector. Progress is saved; the report will show the cancellation and cleanup result.';
    }
    return !current && foregroundBusy?null:this.status(text);
  }
  status(text: string): string | null {
    if (isBuildStatusRequest(commandText(text))) {
      const state = this.deps.current() ?? this.deps.latest();
      if (!state) return null;
      if (state.status === 'completed') return 'The task completed with verification. Its output and checks are in the task report.';
      if (state.status === 'blocked' || state.status === 'cancelled') return `The task is ${state.status}. ${state.blockers.join(' ').slice(0,600)}`;
      return `The task is still ${state.status}. It has not finished verification; progress is available in the control panel.`;
    }
    return null;
  }
  handle(text: string, options: Pick<SupervisedSpec,'scope'|'privateMode'|'projectIds'> & {foregroundBusy?:boolean} = {}): string | null {
    const {foregroundBusy,...taskOptions}=options;
    const status=this.control(text,foregroundBusy);
    if(status)return status;
    const spec = automaticTaskSpec(text);
    if (!spec) return null;
    const current = this.deps.current();
    if (current && ACTIVE.has(current.status)) return 'A long task is already running with its worker and inspector. Its progress is in the control panel; finish or cancel it before starting another.';
    try {
      const state = this.deps.start({...spec,...taskOptions});
      if (state.status === 'blocked' || state.status === 'cancelled') return `The task is ${state.status}. ${state.blockers.join(' ').slice(0,600)}`;
      return 'I’ve started planning and working on your task, with independent checks and repairs. I’ll show the output and verification report when it finishes.';
    } catch (error) {
      return `I could not start the task: ${String(error instanceof Error ? error.message : error).slice(0,600)}. No replacement task was started.`;
    }
  }
}
