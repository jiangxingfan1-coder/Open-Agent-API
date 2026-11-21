// Only the opted-in fixture worker is instrumented. It still executes the real gateway's
// indexed SQLite query; the native gate is a second disposable database, not a user file.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, workerData } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';

export type ReaderScenario = 'progress' | 'blocked' | 'ceiling' | 'steady';
type Probe = { origin: string; gate: string; state: SharedArrayBuffer; scenario: ReaderScenario };
const rows = 0,
  entered = 1,
  left = 2,
  sleepSlot = 3;
export function observeReader(gate: string, scenario: ReaderScenario, workerUrl?: string) {
  const shared = new SharedArrayBuffer(16),
    state = new Int32Array(shared);
  const builtin = createRequire(import.meta.url)(
    'node:worker_threads',
  ) as typeof import('node:worker_threads');
  const original = builtin.Worker;
  let opened = 0,
    exited = 0,
    progressReports = 0,
    releasedRows = 0,
    terminationAt: number | undefined;
  class Observed extends original {
    constructor(file: string | URL, options?: WorkerOptions) {
      const watching = options?.workerData?.role === 'oaa.upload-usage' && file instanceof URL;
      super(
        watching ? new URL(import.meta.url) : file,
        watching
          ? {
              ...options,
              workerData: {
                ...options!.workerData,
                probe: {
                  origin: workerUrl ?? file.href,
                  gate,
                  scenario,
                  state: shared,
                } satisfies Probe,
              },
            }
          : options,
      );
      if (watching) {
        opened++;
        this.on('message', (m) => {
          if (m.kind === 'progress') progressReports++;
          if (m.kind === 'released') releasedRows = m.prefix?.rows ?? 0;
        });
        this.once('exit', () => {
          exited++;
        });
      }
    }
    override terminate() {
      terminationAt ??= performance.now();
      return super.terminate();
    }
  }
  builtin.Worker = Observed;
  syncBuiltinESMExports();
  return {
    rows: () => Atomics.load(state, rows),
    inNative: () => Atomics.load(state, entered) > Atomics.load(state, left) && exited < opened,
    entries: () => Atomics.load(state, entered),
    exited: () => exited,
    opened: () => opened,
    terminationAt: () => terminationAt,
    reports: () => progressReports,
    releasedRows: () => releasedRows,
    restore: () => {
      builtin.Worker = original;
      syncBuiltinESMExports();
    },
  };
}

if (!isMainThread && workerData?.probe && workerData?.role === 'oaa.upload-usage') {
  const p: Probe = workerData.probe,
    state = new Int32Array(p.state);
  const prepare = DatabaseSync.prototype.prepare,
    seen = new Set<bigint>(),
    installed = new WeakSet<DatabaseSync>();
  const source =
    'FROM main.files INDEXED BY file_upload_facts WHERE owner=:owner AND subject=:subject';
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (!sql.includes(source)) return prepare.call(this, sql);
    if (!installed.has(this)) {
      this.function('oaa_probe_visit', { useBigIntArguments: true }, (owner, row) => {
        if (owner !== 'owner' || typeof row !== 'bigint' || seen.has(row)) return 1;
        seen.add(row);
        const n = Atomics.add(state, rows, 1) + 1;
        if ((p.scenario === 'progress' || p.scenario === 'ceiling') && n % 64 === 0)
          Atomics.wait(state, sleepSlot, 0, p.scenario === 'ceiling' ? 80 : 24);
        if (p.scenario === 'blocked' && n === 128) {
          const gate = new DatabaseSync(p.gate, { readOnly: true });
          try {
            gate.exec('PRAGMA busy_timeout=30000');
            Atomics.add(state, entered, 1);
            gate.prepare('SELECT n FROM pace').get();
          } finally {
            gate.close();
            Atomics.add(state, left, 1);
          }
        }
        return 1;
      });
      installed.add(this);
    }
    return prepare.call(
      this,
      sql.replaceAll(source, source + ' AND oaa_probe_visit(:owner,rowid)=1'),
    );
  };
  await import(p.origin);
}
