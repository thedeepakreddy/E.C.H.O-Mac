import {NativeConsumer,consumerStatus,failureNote} from './native-consumer.js';
import type {ToolStatus} from '../memory/tool-result.js';
import type {ToolOutput} from '../tools/registry.js';
import type { Step, Workflow } from "./demonstrate.js";
import { save } from "./demonstrate.js";

/**
 * Replays a learned workflow, re-finding each control instead of trusting
 * coordinates.
 *
 * Each input is bound to a fresh, owner-scoped LCU app observation. Clicks
 * require one exact native target; AX paths and global OCR coordinates are not
 * input targets. Every nested action crosses its own risk/grant gate. Ambiguity
 * stops the sequence and retains completed progress and original native evidence.
 */

export interface StepResult {
  step: Step;
  ok: boolean;
  how: "accessibility" | "screen-text" | "direct" | "failed" | "skipped" | "unverified";
  note: string;
  status?:ToolStatus;
  /** Where it resolved to, so a dry run can draw the target without clicking it. */
  at?: { x: number; y: number };
}

function keyChord(modifiers:string[],key:string):string {
  const aliases:Record<string,string>={command:'super',cmd:'super',meta:'super',super:'super',control:'ctrl',ctrl:'ctrl',option:'alt',alt:'alt',shift:'shift'};
  const mapped=modifiers.map(modifier=>{const value=aliases[modifier.toLowerCase()];if(!value)throw Error(`Unsupported recorded key modifier: ${modifier}`);return value;});
  return [...mapped,key.toLowerCase()==='enter'?'Return':key].join('+');
}
async function runStep(step: Step,consumer:NativeConsumer,dry = false, afterSkip = false): Promise<StepResult> {
  switch (step.kind) {
    case "open":
      if(dry)return {step,ok:true,how:'skipped',note:`would open ${step.app}`};
      await consumer.open(step.app);
      return { step, ok: true, how: "direct", note: `LCU returned ${step.app}'s native window; goal not verified` };

    case "wait":
      if (dry) return { step, ok: true, how: "skipped", note: `would wait ${step.seconds}s` };
      await consumer.pause(step.seconds * 1000);
      return { step, ok: true, how: "direct", note: `waited ${step.seconds}s` };

    case "type":
      if (dry) {
        const preview = step.text.length > 40 ? step.text.slice(0, 40) + "…" : step.text;
        return { step, ok: true, how: "skipped", note: `would type "${preview}"` };
      }
      await consumer.input('type_in_app',await consumer.inspect(),{text:step.text});
      return { step, ok: true, how: "direct", note: `native typing returned for ${step.text.length} chars; output not verified` };

    case "keys": {
      const combo = [...step.modifiers, step.key].join("+");
      if (dry) return { step, ok: true, how: "skipped", note: `would press ${combo}` };
      await consumer.input('press_app_key',await consumer.inspect(),{key:keyChord(step.modifiers,step.key)});
      return { step, ok: true, how: "direct", note: `native key input returned for ${combo}; output not verified` };
    }

    case "click": {
      if(dry&&afterSkip)return {step,ok:true,how:'unverified',note:`couldn't check "${step.target}" — it appears after a step I didn't perform`};
      const snapshot=await consumer.inspect(),found=consumer.unique(snapshot,step.target,step.role);
      const named=`"${found.label}"`;

      if (dry) {
        return {
          step,
          ok: true,
          how: 'accessibility',
          note: `would click ${named}`,
        };
      }
      await consumer.input('click_in_app',snapshot,{target:found.index,button:'left',count:1});
      return { step, ok: true, how: 'accessibility', note: `native click returned for ${named}; result not verified` };
    }
  }
}

export interface ReplayReport extends Pick<ToolOutput,'computerContent'|'data'> {
  ok: boolean;
  results: StepResult[];
  repairs: number;
  summary: string;
  status:ToolStatus;
}

export async function replay(
  wf: Workflow,
  steps: Step[],
  opts: { dryRun?: boolean; app?:string; onStep?: (r: StepResult, i: number) => void } = {}
): Promise<ReplayReport> {
  const dry = opts.dryRun === true;
  const results: StepResult[] = [];
  let repairs = 0;
  // Once a preview has declined to perform something, the screen no longer
  // matches what later steps expect.
  let skippedSomething = false;
  const consumer=new NativeConsumer(opts.app);

  for (const step of steps) {
    let r:StepResult;
    try{if(!dry&&results.length)await consumer.pause(350);r=await runStep(step,consumer,dry,skippedSomething);}
    catch(error){r={step,ok:false,how:'failed',note:failureNote(error),status:consumerStatus(error)};}
    results.push(r);
    try{opts.onStep?.(r, results.length - 1);}catch{/* Reporting callbacks cannot discard completed input evidence. */}
    if (r.how === "skipped") skippedSomething = true;
    if (r.note.includes("recorded as")) repairs++;
    if (!r.ok) break; // stop at the first miss rather than compounding the error
  }

  const failed = results.find((r) => !r.ok);

  // A preview is not a run: counting it would corrupt the workflow's success
  // record, which is what decides whether it is trusted.
  if (!dry) {
    wf.runs++;
    wf.repairs += repairs;
    try {
      save(wf);
    } catch {
      /* health stats are not worth failing a replay over */
    }
  }

  const summary = dry
    ? describeDryRun(results, repairs)
    : failed
      ? `Stopped at step ${results.length} — ${failed.note}. The first ${results.length - 1} step(s) completed.`
      : `Native execution returned for ${results.length} steps. This does not verify the requested goal.`;

  const status=failed?(failed.status==='uncertain'?'uncertain':results.some(result=>result.ok)?'partial':failed.status??'failed'):'success';
  return { ok: !failed, results, repairs, summary,status,...consumer.evidence() };
}

/** Report what a preview found, without pretending it proved more than it did. */
export function describeDryRun(results: StepResult[], repairs: number): string {
  const failed = results.find((r) => !r.ok);
  const unverified = results.filter((r) => r.how === "unverified").length;

  const lines = results.map((r, i) => `  ${i + 1}. ${r.note}`).join("\n");
  const parts = [`Dry run — nothing was changed.\n${lines}`];

  if(!results.length){parts.push('\nNo steps were provided.');}
  else if (failed) {
    parts.push(`\nThis would stop at step ${results.length}: ${failed.note}`);
  } else if (unverified) {
    parts.push(
      `\nI resolved every step I could. ${unverified} could not be checked because they only appear after a step I deliberately didn't perform.`
    );
  } else {
    parts.push(`\nEvery step resolved to a real control.`);
  }
  if (repairs) {
    parts.push(`${repairs} control(s) have moved since this was recorded — I'd re-find them.`);
  }
  return parts.join("\n");
}
