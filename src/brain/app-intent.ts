/** Explicit app-operation intent outranks older coding topic/history. This only
 * selects tools; it never grants desktop access or authorizes an action. */
export function isAppOperationRequest(text:string):boolean {
 const command=text.trim().replace(/^(?:hey[, ]+)?echo[, ]+/i,'')
  .replace(/^(?:please\s+|(?:can|could|would|will) you\s+(?:please\s+)?|i (?:want|need)(?: you)? to\s+)/i,'');
 if(!/^(?:open|close|launch|activate|bring|switch|click|tap|type|enter|fill|scroll|drag|move|calculate|compute)\b/i.test(command))return false;
 if(/^close\s+(?:(?:the|this|that|my)\s+)?(?:issue|ticket|pull request|repository|repo|coding project|deal|conversation)\b/i.test(command))return false;
 if(/^(?:calculate|compute)\b/i.test(command)&&! /\b(?:in|using|with)\b.*\b(?:app|calculator)\b/i.test(command))return false;
 if(/^(?:move|drag)\s+(?:(?:a|an|the|my|our)\s+)*(?:file|folder|directory)\b/i.test(command))return false;
 // Opening a development workspace is different from opening its report.
 return !/^(?:open|launch)\s+(?:(?:a|an|the|my|our|existing)\s+)*(?:coding project|source code|repository|repo|dev\s*server)\b/i.test(command);
}
/** Bounded arithmetic acceptance for explicit Calculator tasks, never eval. */
export function calculatorPostcondition(text:string):{expression:string;value:number}|undefined {
 if(!/\bcalculator\b/i.test(text))return undefined;
 const match=text.match(/\b(?:calculate|compute)\s+(-?\d+(?:\.\d+)?)\s*(plus|\+|minus|-|times|\*|multiplied by|divided by|\/)\s*(-?\d+(?:\.\d+)?)(?!\d|\.\d)/i);
 if(!match)return undefined;
 // Never accept a prefix of a compound expression as the entire goal.
 const remainder=text.slice(match.index!+match[0].length).trim();
 if(remainder&&!/^(?:[.!?]\s*|(?:in|using|with)\s+(?:the\s+)?(?:calculator|app)[.!?]?\s*)$/i.test(remainder))return undefined;
 const left=Number(match[1]),right=Number(match[3]);
 const operator=/^(plus|\+)$/i.test(match[2])?'+':/^(minus|-)$/i.test(match[2])?'-':/^(times|\*|multiplied by)$/i.test(match[2])?'*':'/';
 const value=operator==='+'?left+right:operator==='-'?left-right:operator==='*'?left*right:left/right;
 return Number.isFinite(value)?{expression:`${left}${operator}${right}`,value}:undefined;
}
