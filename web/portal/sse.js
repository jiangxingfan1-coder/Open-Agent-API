// Server-sent events from a fetch() body: yields the `data:` payload of each event.
// An aborted request makes reader.read() reject with an AbortError; the caller handles it.
export async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const payload = (block) =>
    block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      // A lone CR at the end of a chunk may be half of a CRLF; it is normalised next round.
      buffer = buffer.replace(/\r\n/g, '\n');
      for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
        const data = payload(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (data) yield data;
      }
      if (done) break;
    }
    // A last event the server did not terminate with a blank line.
    const rest = payload(buffer);
    if (rest) yield rest;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
}
