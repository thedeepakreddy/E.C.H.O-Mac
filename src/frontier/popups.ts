import {NativeConsumer,consumerStatus,failureNote,type NativeNode} from './native-consumer.js';
import type {ToolStatus} from '../memory/tool-result.js';
import type {ToolOutput} from '../tools/registry.js';

/**
 * Clears the interruptions that get in the way mid-task.
 *
 * Storage warnings, update prompts, cookie banners and "try our new thing"
 * overlays all sit on top of the thing Jarvis was asked to do. Without a way to
 * clear them it clicks the banner instead of the button underneath.
 *
 * The hard part is restraint, not detection. A dialog's buttons are the most
 * dangerous things on screen — "OK" on "Delete these 400 files?" is a disaster,
 * and "Continue" can mean anything. So only unambiguously dismissive wording is
 * ever clicked, and anything else is described back to the user instead.
 */

/** Candidate wording only; a fresh native target and its exact risk gate are required. */
const DISMISSIVE = [
  "not now", "no thanks", "no thank you", "maybe later", "later", "skip",
  "dismiss", "close", "got it", "no, thanks", "remind me later", "ask me later",
  "not right now", "decline", "reject all", "only necessary", "continue without",
  "keep browsing", "stay on free", "no thanks, continue", "×", "✕", "✖",
];

/**
 * Words that LOOK dismissive but decide something. Never clicked automatically
 * — "OK" and "Allow" have destroyed more data than any error message.
 */
const AMBIGUOUS = [
  "ok", "okay", "yes", "allow", "continue", "accept", "agree", "confirm",
  "delete", "remove", "send", "buy", "upgrade", "subscribe", "pay", "sign out",
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export interface DismissResult extends Pick<ToolOutput,'computerContent'|'data'> {
  dismissed: string[];
  /** Things that looked like a dialog but were left alone, with why. */
  skipped: string[];
  note: string;
  attempted:string[];
  status:ToolStatus;
}

function isDismissive(label: string): boolean {
  const l = norm(label);
  if (!l || l.length > 34) return false;
  if (AMBIGUOUS.some((a) => l === a)) return false;
  return DISMISSIVE.includes(l);
}

/** A lone × or close glyph, which carries no words at all. */
function isCloseGlyph(label: string): boolean {
  return /^[\s]*[×✕✖x✗]\s*$/i.test(label);
}

/**
 * Clear whatever is in the way.
 * @param rounds a dismissal can reveal another underneath it
 */
export async function dismissPopups(rounds = 3,opts:{app?:string}={}): Promise<DismissResult> {
  const dismissed: string[] = [];
  const skipped: string[] = [];
  const attempted:string[]=[],consumer=new NativeConsumer(opts.app);
  let status:ToolStatus='success';
  const dismissible=(node:NativeNode)=>['button','close button'].includes(node.role)&&(isDismissive(node.label)||isCloseGlyph(node.label));
  try{
    if(!Number.isSafeInteger(rounds)||rounds<1||rounds>5)throw Error('Use 1–5 bounded dismissal rounds.');
    for(let round=0;round<rounds;round++){
      const snapshot=await consumer.inspect();
      for(const node of snapshot.nodes)if(node.role==='button'&&AMBIGUOUS.includes(norm(node.label)))skipped.push(`"${node.label}" — decides something; left alone`);
      const candidates=snapshot.nodes.filter(dismissible);
      if(!candidates.length){if(skipped.length)status='partial';break;}
      if(candidates.length!==1){skipped.push('Multiple native dismissal controls match; no target was guessed.');status='partial';break;}
      const target=candidates[0];
      if(/\bdisabled\b/i.test(target.description)){skipped.push(`"${target.label}" — disabled`);status='partial';break;}
      await consumer.input('click_in_app',snapshot,{target:target.index,button:'left',count:1});
      attempted.push(target.label);
      await consumer.pause(400);
      const after=await consumer.inspect();
      if(after.nodes.some(node=>dismissible(node)&&norm(node.label)===norm(target.label))){
        skipped.push(`Native click returned, but "${target.label}" remains visible. Removal is unverified; it was not clicked again.`);status='partial';break;
      }
      dismissed.push(target.label);
      if(round===rounds-1&&after.nodes.some(dismissible)){skipped.push('Reached the bounded dismissal limit; remaining overlays are unverified.');status='partial';}
    }
  }catch(error){skipped.push(failureNote(error));status=consumerStatus(error,attempted.length);}
  const note=dismissed.length?`Observed ${dismissed.length} dismissal control(s) disappear: ${dismissed.map(label=>`"${label}"`).join(', ')}.`
    :attempted.length?'A native dismissal input returned, but removal was not verified.':'No native dismissal was performed.';
  return {dismissed,attempted,skipped,note,status,...consumer.evidence()};
}
