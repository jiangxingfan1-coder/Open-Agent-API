import { createInterface } from 'node:readline';

export class ChildRpc {
  private next = 0;
  private requests = new Map<
    number,
    { resolve: (result: any) => void; reject: (error: Error) => void }
  >();
  readonly lines = createInterface({ input: process.stdin });
  command: (frame: any) => void = () => {};
  constructor() {
    this.lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 1024 * 1024) throw Error('Benchmark frame too large.');
      const frame = JSON.parse(line);
      if (frame.type === 'result') {
        const request = this.requests.get(frame.id);
        if (!request) throw Error('Unexpected benchmark reply.');
        this.requests.delete(frame.id);
        if (frame.error) request.reject(Error(String(frame.error)));
        else request.resolve(frame.result);
      } else this.command(frame);
    });
    this.lines.on('close', () => {
      for (const request of this.requests.values())
        request.reject(Error('Benchmark controller disconnected.'));
      this.requests.clear();
    });
  }
  send(frame: unknown) {
    process.stdout.write(JSON.stringify(frame) + '\n');
  }
  call(
    run: string,
    operation: 'model' | 'tool',
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) return Promise.reject(Error('Benchmark call cancelled.'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.requests.delete(id);
        reject(Error('Benchmark call cancelled.'));
      };
      this.requests.set(id, {
        resolve: (result) => {
          signal?.removeEventListener('abort', abort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ type: 'call', id, run, operation, payload });
    });
  }
}
