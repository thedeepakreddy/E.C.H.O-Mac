/* A new page, using Echo's existing styles and restricted bridge. Polling never replaces task inputs. */
(() => {
 let data=null,timer=null,loading=null,version=0,parentId=null,pending=null,loadError=false,teamIds=null;
 const visible=()=>activeView==='bots'&&!document.hidden;
 const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=String(text);return n;};
 const status=t=>byId('bots-status').textContent=t;
 function role(){const b=data?.bots.find(b=>b.id===byId('bots-member').value);byId('bots-role').textContent=b?`${b.description||b.role} · ${b.mode}`:'';
  byId('bots-team').hidden=!b?.team;if(!b?.team)return;
  teamIds??=new Set(b.defaultAgentIds||[]);const box=byId('bots-team-members');box.replaceChildren();
  for(const member of data.bots.filter(b=>!b.team)){const label=node('label','switch-row'),copy=node('span','',member.name),input=node('input','');input.type='checkbox';input.value=member.id;input.checked=teamIds.has(member.id);input.onchange=()=>{input.checked?teamIds.add(member.id):teamIds.delete(member.id);pending=null;};label.append(copy,input);box.append(label);}
 }
 function paint(d){if(loadError){status("");loadError=false;}data=d;const select=byId('bots-member'),chosen=select.value;
  if(JSON.stringify(d.bots.map(b=>[b.id,b.revision]))!==select.dataset.signature){select.replaceChildren(...d.bots.map(b=>{const o=node('option','',b.name);o.value=b.id;return o;}));if(d.bots.some(b=>b.id===chosen))select.value=chosen;else if(d.bots.some(b=>b.id==='research'))select.value='research';select.dataset.signature=JSON.stringify(d.bots.map(b=>[b.id,b.revision]));role();}
  const list=byId('bots-jobs');list.replaceChildren();if(!d.jobs.length)list.append(node('p','companion-muted','No bot runs yet. Give a bot a clear result to deliver.'));
  for(const j of d.jobs){const row=node('article','companion-row'),shown=new Set();const copy=text=>{if(!text||shown.has(text))return;shown.add(text);row.append(node('p','companion-copy',text));};row.append(node('h3','',`${j.botName} · ${j.goal}`),node('p','companion-muted',`${j.status} · ${new Date(j.updatedAt).toLocaleString()}`));
   for(const s of j.steps||[]){row.append(node('p','companion-muted',`${s.name||s.id||'Specialist'} · ${s.status}`));if(s.result?.summary&&s.result.summary!==j.result?.summary)copy(s.result.summary);}
   copy(j.result?.summary);
   for(const a of j.result?.artifacts||[]){if(shown.has(a.value))continue;row.append(node('h3','',a.label||a.kind));copy(a.value);}
   if(j.result?.verificationRefs?.length)row.append(node('p','companion-muted',`Evidence: ${j.result.verificationRefs.join(' · ')}`));
   for(const b of j.result?.blockers||[])row.append(node('p','companion-copy',`Needs attention: ${b}`));
   if(j.live){const stop=node('button','secondary-button','Stop');stop.onclick=async()=>{stop.disabled=true;try{const r=await act({type:'stop-bot',missionId:j.id});status(r.message||'');await load();}finally{stop.disabled=false;}};row.append(stop);}
   else {const follow=node('button','secondary-button','Follow up');follow.disabled=!d.bots.some(b=>b.id===j.botId);follow.onclick=()=>{parentId=j.id;byId('bots-member').value=j.botId;teamIds=j.agentIds?new Set(j.agentIds):null;role();byId('bots-followup').hidden=false;byId('bots-followup').textContent=`Continuing: ${j.goal}. Saved results will be supplied as context.`;byId('bots-fresh').hidden=false;byId('bots-goal').focus();};row.append(follow);}
   const inspect=node('button','secondary-button','Inspect in Agents');inspect.onclick=()=>window.echoAgentsUI?.inspect(j.id);row.append(inspect);list.append(row);
  }
 }
 async function load(){if(loading)return loading;if(!visible()||!bridge?.bots)return;const v=version;loading=(async()=>{try{const d=await bridge.bots();if(v===version&&visible())paint(d);}catch{loadError=true;status('Couldn’t read bot runs. Refresh to retry.');}finally{loading=null;clearTimeout(timer);if(visible())timer=setTimeout(load,2500);}})();return loading;}
 function sync(){version++;clearTimeout(timer);if(loading)loading.finally(()=>{if(visible())void load();});else void load();}
 function fresh(){parentId=null;pending=null;byId('bots-followup').hidden=true;byId('bots-fresh').hidden=true;}
 byId('bots-fresh').onclick=fresh;byId('bots-member').onchange=()=>{fresh();teamIds=null;role();};byId('bots-refresh').onclick=sync;
 byId('bots-manage').onclick=()=>{setView('tasks');byId('board-manage')?.click();};
 byId('bots-run').onsubmit=async e=>{e.preventDefault();const bot=data?.bots.find(b=>b.id===byId('bots-member').value),goal=byId('bots-goal').value.trim();if(!bot||!goal)return;const button=e.currentTarget.querySelector('button[type=submit]');if(button.disabled)return;
  const agentIds=bot.team?[...(teamIds||new Set(bot.defaultAgentIds||[]))].sort():undefined;if(bot.team&&!agentIds.length){status('Choose at least one specialist. Lead will combine its reports.');return;}const key=JSON.stringify([bot.id,bot.revision,goal,parentId,agentIds]);if(pending?.key!==key)pending={key,id:crypto.randomUUID()};button.disabled=true;status('Starting…');
  try{const r=await act({type:'run-bot',name:bot.id,botRevision:bot.revision,goal,requestId:pending.id,...(agentIds?{agentIds}:{}),...(parentId?{parentId}:{})});status(r.message||'');if(r.ok){if(byId('bots-goal').value.trim()===goal)byId('bots-goal').value='';fresh();}await load();}catch{status('Couldn’t reach Echo. Retry keeps the same request ID.');}finally{button.disabled=false;}
 };
 document.addEventListener('visibilitychange',sync);window.addEventListener('pagehide',()=>{version++;clearTimeout(timer);});window.echoBotsUI={sync,load,async prefill({name,goal,agentIds}={}){setView('bots');await load();if(!data)await load();if(name&&data?.bots.some(b=>b.id===name)){byId('bots-member').value=name;fresh();teamIds=agentIds?new Set(agentIds):null;role();}if(typeof goal==='string')byId('bots-goal').value=goal;byId('bots-goal').focus();}};
})();
