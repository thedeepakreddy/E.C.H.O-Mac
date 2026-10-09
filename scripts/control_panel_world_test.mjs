/** Real Electron navigation, bridge, freshness, lifecycle and layout checks. No model/audio starts. */
import assert from 'node:assert/strict';
import {app, BrowserWindow, ipcMain} from 'electron';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {writeFile} from 'node:fs/promises';
import {installPreviewBridge} from './preview_fixtures.mjs';
const root=resolve(import.meta.dirname,'..');
app.setPath('userData',resolve(tmpdir(),'echo-panel-world-test'));
installPreviewBridge(ipcMain);
let calls=0, external='', actions=[];
const now=Date.now();
const initial={checkedAt:now,feeds:Object.fromEntries(['conflicts','earthquakes','fires','weather'].map(n=>[n,{status:'current',updatedAt:now,sourceUpdatedAt:now-60000}])),
 conflicts:[{label:'<img src=x onerror="window.injected=true">',severity:'war',description:'Conflict observation',latest:{title:'Sourced update',url:'https://example.org/report'}}],
 earthquakes:{count:2,top:[{magnitude:5.2,place:'Test coast',at:now-60000,depthKm:12,tsunami:true,url:'https://earthquake.usgs.gov/'}]},tsunamis:[{place:'Test coast'}],fires:{count:2010,highConfidence:42},
 storms:[{title:'Test storm',type:'Storm',severity:'High',source:'NASA EONET'}]};
let current=structuredClone(initial), fail=false;
ipcMain.removeHandler('control:world');
ipcMain.handle('control:world',async()=>{calls++;await new Promise(r=>setTimeout(r,40));if(fail)throw Error('Private upstream error');return structuredClone(current);});
ipcMain.removeHandler('control:action');ipcMain.handle('control:action',(_e,a)=>{actions.push(a);return {ok:true};});
ipcMain.on('control:open-url',(_e,url)=>{external=url;});
app.whenReady().then(async () => {
const win=new BrowserWindow({width:1180,height:760,show:false,webPreferences:{preload:resolve(root,'dist/preload.cjs'),contextIsolation:true,sandbox:true}});
let failed=false;
const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!message.includes('Content Security Policy'))errors.push(message);});
try{
 win.showInactive();
 await win.loadFile(resolve(root,'renderer/control-panel.html'));
 const boot=await win.webContents.executeJavaScript(`(() => {window.worldDelays=[];const original=setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms===30000)worldDelays.push(ms);return original(fn,ms,...args);};return activeView;})()`);
 assert.equal(boot,'overview');assert.equal(calls,0,'closed World page never fetches feeds');
 await win.webContents.executeJavaScript(`(async()=>{document.querySelector('.quick-controls [data-view="world"]').click();await worldLoading;})()`);
 assert.equal(calls,1);
 const first=await win.webContents.executeJavaScript(`(() => ({view:activeView,title:byId('world-title').textContent,stats:[...byId('world-stats').querySelectorAll('strong')].map(n=>n.textContent),timer:worldTimer!==null,delay:worldDelays.at(-1),safe:!byId('world-list').querySelector('img')&&!window.injected,count:byId('world-list').children.length}))()`);
 assert.equal(first.view,'world');assert.deepEqual(first.stats,['1','2','2,010','1']);assert.ok(first.safe);assert.equal(first.delay,30000);assert.ok(first.timer);assert.equal(first.count,5);
 await win.webContents.executeJavaScript(`document.querySelector('[data-world-filter="quake"]').click()`);
 assert.equal(await win.webContents.executeJavaScript(`byId('world-list').children.length`),1);
 await win.webContents.executeJavaScript(`byId('world-list').querySelector('button').click()`);assert.equal(external,'https://earthquake.usgs.gov/');
 await win.webContents.executeJavaScript(`document.querySelector('#world-view [data-action="osiris"]').click()`);assert.equal(actions.at(-1).type,'osiris');
 await win.webContents.executeJavaScript(`document.querySelector('[data-world-filter="hazard"]').click()`);assert.equal(await win.webContents.executeJavaScript(`byId('world-list').children.length`),3);
 const before=calls;
 await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<20;i++)byId('world-refresh').click();await worldLoading;})()`);assert.equal(calls,before+1,'refresh coalesces repeated clicks');
 fail=true;
 await win.webContents.executeJavaScript(`(async()=>{await loadWorld();})()`);
 const outage=await win.webContents.executeJavaScript(`({notice:byId('world-notice').textContent,count:byId('world-stats').querySelectorAll('strong')[2].textContent,body:byId('world-view').textContent})`);
 assert.equal(outage.count,'2,010');assert.match(outage.notice,/last saved/);assert.ok(!outage.body.includes('Private upstream'));
 fail=false;current.feeds.fires={status:'stale',updatedAt:now-60000,sourceUpdatedAt:now-120000};
 await win.webContents.executeJavaScript(`(async()=>{await loadWorld();})()`);
 assert.match(await win.webContents.executeJavaScript(`byId('world-notice').textContent`),/Fire detections.*last copy/);
 current=structuredClone(initial);current.fires={count:null,highConfidence:null};current.feeds.fires={status:'unavailable',updatedAt:null,sourceUpdatedAt:null};
 await win.webContents.executeJavaScript(`(async()=>{await loadWorld();})()`);
 assert.equal(await win.webContents.executeJavaScript(`byId('world-stats').querySelectorAll('strong')[2].textContent`),'—');
 assert.equal(await win.webContents.executeJavaScript(`!!byId('world-list').textContent.match(/0 fire detections/)`),false);
 const visibility=await win.webContents.executeJavaScript(`(async()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const hiddenStops=worldTimer===null;Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));await worldLoading;const foregroundRestarts=worldTimer!==null;setView('overview');return {hiddenStops,foregroundRestarts,leavingStops:worldTimer===null};})()`);
 assert.deepEqual(visibility,{hiddenStops:true,foregroundRestarts:true,leavingStops:true});
 current=structuredClone(initial);current.conflicts=[{label:'Preview region',severity:'war',description:'',latest:{title:'A sourced conflict update',url:'https://example.org/report'}}];
 await win.webContents.executeJavaScript(`(async()=>{setView('world');await worldLoading;document.querySelector('[data-world-filter="all"]').click();})()`);
 const sizes=[];
 for(const [width,height]of [[1180,760],[900,600],[780,560],[680,500]]){
  win.setSize(width,height);
  for(let i=0;i<30;i++){
    if(await win.webContents.executeJavaScript('innerWidth')===width)break;
    await new Promise(r=>setTimeout(r,50));
  }
  const result=await win.webContents.executeJavaScript(`(()=>{const pane=document.querySelector('.world-scroll');pane.scrollTop=pane.scrollHeight;const rect=pane.getBoundingClientRect();return {width:innerWidth,fits:document.querySelector('.quick-controls').getBoundingClientRect().right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('#world-view > *')].every(e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth+1;}),scrolls:pane.scrollTop>0,lastReachable:document.querySelector('.world-sources').getBoundingClientRect().bottom<=rect.bottom+1};})()`);
  assert.equal(result.width,width);assert.ok(result.fits,`World fits at ${width}`);assert.ok(result.scrolls);assert.ok(result.lastReachable);sizes.push(result);
 }
 win.setSize(1180,760);await win.webContents.executeJavaScript(`document.querySelector('.world-scroll').scrollTop=0`);await new Promise(r=>setTimeout(r,100));
 await writeFile('/tmp/echo-mac-world-panel.png',(await win.webContents.capturePage()).toPNG());
 assert.deepEqual(errors,[]);
 console.log('PASS World panel: navigation, four counts, filters, safe links/content, Osiris, refresh coalescing, outages, unknown counts, hidden/foreground lifecycle, scroll and layout at four sizes.');
 console.log(JSON.stringify(sizes));
}catch(error){failed=true;console.error(error);}finally{win.destroy();app.exit(failed?1:0);}

});
