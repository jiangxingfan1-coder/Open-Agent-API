import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agent, FixtureModel, principal, setup, waitFor } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { projects } from '../src/store/projects.js';
import { escapeFts5Query, searchProjectMemory } from '../src/store/project-fts.js';
import { cronMatchesMinute, parseCron, validateTimeZone } from '../src/lang/cron.js';
import { WorkflowRunner } from '../src/kernel/task-workflows.js';
import { collectNativeArtifacts } from '../src/fabric/native-executor.js';
import { setArtifactByteLimit, storeArtifactStreamOrPath } from '../src/store/large-artifacts.js';
import { LIMITS } from '../src/core/limits.js';

test('FTS5 project & private memory search handles CJK, English, special-char escaping, sync updates, and non-FTS5 fallback', async () => {
  const s = await setup();
  try {
    const data = projects(s.store);
    data.create(principal, 'apollo', 'Apollo Workstation');

    const first = data.put(principal, 'apollo', 'arch', 'pg-pool', {
      summary: '生产环境使用 PostgreSQL 16 连接池，最大连接数 120，监听端口 5432',
      tags: ['database', 'postgresql', 'pooling'],
    });
    data.put(principal, 'apollo', 'arch', 'redis-cache', {
      summary: '会话与热点缓存采用 Redis Cluster，端口 6379',
      tags: ['cache', 'redis'],
    });
    const temp = data.put(principal, 'apollo', 'ops', 'temp-note', {
      summary: '临时迁移草稿：旧版 MySQL 归档说明',
    });

    // CJK phrase + BM25 relevance ranking
    const cjkHits = searchProjectMemory(s.store, 'apollo', 'PostgreSQL 连接池端口');
    assert.ok(cjkHits.length >= 1);
    assert.equal(cjkHits[0]!.key, 'pg-pool');
    assert.ok(cjkHits[0]!.score > (cjkHits[1]?.score ?? 0));

    // Fallback scorer parity when FTS5 is bypassed
    const fallbackHits = searchProjectMemory(s.store, 'apollo', '数据库连接池', {
      forceFallback: true,
    });
    assert.equal(fallbackHits[0]?.key, 'pg-pool');

    // Adversarial FTS5 syntax characters never throw SQL errors
    for (const hostile of [
      'AND OR NOT NEAR "quoted" (unclosed * ^ : { } + - ? ; DROP TABLE project_memories; --',
      '"" *** ::: ((( ))) ^^^',
      '??? !!! --- \0',
    ]) {
      const escaped = escapeFts5Query(hostile);
      assert.equal(typeof escaped, 'string');
      assert.doesNotThrow(() => searchProjectMemory(s.store, 'apollo', hostile));
    }
    assert.deepEqual(searchProjectMemory(s.store, 'apollo', '??? !!! ---'), []);

    // Update & delete keep FTS5 index synchronized
    data.put(
      principal,
      'apollo',
      'arch',
      'pg-pool',
      { summary: '已升级至 ClickHouse 实时分析集群' },
      first.revision,
    );
    assert.equal(searchProjectMemory(s.store, 'apollo', 'PostgreSQL').length, 0);
    assert.equal(searchProjectMemory(s.store, 'apollo', 'ClickHouse 实时分析')[0]?.key, 'pg-pool');

    data.delete(principal, 'apollo', 'ops', 'temp-note', temp.revision);
    assert.equal(searchProjectMemory(s.store, 'apollo', 'MySQL').length, 0);

    // HTTP endpoint enforces project read grants
    const reader = (
      await s.request('POST', '/v1/keys', {
        name: 'proj-reader',
        agents: ['*'],
        scopes: ['read'],
      })
    ).json();
    const denied = await s.request(
      'GET',
      `/v1/projects/apollo/memory/search?q=${encodeURIComponent('ClickHouse')}`,
      undefined,
      reader.token,
    );
    assert.equal(denied.statusCode, 403);

    data.grant(principal, 'apollo', reader.id, 'read');
    const allowed = await s.request(
      'GET',
      `/v1/projects/apollo/memory/search?q=${encodeURIComponent('ClickHouse')}&namespace=arch&limit=5`,
      undefined,
      reader.token,
    );
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().data.length, 1);
    assert.equal(allowed.json().data[0].key, 'pg-pool');
  } finally {
    await s.cleanup();
  }
});

test('memory_search builtin tool and dynamic Top-K project context recall relevant entries beyond static top-16 truncation', async () => {
  let capturedPrompts = '';
  let stepCount = 0;
  const s = await setup(
    new FixtureModel((_a, messages) => {
      capturedPrompts = messages.map((m) => m.content).join('\n');
      if (capturedPrompts.includes('USE_MEMORY_SEARCH_TOOL') && stepCount === 0) {
        stepCount++;
        return {
          calls: [
            {
              id: 'call_search_proj',
              name: 'memory_search',
              arguments: { scope: 'project', query: '量子加密网关密钥轮换', limit: 3 },
            },
            {
              id: 'call_search_priv',
              name: 'memory_search',
              arguments: { scope: 'private', query: '专属偏好番茄钟' },
            },
          ],
        };
      }
      const toolOutputs = messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join('\n');
      return { text: `DONE:${toolOutputs}` };
    }),
  );
  try {
    const data = projects(s.store);
    data.create(principal, 'deep-proj', 'Deep Project');

    // Insert the target entry FIRST, then 24 newer unrelated entries so static slice(0, 16) would miss it!
    data.put(principal, 'deep-proj', 'security', 'quantum-key-policy', {
      rule: '量子加密网关密钥轮换周期为每 24 小时自动执行一次 QUANTUM_ROTATE_24H',
    });
    for (let i = 1; i <= 24; i++) {
      data.put(principal, 'deep-proj', 'misc', `filler-${String(i).padStart(2, '0')}`, {
        note: `普通日常巡检记录编号 ${i}`,
      });
    }

    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/mem',
          tools: [builtin('memory_read'), builtin('memory_write'), builtin('memory_search')],
        }),
      ),
    );

    // 1. Dynamic Top-K context recall based on task input recalls the oldest entry #0!
    const recallRes = await s.request('POST', '/v1/responses', {
      model: 'agent/mem',
      input: '请检查量子加密网关密钥轮换周期是多少？',
      metadata: { 'oaa.project': 'deep-proj', 'oaa.project.remember': 'false' },
    });
    assert.equal(recallRes.statusCode, 200, recallRes.body);
    assert.match(capturedPrompts, /QUANTUM_ROTATE_24H/);

    // 2. Private memory isolation + memory_search tool execution for both project and private scopes
    const alice = (
      await s.request('POST', '/v1/keys', {
        name: 'alice',
        agents: ['agent/mem'],
        scopes: ['read', 'invoke'],
      })
    ).json();
    const bob = (
      await s.request('POST', '/v1/keys', {
        name: 'bob',
        agents: ['agent/mem'],
        scopes: ['read', 'invoke'],
      })
    ).json();
    data.grant(principal, 'deep-proj', alice.id, 'read');

    await s.request(
      'POST',
      '/v1/memory',
      { namespace: 'prefs', key: 'focus', value: 'Alice 专属偏好番茄钟 25 分钟 ALICE_POMODORO' },
      alice.token,
    );
    await s.request(
      'POST',
      '/v1/memory',
      { namespace: 'prefs', key: 'focus', value: 'Bob 机密番茄钟 BOB_SECRET_POMODORO' },
      bob.token,
    );

    const toolRes = await s.request(
      'POST',
      '/v1/responses',
      {
        model: 'agent/mem',
        input: 'USE_MEMORY_SEARCH_TOOL',
        metadata: { 'oaa.project': 'deep-proj', 'oaa.project.remember': 'false' },
      },
      alice.token,
    );
    assert.equal(toolRes.statusCode, 200, toolRes.body);
    const answerText = JSON.stringify(toolRes.json().output);
    assert.match(answerText, /QUANTUM_ROTATE_24H/);
    assert.match(answerText, /ALICE_POMODORO/);
    assert.doesNotMatch(answerText, /BOB_SECRET_POMODORO/);
  } finally {
    await s.cleanup();
  }
});

test('cron parser validates 5-field expressions, evaluates IANA timezones across day boundaries, deduplicates slots, and skips missed downtime', async () => {
  // Valid syntax & invalid rejections
  assert.ok(parseCron('*/15 0,9-17 * 1-12 1-5'));
  assert.ok(parseCron('0 0 * * 7'));
  assert.equal(validateTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.throws(() => parseCron('* * * *'), { code: 'invalid_request' });
  assert.throws(() => parseCron('60 * * * *'), { code: 'invalid_request' });
  assert.throws(() => parseCron('*/0 * * * *'), { code: 'invalid_request' });
  assert.throws(() => parseCron('0 18-9 * * *'), { code: 'invalid_request' });
  assert.throws(() => validateTimeZone('Mars/Olympus_Mons'), { code: 'invalid_request' });

  // Cross-timezone boundary check: 2026-11-18T01:30:00Z is 09:30 in Asia/Shanghai (Wednesday, dow=3)
  // and 2026-11-17T20:30:00 in America/New_York (Tuesday, dow=2)!
  const utcEpoch = Date.parse('2026-11-18T01:30:15Z');
  assert.equal(cronMatchesMinute('30 9 * * 3', 'Asia/Shanghai', utcEpoch), true);
  assert.equal(cronMatchesMinute('30 9 * * 3', 'UTC', utcEpoch), false);
  assert.equal(cronMatchesMinute('30 20 17 11 2', 'America/New_York', utcEpoch), true);
  assert.equal(cronMatchesMinute('30 20 18 11 3', 'America/New_York', utcEpoch), false);

  // WorkflowRunner cron deduplication, skip-missed-slots on restart, and creator key revalidation
  const s = await setup(new FixtureModel((_a, msgs) => ({ text: `CRON:${msgs.at(-1)!.content}` })));
  const runner = new WorkflowRunner(s.store, s.kernel, (p) => s.auth.refreshPrincipal(p));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const creator = (
      await s.request('POST', '/v1/keys', {
        name: 'cron-creator',
        agents: ['*'],
        scopes: ['admin', 'read', 'invoke'],
      })
    ).json();

    // Validation endpoint rejects bad cron or timezone
    const badTz = await s.request(
      'POST',
      '/v1/workflows/validate',
      {
        definition: {
          id: 'bad-cron',
          name: 'Bad Cron',
          graph: { steps: [{ id: 's1', tool: 'agent/test', arguments: { input: 'hi' } }] },
          enabled: true,
          trigger: { kind: 'cron', expression: '30 9 * * *', timezone: 'Invalid/Zone' },
        },
      },
      creator.token,
    );
    assert.equal(badTz.statusCode, 400);

    const published = await s.request(
      'POST',
      '/v1/workflows',
      {
        definition: {
          id: 'morning-brief',
          name: 'Morning Brief',
          graph: {
            steps: [
              { id: 's1', tool: 'agent/test', arguments: { input: { $ref: 'input#/topic' } } },
            ],
            output: { $ref: 's1#/output' },
          },
          enabled: true,
          trigger: {
            kind: 'cron',
            expression: '30 9 * * *',
            timezone: 'Asia/Shanghai',
            input: { topic: 'SHANGHAI_930' },
          },
        },
        revision: 'new',
      },
      creator.token,
    );
    assert.equal(published.statusCode, 200, published.body);

    // Non-matching minute after missed historical windows -> 0 catch-up bursts
    runner.tick(Date.parse('2026-11-18T01:31:00Z'));
    assert.equal(runner.records.executions('owner').length, 0);

    // Matching minute triggers once even when ticked multiple times within the same minute
    runner.tick(Date.parse('2026-11-18T01:30:05Z'));
    runner.tick(Date.parse('2026-11-18T01:30:45Z'));
    assert.equal(runner.records.executions('owner').length, 1);

    await waitFor(() => runner.records.executions('owner')[0]?.status === 'completed');
    assert.equal(runner.records.executions('owner')[0]?.output, 'CRON:SHANGHAI_930');

    // Even after completion, ticking the same minute slot again does not re-fire
    runner.tick(Date.parse('2026-11-18T01:30:59Z'));
    assert.equal(runner.records.executions('owner').length, 1);

    // Revoking creator key blocks the next day's slot and records trigger_status.error
    await s.request('DELETE', `/v1/keys/${creator.id}`);
    runner.tick(Date.parse('2026-11-19T01:30:10Z'));
    assert.equal(runner.records.executions('owner').length, 1);
    assert.equal(
      runner.records.get('owner', 'morning-brief').triggerStatus?.error,
      'run_key_inactive',
    );
  } finally {
    await runner.close();
    await s.cleanup();
  }
});

test('inbound workflow webhooks store SHA-256 hash only, verify token in constant time, support rotation, and enforce archive/disable/size/key guards', async () => {
  const s = await setup(new FixtureModel((_a, msgs) => ({ text: `HOOK:${msgs.at(-1)!.content}` })));
  try {
    s.store.publish('owner', makeBundle(agent()));
    const creator = (
      await s.request('POST', '/v1/keys', {
        name: 'hook-admin',
        agents: ['*'],
        scopes: ['admin', 'read', 'invoke'],
      })
    ).json();

    const created = await s.request(
      'POST',
      '/v1/workflows',
      {
        definition: {
          id: 'deploy-hook',
          name: 'Deploy Hook',
          graph: {
            steps: [{ id: 's1', tool: 'agent/test', arguments: { input: { $ref: 'input#/tag' } } }],
            output: { $ref: 's1#/output' },
          },
          enabled: true,
          trigger: { kind: 'webhook' },
        },
        revision: 'new',
      },
      creator.token,
    );
    assert.equal(created.statusCode, 200, created.body);
    const firstBody = created.json();
    const token1 = firstBody.webhook_token as string;
    assert.match(token1, /^oaw_[A-Za-z0-9_-]{32}$/);
    const expectedHash1 = createHash('sha256').update(token1).digest('hex');
    assert.equal(firstBody.definition.trigger.secretHash, expectedHash1);

    // Raw SQLite row must never store plaintext webhook_token
    const rawRow = String(
      s.store.db.prepare('SELECT payload FROM task_workflows WHERE id=?').get('deploy-hook')!
        .payload,
    );
    assert.equal(rawRow.includes(token1), false);
    assert.equal(rawRow.includes(expectedHash1), true);

    // Missing or wrong token -> 401 without requiring a gateway API key
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/webhooks/workflows/deploy-hook',
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/webhooks/workflows/deploy-hook',
          headers: { authorization: 'Bearer oaw_wrong_token_value_00000000000000' },
          payload: {},
        })
      ).statusCode,
      401,
    );

    // Valid Bearer token starts workflow with JSON payload as input
    const run1 = await s.app.inject({
      method: 'POST',
      url: '/v1/webhooks/workflows/deploy-hook',
      headers: { authorization: `Bearer ${token1}` },
      payload: { tag: 'v1.2.0' },
    });
    assert.equal(run1.statusCode, 202, run1.body);
    await waitFor(
      async () =>
        (await s.request('GET', `/v1/workflow-runs/${run1.json().id}`)).json().status ===
        'completed',
    );
    assert.equal(
      (await s.request('GET', `/v1/workflow-runs/${run1.json().id}`)).json().output,
      'HOOK:v1.2.0',
    );

    // Oversized > 64 KiB payload -> 413
    const huge = await s.app.inject({
      method: 'POST',
      url: '/v1/webhooks/workflows/deploy-hook',
      headers: { 'x-oaa-webhook-token': token1 },
      payload: { tag: 'x'.repeat(70_000) },
    });
    assert.equal(huge.statusCode, 413);

    // Rotate token -> old token fails (401), new token via X-OAA-Webhook-Token succeeds (202)
    const rotated = await s.request(
      'POST',
      '/v1/workflows/deploy-hook/webhook-token',
      {},
      creator.token,
    );
    assert.equal(rotated.statusCode, 200, rotated.body);
    const token2 = rotated.json().webhook_token as string;
    assert.notEqual(token2, token1);

    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/webhooks/workflows/deploy-hook',
          headers: { 'x-oaa-webhook-token': token1 },
          payload: { tag: 'stale' },
        })
      ).statusCode,
      401,
    );
    const run2 = await s.app.inject({
      method: 'POST',
      url: '/v1/webhooks/workflows/deploy-hook',
      headers: { 'x-oaa-webhook-token': token2 },
      payload: { tag: 'v1.3.0' },
    });
    assert.equal(run2.statusCode, 202, run2.body);

    // Disabled workflow -> 403
    const paused = await s.request(
      'POST',
      '/v1/workflows',
      {
        definition: { ...rotated.json().definition, enabled: false },
        revision: rotated.json().revision,
      },
      creator.token,
    );
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/webhooks/workflows/deploy-hook',
          headers: { 'x-oaa-webhook-token': token2 },
          payload: { tag: 'paused' },
        })
      ).statusCode,
      403,
    );

    // Archived workflow -> 409
    const archived = await s.request(
      'POST',
      '/v1/workflows/deploy-hook/archive',
      { revision: paused.json().revision },
      creator.token,
    );
    assert.equal(archived.statusCode, 200);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/v1/webhooks/workflows/deploy-hook',
          headers: { 'x-oaa-webhook-token': token2 },
          payload: { tag: 'archived' },
        })
      ).statusCode,
      409,
    );

    // Restore, re-enable, then revoke creator key -> 401
    const restored = await s.request(
      'POST',
      '/v1/workflows/deploy-hook/restore',
      { revision: archived.json().revision },
      creator.token,
    );
    await s.request(
      'POST',
      '/v1/workflows',
      {
        definition: { ...restored.json().definition, enabled: true },
        revision: restored.json().revision,
      },
      creator.token,
    );
    await s.request('DELETE', `/v1/keys/${creator.id}`);
    const afterRevoke = await s.app.inject({
      method: 'POST',
      url: '/v1/webhooks/workflows/deploy-hook',
      headers: { 'x-oaa-webhook-token': token2 },
      payload: { tag: 'revoked' },
    });
    assert.equal(afterRevoke.statusCode, 409);
    assert.equal(afterRevoke.json().error.code, 'run_key_inactive');
  } finally {
    await s.cleanup();
  }
});

test('large >8 MiB (12 MiB) streaming media artifacts persist, pass signature checks, stream-download intact, and detect tampering', async () => {
  const tempOutDir = await mkdtemp(path.join(os.tmpdir(), 'oaa-large-artifact-'));
  let called = false;
  const s = await setup(
    new FixtureModel(() => {
      if (!called) {
        called = true;
        return { calls: [{ id: 'v1', name: 'render_video', arguments: {} }] };
      }
      return { text: '12 MiB MP4 deliverable ready.' };
    }),
  );
  try {
    // Default limit advertised on /v1/media/formats is 64 MiB
    const formats = await s.request('GET', '/v1/media/formats');
    assert.equal(formats.statusCode, 200);
    assert.equal(formats.json().max_artifact_bytes, LIMITS.artifactExportBytes);
    assert.equal(LIMITS.artifactExportBytes, 64 * 1024 * 1024);

    // Build a deterministic 12 MiB (12,582,912 bytes > 8 MiB) MP4 header + payload on disk
    const twelveMiB = 12 * 1024 * 1024;
    const mp4Path = path.join(tempOutDir, 'result.mp4');
    const mp4Header = Buffer.from([
      0x00,
      0x00,
      0x00,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70, // size=24, 'ftyp'
      0x69,
      0x73,
      0x6f,
      0x6d,
      0x00,
      0x00,
      0x02,
      0x00, // 'isom'
      0x69,
      0x73,
      0x6f,
      0x6d,
      0x69,
      0x73,
      0x6f,
      0x32,
    ]);
    const expectedHash = createHash('sha256');
    const fh = await open(mp4Path, 'w', 0o600);
    try {
      await fh.write(mp4Header, 0, mp4Header.length, 0);
      expectedHash.update(mp4Header);
      const pattern = randomBytes(65_536);
      let written = mp4Header.length;
      while (written < twelveMiB) {
        const len = Math.min(pattern.length, twelveMiB - written);
        const slice = pattern.subarray(0, len);
        await fh.write(slice, 0, len, written);
        expectedHash.update(slice);
        written += len;
      }
    } finally {
      await fh.close();
    }
    const expectedSha256 = expectedHash.digest('hex');

    // collectNativeArtifacts streams SHA-256 and avoids Base64 string allocation for >8 MiB files
    const collected = await collectNativeArtifacts(tempOutDir);
    assert.equal(collected.length, 1);
    assert.equal(collected[0]!.name, 'result.mp4');
    assert.equal(collected[0]!.content, '');
    assert.equal(collected[0]!.bytes, twelveMiB);
    assert.equal(collected[0]!.sha256, expectedSha256);
    assert.ok(collected[0]!.localPath);

    // Media job with a portable tool returning the 12 MiB streaming artifact completes end-to-end
    const videoCap = {
      id: 'fixture/render_video',
      version: '1',
      description: 'Render a 12 MiB test MP4 deliverable',
      placement: 'host-bound' as const,
      nodeId: 'local',
      effect: 'read' as const,
      requiresApproval: false,
      timeoutMs: 30_000,
      cacheTtlMs: 0,
      resultExport: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    s.runtime.config.tools.push({
      reference: 'render_video',
      capability: videoCap,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('render_video', async () => ({
      value: { rendered: true, bytes: twelveMiB },
      artifacts: collected,
    }));

    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/video',
          tools: [
            {
              name: 'render_video',
              capability: videoCap,
              handler: { kind: 'node', reference: 'render_video' },
            },
          ],
        }),
      ),
    );

    const jobStart = await s.request('POST', '/v1/media/jobs', {
      agent: 'agent/video',
      input: 'Create 12 MiB MP4 video',
      kind: 'video',
      format: 'mp4',
    });
    assert.equal(jobStart.statusCode, 202, jobStart.body);
    const done = await s.kernel.wait(jobStart.json().id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.artifactIds.length, 1);
    const artifactId = done.artifactIds[0]!;

    const jobView = await s.request('GET', `/v1/media/jobs/${done.id}`);
    assert.equal(jobView.statusCode, 200);
    assert.equal(jobView.json().validation, 'signature_only');
    assert.equal(jobView.json().artifacts[0].mime, 'video/mp4');
    assert.equal(jobView.json().artifacts[0].bytes, twelveMiB);

    // Download via GET /v1/files/:id/content streams exact 12 MiB bytes matching SHA-256
    const download = await s.app.inject({
      method: 'GET',
      url: `/v1/files/${artifactId}/content`,
      headers: { authorization: `Bearer ${(await import('./helpers.js')).token}` },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-length'], String(twelveMiB));
    assert.equal(download.rawPayload.length, twelveMiB);
    assert.equal(createHash('sha256').update(download.rawPayload).digest('hex'), expectedSha256);

    // Configurable artifact limit rejects oversized exports when lowered
    setArtifactByteLimit(s.store, 10 * 1024 * 1024);
    await assert.rejects(
      () =>
        storeArtifactStreamOrPath(s.store, {
          owner: 'owner',
          name: 'too-big.mp4',
          runId: done.id,
          sourcePath: mp4Path,
        }),
      { code: 'artifacts_too_large' },
    );
    setArtifactByteLimit(s.store, undefined);

    // Tampering with stored file on disk is caught by chunked SHA-256 pre-verification (500 file_integrity)
    const storedFile = path.join(s.store.root, 'files', artifactId);
    const corrupt = await open(storedFile, 'r+');
    try {
      await corrupt.write(Buffer.from([0xff]), 0, 1, twelveMiB - 1);
    } finally {
      await corrupt.close();
    }
    const tampered = await s.app.inject({
      method: 'GET',
      url: `/v1/files/${artifactId}/content`,
      headers: { authorization: `Bearer ${(await import('./helpers.js')).token}` },
    });
    assert.equal(tampered.statusCode, 500);
    assert.equal(tampered.json().error.code, 'file_integrity');
  } finally {
    await s.cleanup();
    await rm(tempOutDir, { recursive: true, force: true });
  }
});
