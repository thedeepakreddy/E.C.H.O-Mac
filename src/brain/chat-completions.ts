/** Chat Completions transport for the shared Responses-shaped execution loop. */
import {streamStep} from './stream-deadline.js';
export interface CompletionResult {
  output: any[];
  usage: any;
  incomplete?: string;
}

export class CompletionProtocolError extends Error {
  readonly status = 502;
  readonly code = 'stream_interrupted';
}

/** Preserve assistant reasoning and tool-call grouping across observation rounds. */
export function completionRequest(request: any, reasoningEffort?: string): any {
  const messages: any[] = [{role: 'system', content: request.instructions ?? ''}];
  for (const item of request.input ?? []) {
    if (item.type === 'function_call') {
      let assistant = messages.at(-1);
      if (assistant?.role !== 'assistant') {
        assistant = {role: 'assistant', content: null};
        messages.push(assistant);
      }
      (assistant.tool_calls ??= []).push({id: item.call_id, type: 'function',
        function: {name: item.name, arguments: item.arguments}});
    } else if (item.type === 'function_call_output') {
      messages.push({role: 'tool', tool_call_id: item.call_id, content: item.output});
    } else if (item.role === 'user' || item.role === 'assistant') {
      const parts = (item.content ?? []).map((part: any) => {
        if (part.type === 'input_image') return {type: 'image_url', image_url: {url: part.image_url}};
        if (part.type === 'input_text' || part.type === 'output_text') return {type: 'text', text: part.text};
        throw new CompletionProtocolError(`Unsupported chat content type: ${part.type}`);
      });
      const content = parts.every((part: any) => part.type === 'text')
        ? parts.map((part: any) => part.text).join('\n') : parts;
      messages.push({role: item.role, content,
        ...(typeof item.reasoning_content === 'string' ? {reasoning_content: item.reasoning_content} : {})});
    }
  }
  return {model: request.model, messages, stream: true, stream_options: {include_usage: true},
    ...(request.max_output_tokens ? {max_tokens: request.max_output_tokens} : {}),
    ...(reasoningEffort ? {reasoning_effort: reasoningEffort} : {}),
    ...((request.tools?.length ?? 0) ? {tools: request.tools.map((tool: any) => ({
      type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters},
    }))} : {})};
}

/** Tool fragments are inert until a complete, validated finish marker arrives. */
export async function readCompletionStream(
  response: Response,
  onText: (text: string) => void,
  deadline?: {controller: AbortController; silenceMs: number},
): Promise<CompletionResult> {
  let text = '', reasoning = '', finish: string | null = null, usage: any = null;
  const calls = new Map<number, {id: string; name: string; arguments: string}>();
  const consume = (event: any, full = false) => {
    if (!event || typeof event !== 'object') throw new CompletionProtocolError('Invalid completion event.');
    if (event.error) throw new CompletionProtocolError(String(event.error.message ?? 'Completion failed.'));
    if (event.usage) usage = event.usage;
    const choice = event.choices?.find((c: any) => c.index === 0) ?? event.choices?.[0];
    if (!choice) return;
    const delta = full ? choice.message : choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      text += delta.content; onText(delta.content);
    }
    if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (text.length + reasoning.length > 2_000_000) throw new CompletionProtocolError('Completion output exceeded the transport limit.');
    for (const [position, fragment] of (delta?.tool_calls ?? []).entries()) {
      const index = full ? position : fragment.index;
      if (!Number.isInteger(index) || index < 0 || index >= 128) throw new CompletionProtocolError('Invalid tool-call index.');
      const call = calls.get(index) ?? {id: '', name: '', arguments: ''};
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.name += fragment.function.name;
      if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments;
      if (call.arguments.length > 1_000_000) throw new CompletionProtocolError('Tool arguments exceeded the transport limit.');
      calls.set(index, call);
    }
    if (choice.finish_reason != null) finish = String(choice.finish_reason);
  };
  if (response.headers.get('content-type')?.includes('application/json')) {
    consume(await response.json(), true);
  } else {
    if (!response.body) throw new CompletionProtocolError('Completion response has no body.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', data: string[] = [], done = false;
    const dispatch = () => {
      const payload = data.join('\n'); data = [];
      if (!payload) return;
      if (payload === '[DONE]') {done = true; return;}
      let event: any;
      try {event = JSON.parse(payload);} catch {throw new CompletionProtocolError('Invalid JSON in completion stream.');}
      consume(event);
    };
    try {
      while (!done) {
        const chunk = deadline ? await streamStep(() => reader.read(), deadline.controller, deadline.silenceMs) : await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), {stream: !chunk.done});
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line) dispatch();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (done) break;
        }
        if (buffer.length + data.join('').length > 2_000_000) throw new CompletionProtocolError('Completion event exceeded the transport limit.');
        if (chunk.done) {
          if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
          dispatch(); break;
        }
      }
    } finally {await reader.cancel().catch(() => {});}
  }
  if (!finish) throw new CompletionProtocolError('The completion stream ended before a finish marker.');
  const output: any[] = [{type: 'message', role: 'assistant',
    content: text ? [{type: 'output_text', text}] : [], reasoning_content: reasoning}];
  if (finish !== 'stop' && finish !== 'tool_calls') {
    // A truncated call must never mutate a project or operate the computer.
    return {output, usage: normalizeUsage(usage), incomplete: finish === 'length' ? 'max_output_tokens' : finish};
  }
  if (finish === 'tool_calls' && !calls.size) throw new CompletionProtocolError('The model reported tool calls without returning one.');
  const ids = new Set<string>();
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    if (!call.id || !call.name || ids.has(call.id)) throw new CompletionProtocolError('Invalid or duplicate tool call.');
    let args: any;
    try {args = JSON.parse(call.arguments);} catch {throw new CompletionProtocolError('Incomplete tool arguments.');}
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CompletionProtocolError('Tool arguments must be an object.');
    ids.add(call.id);
    output.push({type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments});
  }
  return {output, usage: normalizeUsage(usage)};
}

function normalizeUsage(usage: any): any {
  return usage ? {input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens, input_tokens_details: usage.prompt_tokens_details,
    output_tokens_details: usage.completion_tokens_details} : null;
}
