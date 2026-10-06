import { createHash } from 'node:crypto';
import type { ToolOutput } from '../tools/registry.js';

export function inputFingerprint(value: unknown): string {
  const ordered = (item: any): any => Array.isArray(item) ? item.map(ordered) :
    item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value ?? {}))).digest('hex');
}

function readable(text: string): string {
  if (!/<(?:html|body|div|p|table|style|script)\b/i.test(text)) return text;
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

/** Model-facing excerpts only. Originals remain in the task's result archive. */
export function compactToolResult(out: ToolOutput): ToolOutput {
  const page = out.data as any;
  // Archive offsets count original characters; preserve every character in a bounded page.
  if (page?.verbatimPage === true && Number.isFinite(page.totalChars)) return {...out, text: (out.text ?? '').slice(0, 6000), image: undefined,
    data: {verbatimPage: true, totalChars: page.totalChars, nextOffset: page.nextOffset}};
  let remaining = 10000;
  const walk = (value: any, depth = 0): any => {
    if (typeof value === 'string') {
      const text = readable(value);
      const n = Math.max(0, Math.min(2000, remaining)); remaining -= Math.min(text.length, n);
      return text.length > n ? `${text.slice(0, n)} [excerpt; read_tool_result for original]` : text;
    }
    if (depth > 8) return '[nested data; read_tool_result for original]';
    if (Array.isArray(value)) return value.slice(0, 30).map(item => walk(item, depth + 1)).concat(value.length > 30 ? ['[more entries; read_tool_result]'] : []);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      return {...Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, walk(item, depth + 1)])), ...(entries.length > 50 ? {_excerpt: 'More fields available through read_tool_result'} : {})};
    }
    return value;
  };
  let text = out.text ?? '';
  try { text = JSON.stringify(walk(JSON.parse(text))); } catch { text = readable(text); }
  if (text.length > 10000) text = `${text.slice(0, 10000)}\n[excerpt; read_tool_result for original]`;
  // MCP text content and structuredContent often repeat the same whole result.
  let data = out.data;
  if (JSON.stringify(data ?? null).length >= 3000) {
    const mcpEnvelope = data && typeof data === 'object' && ('content' in data || 'structuredContent' in data);
    data = text && mcpEnvelope ? undefined : walk(data);
    if (data !== undefined && JSON.stringify(data).length > 6000) data = {excerpt: JSON.stringify(data).slice(0, 6000), note: 'More structured data available through read_tool_result'};
  }
  return {...out, text, data, image: undefined};
}

export function modelToolResult(out: ToolOutput): Record<string, unknown> {
  const small = compactToolResult(out);
  return {result: small.text ?? 'done', data: small.data, status: out.status, error: out.error,
    verification: out.verification, verificationRefs: out.verificationRefs, callId: out.callId,
    resultRef: out.callId ? `read_tool_result(callId=${out.callId})` : undefined};
}
