/** JSON server-sent events, including fragmented UTF-8 and CRLF boundaries. */
export async function* jsonSse(response: Response): AsyncGenerator<any> {
  if (!response.body) throw new Error('Audio response has no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const parse = (event: string) => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? JSON.parse(data) : undefined;
  };
  try {
    for (;;) {
      const {value, done} = await reader.read();
      buffered += decoder.decode(value, {stream: !done});
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
        const event = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const parsed = parse(event);
        if (parsed !== undefined) yield parsed;
      }
      if (done) {
        const parsed = parse(buffered);
        if (parsed !== undefined) yield parsed;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
