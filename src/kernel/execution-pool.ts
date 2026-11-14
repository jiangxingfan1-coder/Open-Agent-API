import { Fault, checkAbort } from '../core/util.js';

/** One leaf budget per run slice; graph/workflow containers never hold a permit. */
export class ExecutionPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Fault('invalid_concurrency', 'Leaf concurrency must be a positive integer.');
  }

  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    checkAbort(signal);
    if (this.active < this.capacity) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      checkAbort(signal);
      return await execute();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
