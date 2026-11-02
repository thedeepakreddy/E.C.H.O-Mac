/**
 * Independent verification of Mac bot runs: a single Research/Analyse/Write/Plan
 * run gets a read-only Review step that depends on it, and the pages an agent
 * read are checked against what its Result attributes to them.
 *
 *   npm run botverifytest
 */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'echo-botverify-'));process.env.ECHO_DATA_ROOT=root;process.env.ECHO_MEMORY_ROOT=join(root,'memory');process.env.JARVIS_FLEET_DIR=root;process.env.JARVIS_REMOTE_DIR=root;process.env.ECHO_MCP='0';
const {createMacBots,botRevision,TEAM_BOT_ID,VERIFY_TASK}=await import('./frontier/bots.js');
const {getFleetMember}=await import('./frontier/fleet.js');
const {SwarmManager}=await import('./frontier/swarm.js');
const {taskCoordinator}=await import('./memory/task-state.js');
const {recordSource,sourcesFor}=await import('./frontier/source-ledger.js');

class FakeBrain extends EventEmitter {sent='';send(text:string){this.sent=text;}interrupt(){}async stop(){}}
const brains:FakeBrain[]=[];const host=new SwarmManager();
const bots=createMacBots(host,()=>({makeBrain:()=>{const b=new FakeBrain();brains.push(b);return b;}}),()=>({projectId:'verify'}),()=>true);
const req=(name:string,goal:string,extra:Record<string,unknown>={})=>({name,goal,botRevision:name===TEAM_BOT_ID?bots.revision(TEAM_BOT_ID):botRevision(getFleetMember(name)!),requestId:randomUUID(),...extra});
const submit=(missionId:string,taskId:string,r:{status?:string;summary:string;artifacts?:any[];verificationRefs?:string[]})=>{const t=host.getMission(missionId)!.tasks[taskId];taskCoordinator.submitResult(t.taskId!,t.actorId!,{status:(r.status??'completed') as any,summary:r.summary,artifacts:r.artifacts??[{kind:'text',label:'Deliverable',value:r.summary}],verificationRefs:r.verificationRefs??[],blockers:[]});brains.at(-1)!.emit('turnEnd');};
let checks=0;const ok=(c:boolean,m:string)=>{assert.ok(c,m);checks++;console.log(`  ✓ ${m}`);};

try {
 console.log('\nIndependent Review step\n');
 const run=bots.run(req('research','How was the corpus deduplicated?'));ok(run.ok===true,'a single Research run starts');
 const id=run.data!.missionId!,m=host.getMission(id)!,v=m.tasks[VERIFY_TASK];
 ok(!!v&&v.profile==='review'&&v.readOnly===true&&JSON.stringify(v.dependsOn)===JSON.stringify(['research']),'it gets a read-only Review step that depends on Research');
 ok(v.status==='pending'&&brains.length===1,'Review waits until Research finishes');
 ok(bots.list().jobs[0].botName==='Research'&&bots.list().jobs[0].botId==='research','the run is still shown as Research, not a team');
 // Research read a page; its Result must match it.
 const researchTask=host.getMission(id)!.tasks.research;
 recordSource(researchTask.taskId!,'https://corpus.example/report','The filtered corpus was deduplicated with MinHash using 5-grams. It has 4,200 shards.');
 submit(id,'research',{summary:'Deduplication used MinHash with 5-grams; 5,000 shards (VERIFIED, https://corpus.example/report).',verificationRefs:['https://corpus.example/report']});
 const after=host.getMission(id)!;
 ok(after.tasks.research.status==='completed'&&after.tasks.research.result!.blockers.some(b=>/"5,000" is attributed to https:\/\/corpus\.example\/report/.test(b)),'a figure the read page does not contain is flagged for Review (Research stays completed so Review runs)');
 ok(Object.keys(sourcesFor(researchTask.taskId)).length===0,'the page ledger is cleared once the Result is gated');
 ok(brains.length===2&&brains[1].sent.includes('Re-read each cited source')&&brains[1].sent.includes('5,000 shards'),'Review starts with the deliverable and the verification brief');
 submit(id,VERIFY_TASK,{summary:'Claim "5,000 shards" is UNSUPPORTED: the page says 4,200.\nVerdict: FAIL',verificationRefs:['https://corpus.example/report']});
 const job=bots.list().jobs.find(j=>j.id===id)!;
 ok(job.result!.artifacts.some(a=>a.label==='Independent review'&&/UNSUPPORTED/.test(a.value)),"the reviewer's report travels with the result");
 ok(job.result!.blockers.some(b=>/^Independent review: FAIL/.test(b)),'a failing review is shown as Needs attention');
 ok(['partial','failed'].includes(job.status)||job.status!=='completed','the run is not reported as cleanly completed');

 console.log('\nWhen the Review step is not added\n');
 const team=bots.run(req(TEAM_BOT_ID,'Compare two options',{agentIds:['research','review']}));ok(team.ok===true&&!host.getMission(team.data!.missionId!)!.tasks[VERIFY_TASK],'team runs already include Review and Lead');
 bots.stop(team.data!.missionId!);
 const review=bots.run(req('review','Check this plan'));ok(review.ok===true&&!host.getMission(review.data!.missionId!)!.tasks[VERIFY_TASK],'Review itself is not re-reviewed');
 bots.stop(review.data!.missionId!);
 const off=createMacBots(new SwarmManager(),()=>({makeBrain:()=>new FakeBrain()}),()=>({}),()=>true,{verify:false});
 const plain=off.run(req('write','Draft a note'));ok(plain.ok===true,'the step can be turned off');

 console.log('\nMeaning check from the page ledger\n');
 const {gateBotResult}=await import('./frontier/agent-playbooks.js');
 const pages={'https://corpus.example/report':'The filtered corpus was deduplicated with MinHash using 5-grams across crawl snapshots.'};
 const r=gateBotResult('research',{status:'completed',summary:'Quarterly revenue grew strongly across European subscription markets (https://corpus.example/report).',artifacts:[],verificationRefs:['https://corpus.example/report'],blockers:[]},true,pages);
 ok(r.status==='partial'&&r.blockers.some(b=>/shares little with the page it cites/.test(b)),'citing a read page for an unrelated claim makes the final result partial');
 const good=gateBotResult('research',{status:'completed',summary:'The corpus was deduplicated with MinHash using 5-grams (VERIFIED, https://corpus.example/report).',artifacts:[],verificationRefs:['https://corpus.example/report'],blockers:[]},true,pages);
 ok(good.status==='completed','a claim the page states passes');
 console.log(`\n${checks}/${checks} bot verification checks passed\n`);
} finally { rmSync(root,{recursive:true,force:true}); }
process.exit(0);
