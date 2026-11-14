import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  OUTPUT_EVENT_TYPES,
  RUN_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  TIMELINE_EVENT_TYPES,
  isTerminalEvent,
} from '../src/core/events.js';
import { terminalEventType } from '../src/kernel/run-state.js';

// 运行事件的命名空间。providers/、engines/ 解析的是上游协议的事件（同名但不是运行事件），lang/ 不写事件。
const EVENT_NAME =
  /'((?:response|run|tool|tools|approval|step|subagent|route|workflow)\.[a-z_.]*[a-z_])'/g;
const EVENT_DIRS = ['core', 'store', 'kernel', 'gateway', 'fabric'];

test('event catalog: every event-name literal in src is registered', async () => {
  const known = new Set<string>(RUN_EVENT_TYPES);
  const unknown: string[] = [];
  let seen = 0;
  for (const dir of EVENT_DIRS) {
    for (const file of (await readdir(path.resolve('src', dir))).filter((f) => f.endsWith('.ts'))) {
      const text = await readFile(path.resolve('src', dir, file), 'utf8');
      for (const match of text.matchAll(EVENT_NAME)) {
        seen++;
        if (!known.has(match[1]!)) unknown.push(`${dir}/${file}: ${match[1]}`);
      }
    }
  }
  assert.ok(seen > 50, `expected the full event inventory, found ${seen}`);
  assert.deepEqual(unknown, [], 'register these event types in src/core/events.ts');
});

test('event catalog: no duplicates, and the derived lists are subsets', () => {
  assert.equal(new Set(RUN_EVENT_TYPES).size, RUN_EVENT_TYPES.length);
  const known = new Set<string>(RUN_EVENT_TYPES);
  for (const type of [...TERMINAL_EVENT_TYPES, ...OUTPUT_EVENT_TYPES, ...TIMELINE_EVENT_TYPES])
    assert.ok(known.has(type), type);
});

test('event catalog: terminal events match what terminal run states write', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'incomplete', 'interrupted'])
    assert.ok(isTerminalEvent(terminalEventType(status)), status);
  assert.ok(isTerminalEvent('run.interrupted'));
  for (const type of ['run.requires_action', 'run.queued', 'response.in_progress', 'x'])
    assert.equal(isTerminalEvent(type), false, type);
});
