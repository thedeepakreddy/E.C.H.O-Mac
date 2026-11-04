/** Native runtime initialization only. Does not bind, observe or operate an app. */
import assert from 'node:assert/strict';
import {app} from 'electron';
import {prepareEchoLcuRuntime} from './tools/lcu-runtime.js';
import {closeEchoComputerControl,echoComputerControlBusy} from './tools/lcu-control.js';
import {lcuModelGuidance} from './tools/lcu-guidance.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const profile=mkdtempSync(join(tmpdir(),'echo-lcu-runtime-fixture-'));
app.setPath('userData',profile);
app.whenReady().then(async()=>{
 try{
  await prepareEchoLcuRuntime();
  assert.match(lcuModelGuidance(),/Original public LCU tool descriptors/);
  assert.equal(echoComputerControlBusy(),false);
  await closeEchoComputerControl();
  rmSync(profile,{recursive:true,force:true});
  console.log('PASS reviewed Echo runtime connection, original model surface and clean teardown. No app selection, screenshots or input.');
  app.exit(0);
 }catch(error){console.error(String((error as Error).message??error));await closeEchoComputerControl().catch(()=>{});rmSync(profile,{recursive:true,force:true});app.exit(1);}
});
