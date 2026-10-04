import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('taskReport',{
  close:()=>ipcRenderer.send('task-report-close'),
  open:(index:number)=>ipcRenderer.send('task-report-output',index),
  select:(id:string)=>ipcRenderer.send('task-report-select',id),
  onData:(listener:(value:unknown)=>void)=>{ipcRenderer.on('task-report-data',(_event,data)=>listener(data));},
});
