import {CODING_TOOL_NAMES} from './tool-selection.js';

// "I'll build", "let's get started" — a promise of work still to come.
const FUTURE = String.raw`(?:i['’]ll|i will|i['’]m going to|i am going to|we['’]ll|we will|let['’]s|let me)`;
// "I'm building", "now installing" — a claim that work is under way. English
// pairs "I'm" with the -ing form, so the two need separate verb lists; matching
// "I'm build" only ever caught a sentence no model writes.
const PRESENT = String.raw`(?:i['’]m|i am|we['’]re|we are|now)`;
const ADVERB = String.raw`(?:(?:\w+ly|now|just|also)\s+)?`;
const BASE = "begin|start|continue|build|create|make|implement|install|assemble|initiali[sz]e|set up|scaffold|write|code|test|debug|fix|get started";
const ING = "beginning|starting|continuing|building|creating|making|implementing|installing|assembling|initiali[sz]ing|setting up|scaffolding|writing|coding|testing|debugging|fixing|working on";
const PROMISE = new RegExp(String.raw`\b${FUTURE}\s+${ADVERB}(?:${BASE})\b|\b${PRESENT}\s+${ADVERB}(?:${ING})\b`, "i");

/** Does this reply say coding work is starting or under way? */
export function promisesCodingWork(reply: string): boolean {
  return PROMISE.test(reply);
}

/**
 * The tools a coding turn's first step may be forced onto. Memory, history and
 * web lookups are left out on purpose: a model made to call *something* reaches
 * for the cheapest tool, and a recall satisfies the constraint without starting
 * any work.
 */
export const CODING_ACTION_TOOLS = new Set([...CODING_TOOL_NAMES, 'run_supervised_task', 'inspect_supervised_task',
  'cancel_supervised_task', 'show_task_report', 'inspect_coding_tools', 'invoke_coding_tool']);

/**
 * Is this an instruction to act ("Build a 2D game", "Go ahead"), rather than a
 * question about what Echo can do ("Can you build an application?") or a
 * deferral ("No, don't build it yet")? Only an instruction may have its first
 * model step forced onto a tool; a question still deserves a spoken answer.
 */
export function codingActionRequest(query: string): boolean {
  const q = query.trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!q || /\?$/.test(q)) return false;
  if (/^(?:what|how|why|which|who|when|where|is|are|was|were|does|did|do you|can you|could you|would you|will you|should|shall|have you|has)\b/i.test(q)) return false;
  return !/\b(?:don['’]?t|do not|never ?mind|not now|hold on|wait|later|tomorrow)\b/i.test(q);
}

/** Only an explicit action promise may trigger a first-step coding nudge. */
export function codingContinuationEligible(hadTools:boolean,codingContext:boolean,reply:string):boolean {
 if(hadTools)return true;
 return codingContext&&!/\?\s*$/.test(reply)&&promisesCodingWork(reply);
}
