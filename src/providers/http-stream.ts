import { Fault, checkAbort } from '../core/util.js';

type ReadLimits = { maxBytes?: number; limitCode?: string };

async function* responseChunks(
  response: Response,
  signal: AbortSignal,
  { maxBytes = 8 * 1024 * 1024, limitCode = 'upstream_output_limit' }: ReadLimits,
): AsyncGenerator<Uint8Array> {
  checkAbort(signal);
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    checkAbort(signal);
    while (true) {
      const next = await reader.read();
      checkAbort(signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Fault(limitCode, `Response exceeds the ${maxBytes}-byte limit.`, 502);
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 一条 SSE 事件。`event` 缺省为 `message`；`id` 只在该事件带了 `id:` 行时出现。 */
export type SseMessage = { id?: string; event: string; data: string };

/**
 * 增量 SSE 解析器，按 WHATWG「event stream interpretation」规则自行实现：
 * 以空行分隔事件；`:` 开头是注释；`field: value` 只去掉冒号后的一个空格；多条 `data:` 用
 * 换行连接；没有 `data:` 的事件不派发；未知字段和 `retry:` 被忽略。输入必须已经把 CR / CRLF
 * 归一成 LF。尚未以空行结束的事件留在缓冲里，流结束时由调用方丢弃。
 */
class SseParser {
  private partial = '';
  private data: string[] = [];
  private dataChars = 0;
  private event = '';
  private id: string | undefined;
  private started = false;

  constructor(
    private readonly maxEventChars: number,
    private readonly overflow: () => Error,
  ) {}

  feed(text: string, emit: (message: SseMessage) => void): void {
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end < 0) break;
      const line = this.partial ? this.partial + text.slice(start, end) : text.slice(start, end);
      this.partial = '';
      start = end + 1;
      this.line(line, emit);
    }
    if (start < text.length) this.partial += text.slice(start);
    // 一行迟迟不结束，或一条事件的数据不断累积，都按超限处理，而不是无限缓冲。
    if (this.partial.length + this.dataChars > this.maxEventChars) throw this.overflow();
  }

  private line(line: string, emit: (message: SseMessage) => void): void {
    if (line === '') {
      if (this.data.length)
        emit({
          ...(this.id !== undefined ? { id: this.id } : {}),
          event: this.event || 'message',
          data: this.data.join('\n'),
        });
      this.data = [];
      this.dataChars = 0;
      this.event = '';
      this.id = undefined;
      return;
    }
    if (line.charCodeAt(0) === 0x3a) return; // 注释行
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    if (field === 'data') {
      this.data.push(value);
      this.dataChars += value.length + 1;
    } else if (field === 'event') this.event = value;
    else if (field === 'id') {
      if (!value.includes('\0')) this.id = value;
    }
    // `retry` 与未知字段不影响应用层载荷。
  }
}

/** A finite HTTP response, never a reconnecting/retrying EventSource. */
export async function* readSseStream(
  response: Response,
  signal: AbortSignal,
  limits: ReadLimits & { maxEventBytes?: number } = {},
): AsyncGenerator<SseMessage> {
  const maxEventBytes = limits.maxEventBytes ?? 2 * 1024 * 1024;
  const overflow = () =>
    new Fault(
      limits.limitCode ?? 'upstream_output_limit',
      `SSE event exceeds the ${maxEventBytes}-byte limit.`,
      502,
    );
  const pending: SseMessage[] = [];
  const parser = new SseParser(maxEventBytes, overflow);
  const collect = (event: SseMessage) => {
    if (Buffer.byteLength(event.data) > maxEventBytes) throw overflow();
    pending.push(event);
  };
  const decoder = new TextDecoder();
  let afterCR = false;
  const feed = (text: string) => {
    if (!text) return;
    if (afterCR && text.startsWith('\n')) text = text.slice(1);
    afterCR = text.endsWith('\r');
    // Normalize bare CR immediately: waiting for another chunk to distinguish CRLF would delay
    // an already complete terminal event on an open socket.
    parser.feed(text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text, collect);
  };
  for await (const chunk of responseChunks(response, signal, limits)) {
    // Bound queued events even if fetch hands us the entire response in one chunk.
    for (let offset = 0; offset < chunk.byteLength; offset += 16_384) {
      feed(decoder.decode(chunk.subarray(offset, offset + 16_384), { stream: true }));
      for (const event of pending) {
        checkAbort(signal);
        yield event;
      }
      pending.length = 0;
    }
  }
  feed(decoder.decode());
  for (const event of pending) {
    checkAbort(signal);
    yield event;
  }
  // EOF is not an event delimiter: an unfinished terminal frame cannot prove success, so
  // whatever is still buffered in the parser is dropped with it.
}

export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  limits: ReadLimits = {},
): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for await (const chunk of responseChunks(response, signal, limits))
    chunks.push(decoder.decode(chunk, { stream: true }));
  chunks.push(decoder.decode());
  return chunks.join('');
}
