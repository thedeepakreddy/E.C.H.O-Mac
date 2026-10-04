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

/** Only an explicit action promise may trigger a first-step coding nudge. */
export function codingContinuationEligible(hadTools:boolean,codingContext:boolean,reply:string):boolean {
 if(hadTools)return true;
 return codingContext&&!/\?\s*$/.test(reply)&&promisesCodingWork(reply);
}
