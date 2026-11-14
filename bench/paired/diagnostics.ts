type Measurement = { calls: number; total_ms: number; max_ms: number };
type Target = Record<string, any>;

// Benchmark-only wrappers. Async spans are inclusive and can overlap; do not add layers.
export class RuntimeDiagnostics {
  private current: Map<string, Measurement> | undefined;
  start() {
    this.current = new Map();
  }
  stop() {
    const data = Object.fromEntries(
      [...(this.current ?? [])].sort(([a], [b]) => a.localeCompare(b)),
    );
    this.current = undefined;
    return { semantics: 'inclusive method spans; asynchronous calls may overlap', data };
  }
  measure<T>(label: string, operation: () => T): T {
    const current = this.current;
    if (!current) return operation();
    const begin = performance.now();
    const record = () => {
      const ms = performance.now() - begin;
      const value = current.get(label) ?? { calls: 0, total_ms: 0, max_ms: 0 };
      value.calls++;
      value.total_ms += ms;
      value.max_ms = Math.max(value.max_ms, ms);
      current.set(label, value);
    };
    try {
      const value = operation();
      if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function')
        return Promise.resolve(value).finally(record) as T;
      record();
      return value;
    } catch (error) {
      record();
      throw error;
    }
  }
  wrap(target: object, method: string, label: string) {
    const object = target as Target;
    const original = object[method];
    if (typeof original !== 'function') throw Error(`Diagnostic hook is unavailable: ${label}`);
    const profiler = this;
    object[method] = function (...args: unknown[]) {
      return profiler.measure(label, () => original.apply(this, args));
    };
  }
  install(gateway: { store: object; kernel: object; hub: object; runtime: object }) {
    for (const method of [
      'createRun',
      'checkpoint',
      'recordOutput',
      'step',
      'emit',
      'run',
      'getStep',
      'bundle',
      'filePayload',
    ])
      this.wrap(gateway.store, method, `store.${method}`);
    if (typeof (gateway.store as Target).checkpointStep === 'function')
      this.wrap(gateway.store, 'checkpointStep', 'store.checkpointStep');
    this.wrap(gateway.kernel, 'context', 'kernel.context');
    for (const method of ['availability', 'execute'])
      this.wrap(gateway.hub, method, `hub.${method}`);
    for (const method of ['workspace', 'install', 'execute'])
      this.wrap(gateway.runtime, method, `worker.${method}`);
    const db = (gateway.store as Target).db;
    const exec = db.exec,
      prepare = db.prepare;
    const profiler = this;
    db.exec = function (sql: string) {
      const kind = /^(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toLowerCase() ?? 'other';
      return profiler.measure(`sqlite.${kind}`, () => exec.call(this, sql));
    };
    db.prepare = function (sql: string) {
      const statement = profiler.measure('sqlite.prepare', () => prepare.call(this, sql));
      for (const method of ['run', 'get', 'all']) {
        const original = statement[method];
        statement[method] = function (...args: unknown[]) {
          const kind =
            method === 'run'
              ? db.isTransaction
                ? 'write_in_transaction'
                : 'autocommit_write'
              : 'read';
          return profiler.measure(`sqlite.${kind}`, () => original.apply(this, args));
        };
      }
      return statement;
    };
  }
}
