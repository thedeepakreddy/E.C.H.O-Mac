import {app,BrowserWindow} from 'electron';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackgroundBrowser} from './browser/background.js';
import {showTaskReport,closeTaskReports} from './tasks/report-window.js';
import {taskCoordinator} from './memory/task-state.js';
import type {SupervisedState} from './tasks/supervisor.js';

app.on('window-all-closed',()=>{});
const fixtureRoot=mkdtempSync(join(tmpdir(),'echo-supervised-ui-'));
app.setPath('userData',join(fixtureRoot,'profile'));
process.env.ECHO_DATA_ROOT=fixtureRoot;
const deadline=setTimeout(()=>{console.error('Electron fixture deadline exceeded');app.exit(1);},30000);deadline.unref();
void app.whenReady().then(async()=>{
app.getAppPath=()=>process.cwd();
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<title>Fixture</title><main id="app">Loading</main><script>setTimeout(()=>{document.querySelector("main").textContent="Rendered result 5"},150);window.open("https://example.org")</script>');});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as import('node:net').AddressInfo).port;
try {
  const before=BrowserWindow.getFocusedWindow();
  const browser=await createBackgroundBrowser();
  const page=await browser.read(`http://127.0.0.1:${port}`,{waitForText:'Rendered result 5',timeoutMs:5000});
  assert.equal(page.title,'Fixture');assert.equal(page.text,'Rendered result 5');
  assert.equal(BrowserWindow.getAllWindows().length,0,'hidden browser and denied popup leave no windows');
  assert.equal(BrowserWindow.getFocusedWindow(),before,'background read never steals focus');browser.close();
  const id='supervised.fixture'; const now=Date.now();
  taskCoordinator.create({taskId:id,ownerActorId:id,goal:'Example task'});
  const state:SupervisedState={version:1,id,goal:'Example task',status:'blocked',
    spec:{goal:'Example task',steps:Array.from({length:30},(_,i)=>`Plan step ${i+1}`),acceptanceCriteria:['Observed result']},
    attempt:1,repairs:0,workerTaskIds:[],inspectorTaskIds:[],reviews:[{taskId:'review',viewToken:'0'.repeat(64),verdict:'repair',summary:'Fix the observed result and rerun verification',checks:[],final:true,at:new Date().toISOString()}],
    blockers:['<img src=x onerror="window.__injected=true"> Missing verification'],cleanup:{finished:true,errors:[]},createdAt:now,updatedAt:now};
  await showTaskReport(state,{visible:false});
  const report=BrowserWindow.getAllWindows()[0];
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await report.webContents.executeJavaScript('window.__injected'),undefined,'report text cannot execute code');
  assert.equal(await report.webContents.executeJavaScript('document.querySelectorAll("#report-blockers img").length'),1,'only trusted design icon exists');
  assert.equal(await report.webContents.executeJavaScript('document.scrollingElement.scrollHeight>innerHeight'),true,'long plan scrolls');
  assert.match(await report.webContents.executeJavaScript('document.body.innerText'),/Task blocked/);
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(report.isDestroyed(),false,'report persists independently of turn completion');
  report.setSize(560,800);await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(await report.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true,'narrow window has no horizontal overflow');
  report.webContents.send('task-report-data',{report:{id,title:'Example task',status:'completed',summary:'Observed checks complete',duration:'30 seconds · 1 attempt · 0 repairs',
    steps:['Environment','Dependencies','Implementation','Regression','User flows','Artifacts'].map(title=>({title,status:'completed'})),
    checks:[{title:'Observed result',status:'passed',detail:'Expected value matched'}],reviews:[],outputs:[{label:'Preview',value:'https://example.org'}],blockers:[],cleanup:'All working and inspector agents stopped.'},history:[]});
  report.setSize(1040,1100);await new Promise(resolve=>setTimeout(resolve,100));
  mkdirSync('/tmp/echo-report-ui',{recursive:true});writeFileSync('/tmp/echo-report-ui/report-wide.png',(await report.webContents.capturePage()).toPNG());
  report.setSize(560,900);await new Promise(resolve=>setTimeout(resolve,80));writeFileSync('/tmp/echo-report-ui/report-narrow.png',(await report.webContents.capturePage()).toPNG());
  await report.webContents.executeJavaScript('document.querySelector("#actions-button").click()');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(report.isDestroyed(),true,'Close button closes the report');
  console.log('Electron dynamic background read, focus isolation, popup denial, report persistence, XSS protection, scrolling, responsive layout and close passed');
} finally {closeTaskReports();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));clearTimeout(deadline);rmSync(fixtureRoot,{recursive:true,force:true});app.quit();}
}).catch(error=>{console.error(error);app.exit(1);});
