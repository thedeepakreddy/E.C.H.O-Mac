const byId=id=>document.getElementById(id);
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const sections={status:'report-status',steps:'report-checklist',checks:'report-tests',outputs:'report-outputs',blockers:'report-blockers',cleanup:'report-cleanup'};
const icons={};
for(const [key,id] of Object.entries(sections)){
  const card=byId(id),icon=card.querySelector('img');icons[key]=icon;card.replaceChildren(icon,node('div',undefined,'card-summary'));
}
const history=node('select');history.id='report-history';history.setAttribute('aria-label','Saved task reports');history.addEventListener('change',()=>window.taskReport?.select(history.value));byId('page-flow').insertBefore(history,byId('report'));
byId('actions-button').addEventListener('click',()=>window.taskReport?.close());
function card(key,title,summary,badge){
  const body=byId(sections[key]).querySelector('.card-summary');body.replaceChildren();
  if(badge)body.append(node('span',badge,'badge'));body.append(node('h2',title),node('p',summary));return body;
}
function rows(parent,items){
  const list=node('ul',undefined,'rows');
  for(const item of items){const li=node('li');if(item.status){const status=node('span',item.status,'row-status');status.dataset.status=item.status;li.append(status);}li.append(node('span',item.title));if(item.detail)li.append(node('p',item.detail,'detail'));list.append(li);}
  parent.append(list);
}
window.renderTaskReport=({report,history:reports=[]})=>{
  if(!report)return;
  history.replaceChildren(...reports.map(r=>{const option=node('option',`${r.status} · ${r.title}`);option.value=r.id;return option;}));history.value=report.id;history.hidden=reports.length<2;
  byId('header-heading').textContent=report.status==='completed'?'Task verified':`Task ${report.status}`;
  byId('header-text').textContent=report.title;
  byId('header-icon').src=report.status==='completed'?byId('header-icon').dataset.success:icons.blockers.src;
  card('status','Status',report.duration,report.status==='completed'?'Verified':report.status);
  const steps=card('steps','Plan',report.summary,`${report.steps.filter(s=>s.status==='completed').length} / ${report.steps.length}`);
  rows(steps,report.steps);
  if(report.reviews.length){const details=node('details'),summary=node('summary',`Inspector reviews and repairs (${report.reviews.length})`);details.append(summary);rows(details,report.reviews.map(r=>({title:r.title,detail:r.summary})));steps.append(details);}
  const passed=report.checks.filter(c=>c.status==='passed').length;
  rows(card('checks','Verification checks',report.checks.length?'Observed tool checks; untested behavior remains unverified.':'No verification checks recorded.',`${passed} / ${report.checks.length}`),report.checks);
  const outputs=card('outputs','Output',report.outputs.length?'Files, previews and recorded results.':'No output artifacts recorded.');
  report.outputs.forEach((output,index)=>{const row=node('div',undefined,'rows');row.append(node('p',output.label||'Output'));if(/^(https?:\/\/|\/)/.test(output.value)){const button=node('button',output.value,'output');button.addEventListener('click',()=>window.taskReport?.open(index));row.append(button);}else row.append(node('p',output.value,'detail'));outputs.append(row);});
  rows(card('blockers','Blockers',report.blockers.length?'Further work or user input is required.':'No unresolved blockers recorded.',String(report.blockers.length)),report.blockers.map(title=>({title})));
  card('cleanup','Agent cleanup',report.cleanup,report.cleanup.startsWith('All ')?'Stopped':'Incomplete');
};
byId('header-icon').dataset.success=byId('header-icon').src;
byId('header-heading').textContent='Task report';byId('header-text').textContent='Waiting for the recorded task outcome.';
for(const key of Object.keys(sections))card(key,{status:'Status',steps:'Plan',checks:'Verification checks',outputs:'Output',blockers:'Blockers',cleanup:'Agent cleanup'}[key],'No task data loaded.');
window.taskReport?.onData(window.renderTaskReport);
