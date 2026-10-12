import assert from 'node:assert/strict';
import {DEFAULTS_FOR_TESTS,setActiveConfig} from './config.js';
import {createBrain} from './brain/index.js';
import {makeFleetBrain} from './frontier/fleet-brain.js';
for(const provider of ['gemini','openai','openrouter','nvidia'] as const){
 const cfg=structuredClone(DEFAULTS_FOR_TESTS);cfg.brain=provider;
 const credentialEnv='ECHO_ROUTING_TEST_MISSING_CREDENTIAL';delete process.env[credentialEnv];
 cfg[provider].apiKeyEnv=credentialEnv;if(provider==='openai')cfg.openai.auth='apiKey';
 assert.throws(()=>createBrain(cfg,{allowProviderFallback:false} as any),/not set|isn't set|unavailable|can't run/i,`${provider} must not silently construct Claude`);
 assert.throws(()=>makeFleetBrain(cfg)({id:'routing-test',name:'Routing test',kind:'clone'} as any,{profile:'review',budget:{maxIterations:2,maxRecoveryAttempts:0,timeoutMs:1000}} as any),/not set|isn't set|unavailable|can't run/i,'The real specialist factory must fail on the selected brain, not reroute');
}
console.log('PASS actual brain and specialist factories fail closed on missing selected-provider credentials. No live provider requests.');
const {TOOLS}=await import('./tools/registry.js');const {swarm}=await import('./frontier/swarm.js');
const active=structuredClone(DEFAULTS_FOR_TESTS);active.brain='nvidia';active.nvidia.apiKeyEnv='ECHO_ROUTING_TEST_ACTIVE_BRAIN';delete process.env.ECHO_ROUTING_TEST_ACTIVE_BRAIN;setActiveConfig(active);
const spawn=swarm.spawn;
const submit=swarm.submitMission;
try{
 swarm.spawn=((_goal:any,deps:any)=>{
  assert.throws(()=>deps.makeBrain({id:'tool-routing',name:'Tool routing',kind:'clone'},{profile:'review',budget:{maxIterations:2,maxRecoveryAttempts:0}}),/ECHO_ROUTING_TEST_ACTIVE_BRAIN/,'Chat tools must use Echo’s live config, not saved defaults');return {ok:true,name:'Fixture'};
 }) as any;
 for(const [name,args] of [['delegate_task',{agentName:'Fixture',taskDescription:'Read facts'}],['spawn_subagent',{goals:['Read facts']}]] as const)await TOOLS.find(t=>t.name===name)!.handler(args as any);
 swarm.submitMission=((_mission:any,deps:any)=>{assert.throws(()=>deps.makeBrain({id:'mission-routing',name:'Fixture',kind:'clone'},{profile:'review',budget:{maxIterations:2,maxRecoveryAttempts:0}}),/ECHO_ROUTING_TEST_ACTIVE_BRAIN/);return {ok:true,missionId:'fixture'};}) as any;
 await TOOLS.find(t=>t.name==='run_agent_mission')!.handler({goal:'Fixture',tasks:[{id:'review',profile:'review',goal:'Read facts',dependsOn:[],acceptanceCriteria:[],lane:'knowledge',maxIterations:2,maxRecoveryAttempts:0,timeoutMs:1000}]} as any);
}finally{swarm.spawn=spawn;swarm.submitMission=submit;}
console.log('PASS chat-tool agent launches inherit Echo’s live brain configuration.');
const interval=global.setInterval,log=console.error,crons=(global as any).__activeCrons;let tick:()=>void=()=>{},logged='';
try{
 global.setInterval=((fn:any)=>{tick=fn;return 42;}) as any;console.error=(...args)=>{logged=args.join(' ');};
 await TOOLS.find(t=>t.name==='schedule_task')!.handler({intervalSeconds:10,goal:'Read facts'} as any);
 assert.doesNotThrow(()=>tick(),'An unavailable active brain must not crash a scheduled launch');assert.match(logged,/ECHO_ROUTING_TEST_ACTIVE_BRAIN/);
}finally{global.setInterval=interval;console.error=log;(global as any).__activeCrons=crons;}
console.log('PASS scheduled agents use the live brain and report unavailable credentials without crashing.');
