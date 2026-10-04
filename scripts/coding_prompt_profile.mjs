// Read-only prompt size comparison; never prints prompts, audio, or credentials.
import {readFileSync} from 'node:fs';
const file=process.argv[2];if(!file)throw Error('Provide a recorded llm.request blob path.');
const request=JSON.parse(readFileSync(file,'utf8'));const system=request.config?.systemInstruction??'';const start=system.lastIndexOf('<echo_context>');const packet=start<0?'':system.slice(start);const tools=request.config?.tools?.[0]?.functionDeclarations??[];
console.log(JSON.stringify({recordedSystemCharacters:system.length,recordedMemoryCharacters:packet.length,toolDefinitions:tools.length,toolDefinitionCharacters:JSON.stringify(tools).length,newCodingMemoryTokenCeiling:4000,note:'Ceiling applies to repeated memory packets, not audio, tool schemas, system persona or transport history. No live latency claim.'},null,2));
