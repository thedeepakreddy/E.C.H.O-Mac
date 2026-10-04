/** Status questions must not need a cloud request or count as a build answer. */
export function isBuildStatusRequest(text:string):boolean {
 const clean=text.trim().replace(/^(?:hey[, ]+)?echo[, ]+/i,'').replace(/[.!?]+$/,'').trim();
 return /^(?:(?:did|have) you (?:finish|finished|complete|completed)(?: (?:it|the (?:build|project|website|app)))?(?: yet)?|are you (?:done|finished|stuck|still (?:working|building))|is (?:it|the (?:build|project|website|app)) (?:done|finished|ready|still running)|(?:what(?:'s| is) (?:the )?(?:status|progress)|what are you doing|how (?:far|much) (?:have you (?:got|done)|is done)|any (?:update|updates|progress)))$/i.test(clean) ||
 /\b(?:build|project|coding)\b.*\b(?:status|progress|doing|finished)\b|\b(?:status|progress)\b.*\b(?:build|project)\b/i.test(clean);
}
