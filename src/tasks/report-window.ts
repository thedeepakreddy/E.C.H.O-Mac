import {join,isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {getAppPath} from '../utils/appPath.js';
import {taskCoordinator} from '../memory/task-state.js';
import type {SupervisedState} from './supervisor.js';
import {taskReportData,type ReportData} from './report-data.js';
let window:Electron.BrowserWindow|undefined;
let closing=false, selected:string|undefined;
const reports=new Map<string,ReportData>();
let registered=false;
async function ensureWindow():Promise<Electron.BrowserWindow> {
  const {BrowserWindow,ipcMain,shell}=await import('electron');
  if(!registered) {
    registered=true;
    const owns=(event:Electron.IpcMainEvent)=>window && !window.isDestroyed() && event.sender===window.webContents;
    ipcMain.on('task-report-close',event=>{if(owns(event)) window!.close();});
    ipcMain.on('task-report-select',(event,id)=>{if(owns(event) && typeof id==='string' && reports.has(id)) {selected=id;sendData();}});
    ipcMain.on('task-report-output',(event,index)=>{
      if(!owns(event) || !Number.isInteger(index)) return;
      const value=reports.get(selected ?? '')?.outputs[index]?.value;
      if(!value) return;
      try {const url=new URL(value);if(['http:','https:'].includes(url.protocol) && !url.username && !url.password) {void shell.openExternal(url.href);return;}}catch{}
      // Reveal local output; never execute a model-produced file or shell URL.
      if(isAbsolute(value) && existsSync(value)) shell.showItemInFolder(value);
    });
  }
  if(window && !window.isDestroyed()) return window;
  const created=new BrowserWindow({show:false,title:'Echo · Task report',width:1040,height:900,minWidth:520,minHeight:500,backgroundColor:'#030e15',
    webPreferences:{preload:join(getAppPath(),'dist','report-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webgl:false}});
  window=created;
  created.webContents.setWindowOpenHandler(({url}) => {
    try {const target=new URL(url);if(target.protocol==='https:'&&!target.username&&!target.password){void shell.openExternal(target.href);}}catch{}
    return {action:'deny'};
  });
  created.webContents.on('will-navigate',event=>event.preventDefault());
  created.on('closed',()=>{if(window===created) window=undefined;});
  await created.loadFile(join(getAppPath(),'renderer','task-report.html'));
  return created;
}
function sendData():void {
  if(window && !window.isDestroyed()) window.webContents.send('task-report-data',{
    report:reports.get(selected ?? ''),history:[...reports.values()].map(r=>({id:r.id,title:r.title,status:r.status}))});
}
/** No expiry timer and no relation to voice turnEnd. Only user close or app shutdown closes this window. */
export async function showTaskReport(state:SupervisedState, options:{visible?:boolean}={}):Promise<void> {
  if(closing) return;
  const records=[...state.workerTaskIds,...state.inspectorTaskIds].map(id=>taskCoordinator.get(id)).filter((t):t is NonNullable<typeof t>=>!!t);
  reports.set(state.id,taskReportData(state,records));selected=state.id;
  if(reports.size>20) reports.delete(reports.keys().next().value!);
  const created=await ensureWindow();if(closing) {created.destroy();return;}
  sendData();if(options.visible!==false) {created.show();created.focus();}
}
export function closeTaskReports():void {closing=true;if(window && !window.isDestroyed()) window.destroy();window=undefined;reports.clear();}
export function removeTaskReport(id:string):void {
  reports.delete(id);if(selected!==id)return;
  selected=[...reports.keys()].at(-1);
  if(selected)sendData();else if(window && !window.isDestroyed())window.close();
}
