import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {installPreviewBridge} from './preview_fixtures.mjs';
const root=resolve(import.meta.dirname,'..');mkdirSync('/tmp/echo-panel-companion-test',{recursive:true});app.setPath('userData','/tmp/echo-panel-companion-test');installPreviewBridge(ipcMain);
let reads=[],actions=[],fail=false;const now=Date.now();
const task={id:'work-a',kind:'task',title:'Check the report',status:'running',updatedAt:now,revision:1,summary:'Checked three source files.',privateMode:false,live:true};
const blocked={...task,id:'blocked-a',title:'Connect calendar',status:'blocked',summary:'Calendar permission is missing.'};
const project={...task,id:'project-a',kind:'project',title:'Website',status:'waiting-for-input',question:{id:'question-a',text:'Which day should bookings open?',options:['Monday','Friday']}};
let memory={id:'memory-a',revision:1,summary:'<img src=x onerror="window.injected=true"> Prefer morning meetings.',kind:'preference',layer:'semantic',status:'active',source:'user',trust:'user_asserted',evidence:[],createdAt:new Date(now).toISOString(),observedAt:null,confidence:null,privacy:'configured_providers'};
let state={checkedAt:now,approval:{id:'exact-approval-a',question:'May I remove the old file?',expiresAt:now+30000},work:[task,blocked,project],needs:[blocked,project],now:[task],next:'An action is waiting for your decision.',phone:{active:false,expiresAt:null,queued:0,lastDeliveredAt:null,message:'Phone updates are off.'},scope:{projectId:'Echo'},memory:{scope:{projectId:'Echo'},revision:1,total:1,items:[memory]}};
ipcMain.removeHandler('control:companion');ipcMain.handle('control:companion',async(_e,r)=>{reads.push(r);await new Promise(r=>setTimeout(r,15));if(fail)throw Error('Private store details');const d=structuredClone(state);if(!r.memory)delete d.memory;else if(r.query&&!memory.summary.toLowerCase().includes(r.query.toLowerCase()))d.memory.items=[];return d;});
ipcMain.removeHandler('control:action');ipcMain.handle('control:action',(_e,a)=>{actions.push(a);return {ok:true,message:'Fixture action accepted'};});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1180,height:760,show:false,webPreferences:{preload:resolve(root,'dist/preload.cjs'),contextIsolation:true,sandbox:true}});let failed=false;const errors=[];win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3&&!msg.includes('Content Security Policy'))errors.push(msg);});
 const js=code=>win.webContents.executeJavaScript(code);
 const settle=()=>new Promise(r=>setTimeout(r,100));
 try{
  win.showInactive();await win.loadFile(resolve(root,'renderer/control-panel.html'));await settle();
  assert.equal(reads[0].memory,false,'overview never fetches memory payloads');
  await js(`document.querySelector('[data-view="day"]').click()`);await settle();
  assert.equal(await js('activeView'),'day');assert.match(await js(`byId('companion-now').textContent`),/Check the report/);
  await js(`byId('companion-needs').querySelector('[data-approval="false"]').click()`);assert.equal(actions.at(-1).id,'exact-approval-a');assert.equal(actions.at(-1).approved,false);await settle();
  await js(`(()=>{const f=byId('companion-needs').querySelector('[data-project-answer]');f.querySelector('textarea').value='Friday';f.querySelector('textarea').focus();})()`);
  state.work[2].revision=2;state.needs[1].revision=2;
  await js(`byId('companion-phone-start').focus();window.echoCompanionUI.sync()`);await settle();assert.equal(await js(`byId('companion-needs').querySelector('textarea').value`),'Friday','poll does not erase a typed answer');
  await js(`byId('companion-needs').querySelector('[data-project-answer]').requestSubmit()`);
  assert.equal(actions.at(-1).questionId,'question-a');assert.equal(actions.at(-1).revision,1,'answer retains displayed revision, allowing main to reject stale submission');await settle();
  await js(`byId('companion-phone-start').click()`);assert.equal(actions.at(-1).enabled,true);await settle();
  state.phone={...state.phone,active:true,expiresAt:now+86400_000,message:'Delivered to Phone Missions.'};await js(`window.echoCompanionUI.sync()`);await settle();await js(`byId('companion-phone-stop').click()`);assert.equal(actions.at(-1).enabled,false);await settle();
  await js(`document.querySelector('[data-view="brain"]').click()`);await settle();assert.equal(reads.at(-1).memory,true);
  assert.equal(await js(`!!byId('companion-memories').querySelector('img')||!!window.injected`),false);
  await js(`(()=>{const f=byId('companion-memories').querySelector('[data-memory-correct]');f.closest('details').open=true;f.querySelector('textarea').value='Prefer afternoon meetings';f.querySelector('textarea').focus();})()`);
  state.memory.revision=2;state.memory.items[0].revision=2;await js(`byId('companion-query').focus();window.echoCompanionUI.sync()`);await settle();
  assert.equal(await js(`byId('companion-memories').querySelector('textarea').value`),'Prefer afternoon meetings');
  await js(`byId('companion-memories').querySelector('[data-memory-correct]').requestSubmit()`);assert.equal(actions.at(-1).revision,1);assert.equal(actions.at(-1).text,'Prefer afternoon meetings');await settle();
  await js(`byId('companion-memories').querySelector('[data-memory-forget]').click()`);assert.equal(actions.at(-1).type,'memory-forget');assert.equal(actions.at(-1).id,'memory-a');await settle();
  await js(`byId('companion-query').value='unmatched';byId('companion-search').requestSubmit()`);await settle();assert.equal(reads.at(-1).query,'unmatched');assert.match(await js(`byId('companion-memories').textContent`),/No memories match/);
  fail=true;await js(`window.echoCompanionUI.sync()`);await settle();assert.match(await js(`byId('companion-memory-status').textContent`),/Couldn’t read/);assert.ok(!await js(`document.body.textContent.includes('Private store details')`));fail=false;
  await js(`Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))`);const count=reads.length;await settle();assert.equal(reads.length,count);
  await js(`Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))`);await settle();assert.ok(reads.length>count);
  await js(`byId('companion-query').value='';byId('companion-search').requestSubmit()`);await settle();
  for(const width of [1180,900,680]){win.setSize(width,600);for(let i=0;i<30;i++){if(await js('innerWidth')===width)break;await new Promise(r=>setTimeout(r,50));}for(const view of ['day','brain']){await js(`setView('${view}')`);await settle();const layout=await js(`(()=>{const scroll=document.querySelector('#${view}-view .companion-scroll');scroll.scrollTop=scroll.scrollHeight;const r=scroll.getBoundingClientRect();return {fits:document.documentElement.scrollWidth<=innerWidth,last:scroll.lastElementChild.getBoundingClientRect().bottom<=r.bottom+1,viewRight:document.querySelector('#${view}-view').getBoundingClientRect().right<=innerWidth+1};})()`);assert.ok(layout.fits&&layout.last&&layout.viewRight,`${view} fits and scrolls at ${width}: ${JSON.stringify(layout)}`);}}
  win.setSize(1180,760);await js(`setView('day');document.querySelector('#day-view .companion-scroll').scrollTop=0`);await settle();await writeFile('/tmp/echo-mac-companion-panel.png',(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);console.log('PASS companion panel navigation, real bridge actions, exact IDs and displayed revisions, input preservation, lazy memory, safe text, query/outages, visibility, scroll and responsive layout.');
 }catch(e){failed=true;console.error(e);}finally{win.destroy();app.exit(failed?1:0);}
});
