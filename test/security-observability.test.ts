import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import type { ToolBinding } from '../src/core/contracts.js';
import {
  childTraceContext,
  formatTraceparent,
  parseTraceHeaders,
  parseTraceparent,
  parseTracestate,
} from '../src/core/trace-context.js';
import { sha } from '../src/core/util.js';
import { acpSandboxPlan, sandboxPlan } from '../src/engines/native-sandbox.js';
import {
  SrtLauncher,
  type SandboxLauncher,
  type SandboxPolicy,
  type SrtSlotBackend,
} from '../src/engines/sandbox.js';
import { NO_NEGOTIATION, advertisedExecution } from '../src/fabric/advertised-execution.js';
import { RemoteExecutor } from '../src/fabric/network.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import {
  platformVerificationTransport,
  type VerificationDelivery,
} from '../src/gateway/platform-verification.js';
import { createGateway } from '../src/gateway/server.js';
import { verifySignature } from '../src/gateway/webhook-core.js';
import { makeBundle } from '../src/lang/bundle.js';
import { FixtureModel, agent, secondToken, setup, token } from './helpers.js';

// Module 8 (Sandbox subject pool + Antigravity/ACP launch profiles),
// Module 9 (SQLite-persisted portal rate limits + anti-enumeration verification webhook),
// Module 10 (Prometheus /metrics, W3C Trace Context propagation, remote adapter profile sync & node pairing).
// In-process only: opens no sockets so it runs in both test:offline and full test suites.

class FakeSlotBackend implements SrtSlotBackend {
  inits = 0;
  rotates = 0;
  activeCommands = new Map<string, string[]>();
  history: { commandId: string; allowedDomains: string[] }[] = [];
  constructor(readonly slotIndex: number) {}
  async init(): Promise<void> {
    this.inits++;
  }
  async rotate(): Promise<void> {
    this.rotates++;
    this.activeCommands.clear();
  }
  async wrap(req: {
    commandId: string;
    inner: string;
    commandText: string;
    allowRead: string[];
    allowWrite: string[];
    allowedDomains: string[];
  }): Promise<{ wrapped: string; proxyPort: number | null }> {
    this.activeCommands.set(req.commandId, [...req.allowedDomains]);
    this.history.push({ commandId: req.commandId, allowedDomains: [...req.allowedDomains] });
    return {
      wrapped: `slot=${this.slotIndex} ${req.inner}`,
      proxyPort: 40_000 + this.slotIndex,
    };
  }
  async unregister(commandId: string): Promise<void> {
    this.activeCommands.delete(commandId);
  }
  async close(): Promise<void> {
    this.activeCommands.clear();
  }
}

test('sandbox pool: distinct caller subjects run concurrently on isolated slots without domain cross-use', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sec-obs-pool-'));
  const slots: FakeSlotBackend[] = [];
  const launcher = new SrtLauncher({
    dataDir: dir,
    maxConcurrentSandboxes: 2,
    createSlotBackend: (idx) => {
      const b = new FakeSlotBackend(idx);
      slots.push(b);
      return b;
    },
  });
  try {
    const sig = new AbortController().signal;
    // Alice holds slot 0 with alice.example.com.
    const alice1 = await launcher.wrap(
      '/bin/echo',
      ['alice-1'],
      {},
      {
        workspace: dir,
        readOnly: [],
        allowedDomains: ['alice.example.com'],
        cpuSeconds: 10,
        subject: 'key:alice',
      },
      sig,
    );
    assert.match(alice1.args[1]!, /slot=0/);

    // Bob arrives while Alice is still running: gets slot 1 immediately, never sees Alice's domain.
    const bob = await launcher.wrap(
      '/bin/echo',
      ['bob'],
      {},
      {
        workspace: dir,
        readOnly: [],
        allowedDomains: ['bob.example.com'],
        cpuSeconds: 10,
        subject: 'key:bob',
      },
      sig,
    );
    assert.match(bob.args[1]!, /slot=1/);
    assert.equal(slots.length, 2);
    assert.deepEqual([...slots[0]!.activeCommands.values()], [['alice.example.com']]);
    assert.deepEqual([...slots[1]!.activeCommands.values()], [['bob.example.com']]);

    // Same subject + identical domain policy shares Alice's dedicated slot 0.
    const alice2 = await launcher.wrap(
      '/bin/echo',
      ['alice-2'],
      {},
      {
        workspace: dir,
        readOnly: [],
        allowedDomains: ['alice.example.com'],
        cpuSeconds: 10,
        subject: 'key:alice',
      },
      sig,
    );
    assert.match(alice2.args[1]!, /slot=0/);
    assert.equal(launcher.activeCount, 3);

    // Carol arrives when both slots are occupied: queues until Bob releases slot 1, then rotates slot 1.
    let carolReady = false;
    const carolPromise = launcher
      .wrap(
        '/bin/echo',
        ['carol'],
        {},
        {
          workspace: dir,
          readOnly: [],
          allowedDomains: ['carol.example.com'],
          cpuSeconds: 10,
          subject: 'key:carol',
        },
        sig,
      )
      .then((cmd) => {
        carolReady = true;
        return cmd;
      });

    // A queued request whose AbortSignal fires leaves the queue cleanly without taking a slot.
    const abortDave = new AbortController();
    const davePromise = launcher.wrap(
      '/bin/echo',
      ['dave'],
      {},
      {
        workspace: dir,
        readOnly: [],
        allowedDomains: ['dave.example.com'],
        cpuSeconds: 10,
        subject: 'key:dave',
      },
      abortDave.signal,
    );
    abortDave.abort();
    await assert.rejects(davePromise, { code: 'cancelled' });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(carolReady, false, 'Carol waits while pool is at capacity');

    bob.release();
    const carol = await carolPromise;
    assert.equal(carolReady, true);
    assert.match(carol.args[1]!, /slot=1/);
    assert.equal(slots[1]!.rotates, 1, 'slot 1 rotated proxy state before switching Bob -> Carol');
    assert.deepEqual([...slots[1]!.activeCommands.values()], [['carol.example.com']]);

    alice1.release();
    alice2.release();
    carol.release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launcher.activeCount, 0);

    // Untagged calls (no `subject`) still serialize one at a time.
    const u1 = await launcher.wrap(
      '/bin/true',
      [],
      {},
      { workspace: dir, readOnly: [], allowedDomains: [], cpuSeconds: 5 },
      sig,
    );
    let u2Ready = false;
    const u2Promise = launcher
      .wrap(
        '/bin/true',
        [],
        {},
        { workspace: dir, readOnly: [], allowedDomains: [], cpuSeconds: 5 },
        sig,
      )
      .then((w) => {
        u2Ready = true;
        return w;
      });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(u2Ready, false);
    u1.release();
    (await u2Promise).release();
  } finally {
    await launcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox profiles: Antigravity and generic stdio ACP adapters resolve symlinks, readOnly roots and isolated HOME/XDG', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sec-obs-profiles-'));
  try {
    // Simulate a macOS Antigravity.app bundle + symlinked `agy` launcher and an ACP node script.
    const appBinDir = path.join(dir, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
    const pkgDir = path.join(dir, 'acp-pkg');
    const binLinks = path.join(dir, 'links');
    const cwdAgy = path.join(dir, 'ws-agy');
    const cwdAcp = path.join(dir, 'ws-acp');
    await mkdir(appBinDir, { recursive: true });
    await mkdir(pkgDir, { recursive: true });
    await mkdir(binLinks, { recursive: true });
    await mkdir(cwdAgy, { recursive: true });
    await mkdir(cwdAcp, { recursive: true });

    const realAgy = path.join(appBinDir, 'agy');
    await writeFile(realAgy, '#!/bin/sh\necho 1.0.0\n');
    await chmod(realAgy, 0o755);
    const agyLink = path.join(binLinks, 'agy');
    await symlink(realAgy, agyLink);

    await writeFile(path.join(pkgDir, 'package.json'), '{"name":"custom-acp"}');
    const acpEntry = path.join(pkgDir, 'bin', 'server.mjs');
    await mkdir(path.dirname(acpEntry), { recursive: true });
    await writeFile(acpEntry, 'console.log("acp");\n');
    const acpScriptLink = path.join(binLinks, 'server-link.mjs');
    await symlink(acpEntry, acpScriptLink);

    const dummyLauncher: SandboxLauncher = {
      backend: 'srt',
      report: () => ({ backend: 'srt', version: 'test', kinds: ['script', 'native/antigravity'] }),
      wrap: async (command, args, env) => ({ command, args, env, release: () => {} }),
      close: async () => {},
    };

    const agyPlan = await sandboxPlan('antigravity', agyLink, cwdAgy, {
      launcher: dummyLauncher,
      apiKey: 'AIza-caller-key',
      allowedDomains: ['generativelanguage.googleapis.com'],
      cpuSeconds: 120,
      subject: 'key:caller-1',
    });
    assert.equal(agyPlan.env.GEMINI_API_KEY, 'AIza-caller-key');
    assert.ok(agyPlan.env.HOME?.endsWith(`${path.sep}.oaa-home`));
    assert.equal(agyPlan.env.AGY_HOME, path.join(agyPlan.env.HOME!, '.gemini'));
    assert.equal(agyPlan.env.XDG_CONFIG_HOME, path.join(agyPlan.env.HOME!, '.config'));
    assert.equal(agyPlan.policy.subject, 'key:caller-1');
    assert.ok(
      agyPlan.policy.readOnly.some((p) => p.endsWith(`Antigravity.app${path.sep}Contents`)),
      `expected .app/Contents in readOnly: ${JSON.stringify(agyPlan.policy.readOnly)}`,
    );

    const acpPlan = await acpSandboxPlan(process.execPath, [acpScriptLink, '--acp'], cwdAcp, {
      launcher: dummyLauncher,
      allowedDomains: ['api.example.com'],
      cpuSeconds: 90,
      subject: 'key:caller-2',
    });
    assert.equal(acpPlan.launch.command, process.execPath);
    assert.ok(acpPlan.launch.args[0]!.endsWith(`acp-pkg${path.sep}bin${path.sep}server.mjs`));
    assert.equal(acpPlan.launch.args[1], '--acp');
    assert.ok(acpPlan.policy.readOnly.some((p) => p.endsWith('acp-pkg')));
    assert.ok(!acpPlan.policy.readOnly.includes(dir), 'never widens above package root');
    assert.equal(acpPlan.env.XDG_CONFIG_HOME, path.join(cwdAcp, '.oaa-home', '.config'));
    assert.equal(acpPlan.policy.subject, 'key:caller-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gateway forwards caller subject into sandbox policy so multi-caller script runs isolate per key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sec-obs-gw-box-'));
  const observed: SandboxPolicy[] = [];
  const launcher: SandboxLauncher = {
    backend: 'srt',
    report: () => ({ backend: 'srt', version: 'test', kinds: ['script'] }),
    wrap: async (command, args, env, policy) => {
      observed.push(policy);
      return { command, args, env, release: () => {} };
    },
    close: async () => {},
  };
  const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({ok:true})))`;
  const tool: ToolBinding = {
    name: 'ping',
    capability: {
      id: 'demo/ping',
      version: '1',
      description: 'Ping',
      placement: 'portable',
      effect: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      requiresApproval: false,
      timeoutMs: 10_000,
      cacheTtlMs: 0,
      resultExport: true,
    },
    handler: { kind: 'script', path: 'tools/ping.js', runtime: 'node' },
  };
  const workerCfg = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    scripts: ['node'],
  });
  const driver = new FixtureModel((_a, msgs) =>
    msgs.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { calls: [{ id: 'c1', name: 'ping', arguments: {} }] },
  );
  const runtime = new WorkerRuntime(workerCfg, new Map(), new Map([['fixture', driver]]), {
    sandbox: launcher,
  });
  process.env.OAA_TEST_TOKEN = token;
  const g = await createGateway(
    gatewaySchema.parse({
      dataDir: path.join(dir, 'gateway'),
      port: 0,
      defaultKeyExecution: 'sandbox',
      keys: [
        {
          name: 'admin',
          owner: 'owner',
          tokenEnv: 'OAA_TEST_TOKEN',
          scopes: ['admin', 'invoke', 'read'],
        },
      ],
      localWorker: workerCfg,
    }),
    runtime,
  );
  try {
    g.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/ping', tools: [tool] }), [
        {
          path: 'tools/ping.js',
          content: Buffer.from(script).toString('base64'),
          sha256: sha(script),
        },
      ]),
    );
    const makeCaller = async (name: string) =>
      (
        await g.app.inject({
          method: 'POST',
          url: '/v1/keys',
          headers: { authorization: `Bearer ${token}` },
          payload: { name, agents: ['*'], scopes: ['invoke', 'read'] },
        })
      ).json() as { id: string; token: string };
    const c1 = await makeCaller('caller-a');
    const c2 = await makeCaller('caller-b');
    const [r1, r2] = await Promise.all([
      g.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { authorization: `Bearer ${c1.token}` },
        payload: { model: 'agent/ping', input: '1' },
      }),
      g.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { authorization: `Bearer ${c2.token}` },
        payload: { model: 'agent/ping', input: '2' },
      }),
    ]);
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.deepEqual(observed.map((p) => p.subject).sort(), [c1.id, c2.id].sort());
  } finally {
    await g.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform security: rate limits persist in SQLite across gateway restarts (login, signup, redeem)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sec-obs-ratelimit-'));
  process.env.OAA_TEST_TOKEN = token;
  const makeGateway = () =>
    createGateway(
      gatewaySchema.parse({
        dataDir: dir,
        port: 0,
        trustProxy: true,
        keys: [
          {
            name: 'admin',
            owner: 'owner',
            tokenEnv: 'OAA_TEST_TOKEN',
            scopes: ['admin', 'invoke', 'read'],
          },
        ],
        platform: { owner: 'owner', registration: 'open' },
      }),
    );

  let g = await makeGateway();
  let sessionToken = '';
  try {
    const signed = await g.app.inject({
      method: 'POST',
      url: '/v1/portal/signup',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: { email: 'persist@x.io', password: 'password-ok-1' },
    });
    assert.equal(signed.statusCode, 201);
    sessionToken = signed.json().session.token as string;

    // Hit 10 failed logins for persist@x.io and 10 failed credit-code redemptions before restart.
    for (let i = 0; i < 10; i++) {
      const badLogin = await g.app.inject({
        method: 'POST',
        url: '/v1/portal/login',
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
        payload: { email: 'persist@x.io', password: 'wrong-password' },
      });
      assert.equal(badLogin.statusCode, 401);

      const badRedeem = await g.app.inject({
        method: 'POST',
        url: '/v1/portal/redeem',
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { code: `WRONG-${i}` },
      });
      assert.equal(badRedeem.statusCode, 400);
    }

    // Close and recreate the gateway on the same SQLite dataDir (simulating process restart).
    await g.app.close();
    g = await makeGateway();

    const loginAfterRestart = await g.app.inject({
      method: 'POST',
      url: '/v1/portal/login',
      headers: { 'x-forwarded-for': '198.51.100.250' },
      payload: { email: 'persist@x.io', password: 'password-ok-1' },
    });
    assert.equal(loginAfterRestart.statusCode, 429, 'login email limit survived restart');
    assert.equal(loginAfterRestart.json().error.code, 'rate_limited');

    const redeemAfterRestart = await g.app.inject({
      method: 'POST',
      url: '/v1/portal/redeem',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code: 'ANOTHER-WRONG' },
    });
    assert.equal(redeemAfterRestart.statusCode, 429, 'redeem brute-force limit survived restart');
    assert.equal(redeemAfterRestart.json().error.code, 'rate_limited');

    // Expire windows in SQLite and verify cleanup + recovery.
    g.store.db.prepare('UPDATE platform_rate_limits SET expires_at = ?').run(Date.now() - 1);
    const recoveredLogin = await g.app.inject({
      method: 'POST',
      url: '/v1/portal/login',
      headers: { 'x-forwarded-for': '198.51.100.251' },
      payload: { email: 'persist@x.io', password: 'password-ok-1' },
    });
    assert.equal(recoveredLogin.statusCode, 200);
  } finally {
    await g.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('platform security: verificationWebhookUrl eliminates email_taken enumeration and delivers signed codes', async () => {
  const deliveries: VerificationDelivery[] = [];
  const originalDeliver = platformVerificationTransport.deliver;
  platformVerificationTransport.deliver = async (d) => {
    deliveries.push(d);
  };
  const secret = 'whsec_portal_verify_secret_0123456789';
  const s = await setup(undefined, {
    platform: {
      owner: 'owner',
      registration: 'open',
      signupCredits: 7,
      verificationWebhookUrl: 'https://verify.example.com/oaa-hook',
      verificationWebhookSecret: secret,
    },
  });
  try {
    // 1. New email signup returns 202 (never creates session before code verification).
    const first = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/signup',
      payload: { email: 'alice@example.com', password: 'password-1234', name: 'Alice' },
    });
    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().verification_required, true);
    await s.platform!.verification!.flush();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.event, 'portal.signup_verification');
    assert.ok(
      verifySignature(
        secret,
        deliveries[0]!.signature,
        deliveries[0]!.body,
        Math.floor(Date.now() / 1000),
      ),
      'HMAC signature verifies',
    );
    const signupPayload = JSON.parse(deliveries[0]!.body) as {
      data: { code: string; email: string };
    };
    assert.equal(signupPayload.data.email, 'alice@example.com');

    // Complete verification with the delivered code.
    const verified = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/signup/verify',
      payload: { email: 'alice@example.com', code: signupPayload.data.code },
    });
    assert.equal(verified.statusCode, 201, verified.body);
    assert.equal(verified.json().account.balance, 7);
    const oldSession = verified.json().session.token as string;

    // 2. Re-registering an already-taken email returns the EXACT same 202 body (no 409 email_taken!).
    const duplicate = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/signup',
      payload: { email: 'ALICE@example.com', password: 'another-password-99' },
    });
    assert.equal(duplicate.statusCode, 202);
    assert.equal(duplicate.body, first.body, 'identical wire body prevents email enumeration');
    await s.platform!.verification!.flush();
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1]!.event, 'portal.signup_existing_email');

    // 3. Self-service password reset request is uniform for known vs unknown emails.
    const resetKnown = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/password-reset/request',
      payload: { email: 'alice@example.com' },
    });
    const resetUnknown = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/password-reset/request',
      payload: { email: 'nobody@example.com' },
    });
    assert.equal(resetKnown.statusCode, 202);
    assert.equal(resetUnknown.statusCode, 202);
    assert.equal(resetKnown.body, resetUnknown.body);
    await s.platform!.verification!.flush();
    assert.equal(deliveries.length, 3, 'unknown email dispatches nothing');
    assert.equal(deliveries[2]!.event, 'portal.password_reset_code');
    const resetCode = (JSON.parse(deliveries[2]!.body) as { data: { code: string } }).data.code;

    const resetDone = await s.app.inject({
      method: 'POST',
      url: '/v1/portal/password-reset',
      payload: { email: 'alice@example.com', code: resetCode, new_password: 'reset-password-2026' },
    });
    assert.equal(resetDone.statusCode, 204);
    assert.equal(
      (
        await s.app.inject({
          method: 'GET',
          url: '/v1/portal/account',
          headers: { authorization: `Bearer ${oldSession}` },
        })
      ).statusCode,
      401,
      'prior session invalidated after reset',
    );
  } finally {
    platformVerificationTransport.deliver = originalDeliver;
    await s.cleanup();
  }
});

test('Prometheus /metrics: permission checks, 0.0.4 format, agent/status/token counters and P50/P95 latency', async () => {
  const s = await setup(
    new FixtureModel((_a, msgs) => {
      if ((msgs.at(-1)?.content ?? '').includes('explode')) throw new Error('boom');
      return { text: 'ok', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
    }),
  );
  try {
    const health = (await s.app.inject({ method: 'GET', url: '/health' })).json();
    assert.ok(health.features.includes('prometheus-metrics-v1'));
    assert.ok(health.features.includes('trace-context-v1'));

    assert.equal((await s.app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
    const invokeOnly = (
      await s.request('POST', '/v1/keys', { name: 'inv', agents: ['*'], scopes: ['invoke'] })
    ).json().token as string;
    assert.equal(
      (await s.request('GET', '/metrics', undefined, invokeOnly)).statusCode,
      403,
      'requires read scope',
    );

    s.store.publish('owner', makeBundle(agent({ id: 'agent/alpha' })));
    await s.request('POST', '/v1/responses', { model: 'agent/alpha', input: 'one' });
    await s.request('POST', '/v1/responses', { model: 'agent/alpha', input: 'two' });
    await s.request('POST', '/v1/responses', { model: 'agent/alpha', input: 'explode' });

    const res = await s.request('GET', '/metrics');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /^text\/plain; version=0\.0\.4/);
    const text = res.body;
    assert.match(text, /# TYPE oaa_gateway_queue_depth gauge/);
    assert.match(text, /oaa_active_runs 0/);
    assert.match(text, /oaa_online_nodes 1/);
    assert.match(text, /oaa_runs_total\{agent="agent\/alpha",status="completed"\} 2/);
    assert.match(text, /oaa_runs_total\{agent="agent\/alpha",status="failed"\} 1/);
    assert.match(text, /oaa_run_errors_total\{agent="agent\/alpha"\} 1/);
    assert.match(text, /oaa_run_tokens_total\{agent="agent\/alpha",status="completed"\} 40/);
    assert.match(text, /oaa_tokens_total 40/);
    assert.match(text, /oaa_activity_latency_milliseconds\{window="24h",quantile="0\.5"\} \d+/);
    assert.match(text, /oaa_activity_latency_milliseconds\{window="24h",quantile="0\.95"\} \d+/);
    assert.match(text, /oaa_activity_latency_samples\{window="24h"\} 3/);

    // Tenant isolation: another tenant sees 0 runs and 0 tokens.
    const other = await s.request('GET', '/metrics', undefined, secondToken);
    assert.match(other.body, /oaa_tokens_total 0/);
    assert.ok(!other.body.includes('agent/alpha'));
  } finally {
    await s.cleanup();
  }
});

test('W3C Trace Context: validation, parent->subagent propagation, node negotiation and zero SSE wire-byte drift', async () => {
  // Unit checks for W3C header grammar and bounds.
  assert.equal(
    parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    undefined,
  );
  assert.equal(
    parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
    undefined,
  );
  assert.equal(
    parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'),
    undefined,
  );
  assert.equal(
    parseTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'),
    undefined,
  );
  assert.equal(parseTracestate('x'.repeat(513)), undefined);
  const parsed = parseTraceHeaders({
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    tracestate: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
  })!;
  assert.equal(parsed.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(parsed.parentId, '00f067aa0ba902b7');
  assert.match(parsed.spanId, /^[0-9a-f]{16}$/);
  const sub = childTraceContext(parsed);
  assert.equal(sub.traceId, parsed.traceId);
  assert.equal(sub.parentId, parsed.spanId);
  assert.notEqual(sub.spanId, parsed.spanId);
  assert.match(formatTraceparent(sub), /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);

  // Full parent -> delegate sub-agent propagation + SSE byte-exact invariance.
  const observedWorkContexts: Record<string, unknown>[] = [];
  const s = await setup(
    new FixtureModel((def, msgs) => {
      if (def.id === 'agent/parent') {
        return msgs.some((m) => m.role === 'tool')
          ? { text: `parent:${msgs.at(-1)!.content}` }
          : { calls: [{ id: 'del1', name: 'ask_child', arguments: { task: 'sub-work' } }] };
      }
      if (def.id === 'agent/test') return { text: 'x'.repeat(2048) };
      return { text: 'child-ok' };
    }),
  );
  try {
    const origExecute = s.runtime.execute.bind(s.runtime);
    s.runtime.execute = async (work, signal, emit) => {
      observedWorkContexts.push(work.context as unknown as Record<string, unknown>);
      return origExecute(work, signal, emit);
    };

    s.store.publish('owner', makeBundle(agent({ id: 'agent/child' })));
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/parent',
          delegates: [
            {
              name: 'ask_child',
              agent: 'agent/child',
              description: 'Ask child',
              timeoutMs: 10_000,
              forwardFiles: false,
            },
          ],
        }),
      ),
    );
    s.store.publish('owner', makeBundle(agent()));

    const traceHeader = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parentRes = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/parent', input: 'start' },
      undefined,
      {
        traceparent: traceHeader,
        tracestate: 'vendor=oaa',
        'idempotency-key': 'idem-trace-1',
      },
    );
    assert.equal(parentRes.statusCode, 200, parentRes.body);
    const parentId = parentRes.json().id as string;

    // Retrying the same Idempotency-Key with a different traceparent span ID must NOT conflict!
    const retryRes = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/parent', input: 'start' },
      undefined,
      {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01',
        'idempotency-key': 'idem-trace-1',
      },
    );
    assert.equal(retryRes.statusCode, 200);
    assert.equal(retryRes.json().id, parentId);
    assert.equal('traceparent' in s.store.run(parentId).metadata, false, 'metadata stays clean');

    // Malformed traceparent is ignored rather than failing the call.
    const badHeaderRes = await s.request(
      'POST',
      '/v1/responses',
      { model: 'agent/child', input: 'hi' },
      undefined,
      { traceparent: 'malformed-header-value' },
    );
    assert.equal(badHeaderRes.statusCode, 200);

    // State, Run detail and Timeline echo `trace: { trace_id, parent_id, span_id }`, and child inherits trace_id.
    const stateView = (await s.request('GET', `/v1/runs/${parentId}/state`)).json();
    assert.equal(stateView.trace.trace_id, '4bf92f3577b34da6a3ce929d0e0e4736');
    assert.equal(stateView.trace.parent_id, '00f067aa0ba902b7');
    assert.equal(stateView.trace.tracestate, 'vendor=oaa');
    assert.match(stateView.trace.span_id, /^[0-9a-f]{16}$/);

    const tl = (await s.request('GET', `/v1/runs/${parentId}/timeline`)).json();
    assert.deepEqual(tl.trace, stateView.trace);
    const subSpan = tl.spans.find((sp: { kind: string }) => sp.kind === 'subagent');
    assert.ok(subSpan?.trace, 'subagent span carries child trace');
    assert.equal(subSpan.trace.trace_id, stateView.trace.trace_id);
    assert.equal(subSpan.trace.parent_id, stateView.trace.span_id);
    assert.notEqual(subSpan.trace.span_id, stateView.trace.span_id);

    const childRunId = String(subSpan.ref.child_run_id);
    const childDetail = (await s.request('GET', `/v1/runs/${childRunId}`)).json();
    assert.deepEqual(childDetail.trace, subSpan.trace);

    // WorkContext received the trace on the trace-context-v1-capable worker.
    assert.ok(
      observedWorkContexts.some(
        (ctx) =>
          (ctx.trace as { traceId?: string })?.traceId === '4bf92f3577b34da6a3ce929d0e0e4736',
      ),
    );

    // Exact compatibility stream wire bytes stay unchanged even WITH traceparent + tracestate!
    const chat = await s.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        traceparent: traceHeader,
        tracestate: 'vendor=oaa',
      },
      payload: JSON.stringify({
        model: 'agent/test',
        stream: true,
        messages: [{ role: 'user', content: 'stream test' }],
      }),
    });
    assert.equal(Buffer.byteLength(chat.body), 55_219);
  } finally {
    await s.cleanup();
  }
});

class FakeRemoteSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    setImmediate(() => this.emit('close'));
  }
  terminate() {
    this.close();
  }
}

test('remote node custom adapter/<name> ConversionProfile sync, legacy trace stripping and one-click node pairing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sec-obs-remote-'));
  const s = await setup();
  try {
    // 1. One-click node pairing via POST /v1/keys (scope: ['node']) + startup command builder.
    const mixed = await s.request('POST', '/v1/keys', {
      name: 'bad-node',
      agents: ['*'],
      scopes: ['node', 'invoke'],
    });
    assert.equal(mixed.statusCode, 400);

    const paired = await s.request('POST', '/v1/keys', {
      name: 'remote-gpu-1',
      agents: ['*'],
      capabilities: ['*'],
      scopes: ['node'],
    });
    assert.equal(paired.statusCode, 200, paired.body);
    const nodeKey = paired.json();
    assert.equal(nodeKey.node_id, 'remote-gpu-1');
    assert.match(String(nodeKey.token), /^oan_/);

    const regs = (await s.request('GET', '/v1/nodes/registrations')).json().data as {
      nodeId: string;
      source: string;
    }[];
    assert.ok(regs.some((r) => r.nodeId === 'remote-gpu-1' && r.source === 'enrolled'));

    const memStorage = () => {
      const map = new Map<string, string>();
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          map.set(k, v);
        },
        removeItem: (k: string) => {
          map.delete(k);
        },
      };
    };
    Object.assign(globalThis, {
      sessionStorage: memStorage(),
      localStorage: memStorage(),
      document: {
        documentElement: { lang: 'en', dataset: {} },
        querySelectorAll: () => [],
        getElementById: () => ({ addEventListener: () => {} }),
        addEventListener: () => {},
      },
      window: {
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        location: { origin: 'http://127.0.0.1:4242', hash: '' },
        addEventListener: () => {},
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      configurable: true,
    });
    const enrollUrl = new URL('../../web/dialogs/node-enroll.js', import.meta.url).href;
    const { buildRemoteWorkerCommand } = (await import(enrollUrl)) as {
      buildRemoteWorkerCommand: (params: {
        gatewayUrl: string;
        owner: string;
        nodeId: string;
        token: string;
      }) => string;
    };
    const cmd = buildRemoteWorkerCommand({
      gatewayUrl: 'https://gw.example.com',
      owner: 'owner',
      nodeId: nodeKey.node_id,
      token: nodeKey.token,
    });
    assert.match(cmd, /oaa node join --config/);
    assert.match(cmd, /https:\/\/gw\.example\.com/);
    assert.ok(cmd.includes(String(nodeKey.token)));
    assert.equal(cmd.includes('<<EOF'), false, 'must never emit an unquoted heredoc');

    // Shell-expansion & backslash safety check: $(...), $VAR, backticks, quotes and backslashes stay literal.
    const { execFileSync } = await import('node:child_process');
    const enrollHome = path.join(dir, 'enroll-home');
    await mkdir(enrollHome, { recursive: true });
    const pwnMarker = path.join(dir, 'pwned');
    const hostileUrl = `https://gw.example.com/sub$(touch ${pwnMarker})/$SECRET_VAR/\`id\`?q=a\\b"c'd`;
    const hostileOwner = `owner-$(touch ${pwnMarker})-'quoted'\\slash`;
    const hostileCmd = buildRemoteWorkerCommand({
      gatewayUrl: hostileUrl,
      owner: hostileOwner,
      nodeId: 'worker-safe-1',
      token: `oaa_node_tok'$(touch ${pwnMarker})\\end`,
    });
    const setupLines = hostileCmd.split('\n').slice(0, 3).join('\n');
    execFileSync('sh', ['-c', setupLines], {
      env: { ...process.env, HOME: enrollHome, SECRET_VAR: 'LEAKED' },
    });
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');
    assert.equal(existsSync(pwnMarker), false, 'command substitution must never execute');
    const writtenJson = JSON.parse(
      await readFile(path.join(enrollHome, '.oaa-workers', 'worker-safe-1', 'worker.json'), 'utf8'),
    ) as Record<string, string>;
    assert.equal(writtenJson.gatewayUrl, hostileUrl);
    assert.equal(writtenJson.owner, hostileOwner);
    const writtenToken = await readFile(
      path.join(enrollHome, '.oaa-workers', 'worker-safe-1', 'node.token'),
      'utf8',
    );
    assert.equal(writtenToken, `oaa_node_tok'$(touch ${pwnMarker})\\end`);

    // 2. Remote WorkerRuntime with a custom ACP adapter that does NOT exist on localWorker.
    const remoteWorkerCfg = workerSchema.parse({
      nodeId: 'remote-acp-box',
      owner: 'owner',
      dataDir: path.join(dir, 'remote-worker'),
      adapters: {
        'custom-remote': {
          transport: 'acp',
          command: process.execPath,
          args: ['-e', ''],
          enabled: true,
        },
      },
    });
    const remoteRuntime = new WorkerRuntime(remoteWorkerCfg);
    const fullAd = remoteRuntime.advertisement();
    assert.equal(fullAd.execution?.adapterProfiles?.['adapter/custom-remote']?.access, 'acp');

    // Negotiated advertisement includes adapterProfiles & traceContextVersion; unnegotiated omits both.
    const legacyExec = advertisedExecution(fullAd.execution, NO_NEGOTIATION);
    assert.equal(legacyExec?.adapterProfiles, undefined);
    assert.equal(legacyExec?.traceContextVersion, undefined);
    const modernExec = advertisedExecution(fullAd.execution, {
      ...NO_NEGOTIATION,
      adapterProfiles: true,
      traceContext: true,
    });
    assert.equal(modernExec?.traceContextVersion, 1);
    assert.equal(modernExec?.adapterProfiles?.['adapter/custom-remote']?.tier, 'interactive');

    // Attach remote executor via FakeRemoteSocket to NodeHub and publish the remote-only adapter agent.
    const sock = new FakeRemoteSocket();
    const remoteExec = new RemoteExecutor(
      sock as unknown as WebSocket,
      { ...fullAd, execution: modernExec },
      60_000,
      () => {},
    );
    s.hub.addLocal(
      {
        nodeId: 'remote-acp-box',
        owner: 'owner',
        token: 'local',
        agents: ['*'],
        capabilities: ['*'],
      },
      remoteExec,
    );
    const published = await s.request('POST', '/v1/agents/publish-native', {
      id: 'agent/custom-remote',
      engine: 'adapter/custom-remote',
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);

    const agentsRes = (await s.request('GET', '/v1/agents')).json().data as {
      id: string;
      conversion: { access: string; tier: string; transport: string };
    }[];
    const remoteAgent = agentsRes.find((a) => a.id === 'agent/custom-remote')!;
    assert.equal(remoteAgent.conversion.access, 'acp');
    assert.equal(remoteAgent.conversion.transport, 'acp-stdio');
    assert.equal(remoteAgent.conversion.tier, 'interactive');

    const overviewRes = (await s.request('GET', '/v1/overview')).json().agents as {
      id: string;
      conversion: { access: string };
    }[];
    assert.equal(overviewRes.find((a) => a.id === 'agent/custom-remote')?.conversion.access, 'acp');

    // Legacy RemoteExecutor (without traceContextVersion) strips `trace` and `subject` on the wire.
    const legacySock = new FakeRemoteSocket();
    const legacyRemote = new RemoteExecutor(
      legacySock as unknown as WebSocket,
      { ...fullAd, execution: legacyExec },
      60_000,
      () => {},
    );
    const p = legacyRemote.execute(
      {
        kind: 'native',
        agent: s.store.bundle('owner', 'agent/custom-remote').agent,
        input: 'hi',
        context: {
          runId: 'r1',
          sessionId: 's1',
          owner: 'owner',
          digest: 'd1',
          files: [],
          subject: 'key:1',
          trace: {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '00f067aa0ba902b7',
            flags: '01',
          },
        },
      },
      new AbortController().signal,
      async () => {},
    );
    const frame = legacySock.sent.at(-1) as { payload: { context: Record<string, unknown> } };
    assert.equal('trace' in frame.payload.context, false);
    assert.equal('subject' in frame.payload.context, false);
    legacySock.close();
    await assert.rejects(p);
    await remoteRuntime.close();
    await remoteExec.close();
  } finally {
    await s.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
