/** A bounded single-window close goal. Never match a title merely mentioned in
 * another clause, or treat a closed window as proof of an unrelated second task.
 */
export function requestedWindowClose(request:string,title:string,app:string):boolean {
 if(!title.trim()||!app.trim())return false;
 const literal=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 let command=request.trim().replace(/^(?:hey[, ]+)?echo[, ]+/i,'')
  .replace(/^(?:please\s+|(?:can|could|would|will) you\s+(?:please\s+)?|i (?:want|need)(?: you)? to\s+)/i,'');
 command=command.replace(new RegExp(`^(?:open|activate|focus)\\s+(?:the\\s+)?${literal(app)}\\s+and\\s+`,'iu'),'');
 const prefix=/^(?:close\s+|(?:click|tap)\s+(?:the\s+)?close button\s+(?:on|of|in)\s+)/i;
 if(!prefix.test(command))return false;
 const target=command.replace(prefix,'').replace(/[.!?]\s*$/,'').trim();
 const suffix=`(?:\\s+(?:window|folder))?(?:\\s+(?:in|of)\\s+${literal(app)})?(?:\\s+(?:which|that) is on my screen)?`;
 const named=new RegExp(`^(?:the\\s+)?["“']?${literal(title)}["”']?${suffix}$`,'iu');
 const deictic=new RegExp(`^(?:(?:the|this|that|current|active|frontmost|selected)\\s+)?window(?:\\s+(?:in|of)\\s+${literal(app)})?$`,'iu');
 return named.test(target)||deictic.test(target);
}
