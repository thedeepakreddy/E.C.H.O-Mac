/** Legacy target ranking remains readable; input is owned exclusively by LCU.
 * Fixtures only: never open, edit, close or quit a user's application.
 */
import assert from 'node:assert/strict';
import * as ax from './tools/ax.js';
import {deepHookClick} from './tools/deep-hook.js';
const elements:ax.AxElement[]=['Bold','Italic'].map((label,i)=>({i,role:'AXButton',label,value:'',path:`0.${i}`,x:100+i*40,y:100,w:30,h:30,enabled:true,press:true}));
assert.equal(ax.rank(elements,'bold')[0].label,'Bold');
assert.equal(ax.rank(elements,'the italic button')[0].label,'Italic');
assert.equal(ax.rank(elements,'launch the rockets').length,0);
const refused=await ax.press(12345,'0.0');
assert.equal(refused.ok,false);assert.match(refused.error!,/LCU|disabled/);
const background=await deepHookClick(12345,100,100);
assert.equal(background.ok,false);assert.match(background.message,/disabled|LCU/);
console.log('5/5 accessibility fixture checks passed; no apps or documents touched');
