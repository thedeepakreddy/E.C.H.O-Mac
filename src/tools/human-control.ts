import {AsyncLocalStorage} from 'node:async_hooks';
import {currentAgentRunContext} from '../agent-replay/context.js';
import {currentDesktopTask,acquireDesktopTask,releaseDesktopTask} from '../tasks/desktop-lane.js';
import {echoComputerControlBusy} from './lcu-control.js';
const humanControl=new AsyncLocalStorage<boolean>();
const HUMAN_LANE='echo-human-input';
let queue:Promise<unknown>=Promise.resolve();
let pending=0;
export function humanComputerInputBlocked():boolean {const owner=currentDesktopTask();return echoComputerControlBusy()||!!owner&&owner!==HUMAN_LANE;}
export function humanComputerInputPending():boolean{return pending>0;}
/** Host-only entry point for authenticated Phone input. Never a tool argument. */
export async function withHumanComputerControl<T>(action:()=>T|Promise<T>):Promise<T> {
 if(currentAgentRunContext())throw Error('An agent cannot claim human computer-control authority.');
 if(humanControl.getStore())return action();
 if(humanComputerInputBlocked())throw Error('Echo owns the desktop. Stop Echo before using the Phone controls.');
 pending++;
 const work=queue.then(async()=>{
  if(humanComputerInputBlocked()||!acquireDesktopTask(HUMAN_LANE))throw Error('Echo owns the desktop. Stop Echo before using the Phone controls.');
  try{return await humanControl.run(true,action);}finally{releaseDesktopTask(HUMAN_LANE);}
 });
 queue=work.catch(()=>{});
 try{return await work;}finally{pending--;}
}
export function isHumanComputerControl():boolean{return humanControl.getStore()===true&&!currentAgentRunContext();}
