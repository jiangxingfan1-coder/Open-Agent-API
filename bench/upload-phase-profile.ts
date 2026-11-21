// Benchmark-only spans. SQL executes unchanged and clocks are shared across worker threads.
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, workerData, type WorkerOptions } from 'node:worker_threads';
import type { Store } from '../src/store/store.js';

const fields = [
  'arrival',
  'sent',
  'first',
  'last',
  'reply',
  'writing',
  'written',
  'finished',
  'sqlUs',
  'queries',
  'thresholdUs',
] as const;
type Field = (typeof fields)[number];
const now = () => process.hrtime.bigint() / 1000n;
const index = (owner: string) => {
  const m = /^cold-fixture-(\d+)$/.exec(owner);
  return m ? Number(m[1]) : -1;
};
const at = (i: number, f: Field) => i * fields.length + fields.indexOf(f);
type Config = { accounts: number; origin: string; data: SharedArrayBuffer };
export function uploadPhaseProfile(accounts: number, tokens: Map<string, number>) {
  const slots = new BigInt64Array(new SharedArrayBuffer(accounts * fields.length * 8));
  const mark = (i: number, f: Field) => {
    if (i >= 0 && i < accounts) Atomics.compareExchange(slots, at(i, f), 0n, now());
  };
  const builtin = createRequire(import.meta.url)(
    'node:worker_threads',
  ) as typeof import('node:worker_threads');
  const Original = builtin.Worker;
  class Profiled extends Original {
    private owners = new Map<string, number>();
    constructor(file: string | URL, opts?: WorkerOptions) {
      const watch = file instanceof URL && opts?.workerData?.role === 'oaa.upload-usage';
      super(
        watch ? new URL(import.meta.url) : file,
        watch
          ? {
              ...opts,
              workerData: {
                ...opts!.workerData,
                phase: { accounts, data: slots.buffer, origin: file.href } satisfies Config,
              },
            }
          : opts,
      );
      if (watch)
        this.on('message', (m) => {
          if (m.kind === 'progress' || typeof m.id !== 'string') return;
          const i = this.owners.get(m.id);
          if (i !== undefined) {
            mark(i, 'reply');
            this.owners.delete(m.id);
          }
        });
    }
    override postMessage(...args: Parameters<InstanceType<typeof Original>['postMessage']>) {
      const m = args[0];
      if (typeof m?.owner === 'string' && typeof m.id === 'string') {
        const i = index(m.owner);
        if (i >= 0 && i < accounts) {
          this.owners.set(m.id, i);
          mark(i, 'sent');
        }
      }
      return super.postMessage(...args);
    }
  }
  builtin.Worker = Profiled;
  syncBuiltinESMExports();
  let detach = () => {};
  return {
    attach(store: Store, server: Server) {
      const arrival = (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST' || req.url !== '/v1/files') return;
        const i = tokens.get(req.headers.authorization ?? '');
        if (i === undefined) return;
        if (!Atomics.load(slots, at(i, 'arrival'))) {
          mark(i, 'arrival');
          res.once('finish', () => mark(i, 'finished'));
        }
      };
      server.prependListener('request', arrival);
      const add = store.addFile;
      const prepare = store.prepare,
        watched = new WeakSet<object>();
      store.prepare = function (sql) {
        const q = prepare.call(this, sql);
        if (
          sql.startsWith('SELECT 1 FROM main.files INDEXED BY ') &&
          sql.includes('WHERE owner=:owner') &&
          !watched.has(q)
        ) {
          watched.add(q);
          q.get = new Proxy(q.get, {
            apply(get, receiver, args) {
              const i = index(args[0]?.owner ?? '');
              if (i < 0 || i >= accounts || Atomics.load(slots, at(i, 'sent')))
                return Reflect.apply(get, receiver, args);
              const start = now();
              try {
                return Reflect.apply(get, receiver, args);
              } finally {
                Atomics.add(slots, at(i, 'thresholdUs'), now() - start);
              }
            },
          });
        }
        return q;
      };
      store.addFile = async (...args: Parameters<typeof add>) => {
        const i = index(args[0]);
        mark(i, 'writing');
        const result = await add.apply(store, args);
        mark(i, 'written');
        return result;
      };
      detach = () => {
        server.off('request', arrival);
        store.addFile = add;
        store.prepare = prepare;
      };
    },
    snapshot() {
      return Array.from({ length: accounts }, (_, i) => {
        const get = (f: Field) => Number(Atomics.load(slots, at(i, f))) / 1000,
          ms = (v: number) => +v.toFixed(3);
        const chronological = fields.slice(0, 8).map(get);
        assert.ok(
          chronological[0]! > 0 &&
            chronological.every((v, k) => k === 0 || v >= chronological[k - 1]!),
          'incomplete or reordered quota spans',
        );
        const sql = get('sqlUs');
        return {
          account: i,
          server_ms: ms(get('finished') - get('arrival')),
          preflight_ms: ms(get('sent') - get('arrival')),
          threshold_sql_within_preflight_ms: get('thresholdUs'),
          initial_queue_ms: ms(get('first') - get('sent')),
          index_sql_ms: sql,
          between_queries_ms: ms(get('last') - get('first') - sql),
          return_ms: ms(get('reply') - get('last')),
          prewrite_ms: ms(get('writing') - get('reply')),
          write_ms: ms(get('written') - get('writing')),
          response_ms: ms(get('finished') - get('written')),
          index_queries: Number(slots[at(i, 'queries')]),
        };
      });
    },
    close() {
      detach();
      builtin.Worker = Original;
      syncBuiltinESMExports();
    },
  };
}

if (!isMainThread && workerData?.role === 'oaa.upload-usage' && workerData.phase) {
  const p: Config = workerData.phase,
    slots = new BigInt64Array(p.data);
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const stmt = prepare.call(this, sql);
    if (!sql.includes('FROM main.files INDEXED BY file_')) return stmt;
    stmt.get = new Proxy(stmt.get, {
      apply(get, receiver, args) {
        const i = index(args[0]?.owner ?? '');
        if (i < 0 || i >= p.accounts) return Reflect.apply(get, receiver, args);
        const t = now();
        Atomics.compareExchange(slots, at(i, 'first'), 0n, t);
        try {
          return Reflect.apply(get, receiver, args);
        } finally {
          const end = now();
          Atomics.add(slots, at(i, 'sqlUs'), end - t);
          Atomics.add(slots, at(i, 'queries'), 1n);
          Atomics.store(slots, at(i, 'last'), end);
        }
      },
    });
    return stmt;
  };
  await import(p.origin);
}
