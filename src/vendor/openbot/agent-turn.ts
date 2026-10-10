// Adapted from CopilotKit/OpenBot agent-bot/src/index.ts (MIT). See LICENSE and UPSTREAM.md.
export interface AgentEvent {type:string;[key:string]:unknown}
export interface ProviderChunk {choices:Array<{delta?:{content?:string;tool_calls?:Array<{index:number;id?:string;function?:{name?:string;arguments?:string}}>}}>}
export interface AgentCall {id:string;name:string;args:string}
/** Upstream's streaming call assembly, separated from Bun, HTTP and its OpenAI-only client. */
export async function runAgentTurn(input:{threadId:string;runId:string},completion:()=>Promise<AsyncIterable<ProviderChunk>>,emit:(event:AgentEvent)=>void|Promise<void>,signal?:AbortSignal) {
 const check=()=>{if(signal?.aborted)throw signal.reason??new Error('Run stopped');};
 const send=async(event:AgentEvent)=>{check();await emit(event);};
 await send({type:'RUN_STARTED',threadId:input.threadId,runId:input.runId});
 const messageId=`msg_${input.runId}`,toolCalls=new Map<number,AgentCall>();let textOpen=false,text='';
 try {
  const stream=await completion();
  for await(const chunk of stream){check();const delta=chunk.choices[0]?.delta;if(!delta)continue;
   if(delta.content){if(!textOpen){await send({type:'TEXT_MESSAGE_START',messageId,role:'assistant'});textOpen=true;}text+=delta.content;if(text.length>32000)throw new Error('Bot response is too long');await send({type:'TEXT_MESSAGE_CONTENT',messageId,delta:delta.content});}
   for(const call of delta.tool_calls??[]){if(!Number.isInteger(call.index)||call.index<0||call.index>15)throw new Error('Too many tool calls');const existing=toolCalls.get(call.index)??{id:call.id??`call_${input.runId}_${call.index}`,name:'',args:''};if(call.id)existing.id=call.id;if(call.function?.name)existing.name=call.function.name;if(call.function?.arguments)existing.args+=call.function.arguments;if(existing.args.length>16000)throw new Error('Tool arguments are too long');toolCalls.set(call.index,existing);}
  }
  if(textOpen)await send({type:'TEXT_MESSAGE_END',messageId});
  for(const call of toolCalls.values()){await send({type:'TOOL_CALL_START',toolCallId:call.id,toolCallName:call.name,parentMessageId:messageId});await send({type:'TOOL_CALL_ARGS',toolCallId:call.id,delta:call.args||'{}'});await send({type:'TOOL_CALL_END',toolCallId:call.id});}
  await send({type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId});return {text,calls:[...toolCalls.values()]};
 }catch(error){if(!signal?.aborted)await emit({type:'RUN_ERROR',message:'The bot could not finish this turn.'});throw error;}
}
