import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// scripts/test-isolate.mjs (test-offline --isolate): per-file runs, timeouts and the summary.
// Fake test files only; nothing listens.

type Result = {
  file: string;
  status: 'passed' | 'failed' | 'timeout';
  code: number | null;
  ms: number;
};
type Isolate = {
  runIsolated: (
    files: string[],
    o: { nodeArgs?: string[]; timeoutMs: number; stdio?: 'ignore'; log?: (s: string) => void },
  ) => Promise<Result[]>;
  summarize: (r: Result[]) => { ok: boolean; text: string };
};

test('isolated runs record pass, fail and timeout per file and keep going', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-isolate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'pass.mjs': 'process.exit(0);',
    'fail.mjs': 'process.exit(1);',
    'hang.mjs': 'setInterval(() => {}, 1000);',
    'after.mjs': 'process.exit(0);',
  };
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  const mod = (await import(
    pathToFileURL(path.resolve('scripts/test-isolate.mjs')).href
  )) as Isolate;
  const logged: string[] = [];
  const started = Date.now();
  const results = await mod.runIsolated(
    Object.keys(files).map((f) => path.join(dir, f)),
    { timeoutMs: 1500, stdio: 'ignore', log: (s) => logged.push(s) },
  );
  assert.ok(Date.now() - started < 30_000);
  assert.deepEqual(
    results.map((r) => [path.basename(r.file), r.status]),
    [
      ['pass.mjs', 'passed'],
      ['fail.mjs', 'failed'],
      ['hang.mjs', 'timeout'],
      ['after.mjs', 'passed'],
    ],
  );
  assert.equal(logged.length, 4);
  const summary = mod.summarize(results);
  assert.equal(summary.ok, false);
  assert.match(summary.text, /FAILED: .*fail\.mjs/);
  assert.match(summary.text, /TIMEOUT: .*hang\.mjs/);
  assert.match(summary.text, /4 files, 2 passed, 1 failed, 1 timed out/);
  assert.equal(mod.summarize(results.filter((r) => r.status === 'passed')).ok, true);
});
