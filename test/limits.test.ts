import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/core/limits.js';

// 限额目录只做命名：数值与引入前一致，改动任何一项都会改变线上行为，需要同时改这里并单独评审。
test('limits catalog keeps the established values', () => {
  assert.deepEqual(LIMITS, {
    ownerActiveRuns: 32,
    contextBytes: 2_000_000,
    inputFilesBytes: 8 * 1024 * 1024,
    workspaceTransferBytes: 16 * 1024 * 1024,
    modelTurnMarks: 400,
    delegationDepth: 3,
    delegationCheckDepth: 4,
    agentFallbacks: 4,
    idempotencyKeyChars: 200,
    toolCacheEntries: 1000,
    toolCacheBytes: 16 * 1024 * 1024,
    projectionCacheRuns: 128,
    filePayloadCacheFiles: 128,
    fileBytes: 8 * 1024 * 1024,
    memoryEntryBytes: 256_000,
    nodeQueueLength: 1000,
    nodeMessageBytes: 24 * 1024 * 1024,
  });
});
