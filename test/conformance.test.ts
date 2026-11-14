/**
 * AgentAPI conversion conformance: every access method is driven through the real gateway
 * (app.inject, no listening port) with protocol-level fixture agents, and each value of its
 * advertised conversion profile is checked against what actually happens. No model, network or
 * real agent is used; remote agents (HTTP adapter, A2A) and the MCP bridge are answered
 * in-process through a stubbed fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpBridge } from '../src/client/mcp.js';
import { GatewayClient } from '../src/client/client.js';
import { runA2A } from '../src/engines/a2a.js';
import { runAdapter } from '../src/engines/adapter.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import { workerSchema } from '../src/config/config.js';
import { conversionProfile, type ConversionProfile } from '../src/engines/conformance.js';
import {
  capabilitySchema,
  type Run,
  type ToolBinding,
  type WorkEvent,
} from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import type { AcpTimings } from '../src/engines/acp.js';
import { Fault, sha, sleep } from '../src/core/util.js';
import { FixtureModel, agent, principal, setup, token, waitFor } from './helpers.js';

type Gateway = Awaited<ReturnType<typeof setup>>;
type Json = Record<string, any>;

const fixtures = {
  native: path.resolve('test/fixtures/native-full.mjs'),
  claude: path.resolve('test/fixtures/claude-code.mjs'),
  acp: path.resolve('test/fixtures/acp-agent.mjs'),
  adapter: path.resolve('test/fixtures/stream-adapter.mjs'),
};
const fast: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 1_000, exitGraceMs: 1_000 };
const SECRET = 'fixture-secret-value-123456';
const GATEWAY = 'http://127.0.0.1:9';
const markerOf = (text: string) => /MARKER:(\S+)/.exec(text)?.[1] ?? 'none';
const outputText = (run: Run) => run.output.map((m) => m.text).join('');
const deltasOf = (s: Gateway, runId: string) =>
  s.store
    .history(runId)
    .filter((e) => e.type === 'response.output_text.delta')
    .map((e) => String(e.data.delta));
const workspace = (s: Gateway, runId: string) =>
  path.join(
    s.runtime.config.dataDir,
    'sessions',
    sha('owner').slice(0, 16),
    s.store.run(runId).sessionId,
  );
const logged = (file: string, line: string) => async (s: Gateway, runId: string) =>
  (await readFile(path.join(workspace(s, runId), file), 'utf8').catch(() => '')).includes(line);
const streamed = (s: Gateway, runId: string) =>
  deltasOf(s, runId).some((d) => d.includes('working'));
const artifactNames = async (s: Gateway, runId: string) =>
  (await s.request('GET', `/v1/runs/${runId}/artifacts`))
    .json()
    .data.map((a: { filename: string }) => a.filename);
let protocolDoc: string | undefined;
const documented = async (code: string) =>
  (protocolDoc ??= await readFile(path.resolve('docs/protocol.md'), 'utf8')).includes(
    `\`${code}\``,
  );
const submit = (s: Gateway, id: string, input: string, previous?: string) =>
  s.kernel.submit(
    principal,
    invocationSchema.parse({
      agent: id,
      input,
      background: true,
      ...(previous ? { previous_response_id: previous } : {}),
    }),
  );
const execute = async (s: Gateway, id: string, input: string, previous?: string) =>
  s.kernel.wait(submit(s, id, input, previous).id);

// ---------------------------------------------------------------------------------------------
// In-process remote agents and the stubbed fetch that reaches them (and the gateway, for MCP).
// ---------------------------------------------------------------------------------------------
type Route = (url: URL, init: RequestInit) => Promise<Response> | Response;
function stubFetch(routes: Record<string, Route>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = routes[url.origin];
    if (!route) throw new Error(`conformance fixtures never use the network (${url.origin})`);
    return route(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const encoder = new TextEncoder();
/** SSE body of JSON-RPC frames; with `hold` it stays open until that signal aborts. */
const sse = (frames: unknown[], hold?: AbortSignal) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        if (!hold) return controller.close();
        if (hold.aborted) return controller.error(hold.reason);
        hold.addEventListener('abort', () => controller.error(hold.reason), { once: true });
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const untilAborted = (signal?: AbortSignal | null) =>
  new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

function remoteAgents() {
  const http = { started: false, requests: [] as Json[] };
  const a2a = { started: false, cancels: [] as string[], requests: [] as Json[], turns: new Map() };
  const routes: Record<string, Route> = {
    // An owner adapter speaking the oaa/1 ABI over HTTPS.
    'https://http-adapter.test': async (_url, init) => {
      const request = JSON.parse(String(init.body)) as Json;
      http.requests.push(request);
      const input = String(request.input);
      if (input.includes('MODE:hang')) {
        http.started = true;
        await untilAborted(init.signal);
      }
      if (input.includes('MODE:fail'))
        return json({
          protocol: 'oaa/1',
          type: 'result',
          status: 'failed',
          output_text: '',
          error: `fixture http failure token=${SECRET}`,
        });
      const turn = Number(request.previous_state?.turn ?? 0) + 1;
      return json({
        protocol: 'oaa/1',
        type: 'result',
        status: 'completed',
        output_text: `Adapter turn ${turn}: ${markerOf(input)}`,
        state: { turn },
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      });
    },
    // A remote A2A agent: JSON-RPC 2.0 binding, agent card, and both request generations.
    // A2A 1.0 requests (PascalCase methods, `A2A-Version: 1.0`) get 1.0 replies (members named
    // `statusUpdate` / `artifactUpdate` / `task`, `TASK_STATE_*`, parts without `kind`); 0.3
    // requests (`message/stream`, ...) get 0.3 replies (`kind` discriminators, `final`).
    'https://a2a.test': async (url, init) => {
      if ((init.method ?? 'GET') === 'GET')
        return url.pathname === '/.well-known/agent-card.json'
          ? json({
              name: 'a2a-fixture',
              version: '1.0.0',
              supportedInterfaces: [
                { url: 'https://a2a.test/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
                { url: 'https://a2a.test/rpc', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
              ],
              capabilities: { streaming: true },
              skills: [{ id: 'answer', name: 'Answer' }],
            })
          : json({ error: 'not found' }, 404);
      const rpc = JSON.parse(String(init.body)) as Json;
      const v1 = /^[A-Z]/.test(String(rpc.method));
      assert.equal(new Headers(init.headers).get('a2a-version'), v1 ? '1.0' : null);
      a2a.requests.push(rpc);
      const state = (name: string) =>
        v1 ? `TASK_STATE_${name.toUpperCase().replaceAll('-', '_')}` : name;
      const part = (text: string) => (v1 ? { text } : { kind: 'text', text });
      if (rpc.method === 'CancelTask' || rpc.method === 'tasks/cancel') {
        a2a.cancels.push(String(rpc.params.id));
        const task = { id: rpc.params.id, status: { state: state('canceled') } };
        return json({ jsonrpc: '2.0', id: rpc.id, result: v1 ? task : { kind: 'task', ...task } });
      }
      const message = rpc.params.message as Json;
      assert.equal(message.role, v1 ? 'ROLE_USER' : 'user');
      assert.equal(message.kind, v1 ? undefined : 'message');
      const text = (message.parts as Json[]).map((p) => String(p.text ?? '')).join('');
      const contextId = String(message.contextId ?? `ctx-${a2a.requests.length}`);
      const taskId = String(message.taskId ?? `task-${a2a.requests.length}`);
      const frames: unknown[] = [];
      const frame = (member: string, kind: string, value: Json) =>
        frames.push({
          jsonrpc: '2.0',
          id: rpc.id,
          result: v1 ? { [member]: value } : { kind, ...value },
        });
      const status = (name: string, final: boolean, said?: string) =>
        frame('statusUpdate', 'status-update', {
          taskId,
          contextId,
          ...(v1 ? {} : { final }),
          status: {
            state: state(name),
            ...(said
              ? {
                  message: {
                    ...(v1 ? {} : { kind: 'message' }),
                    role: v1 ? 'ROLE_AGENT' : 'agent',
                    messageId: `m-${frames.length}`,
                    parts: [part(said)],
                  },
                }
              : {}),
          },
        });
      frame('task', 'task', { id: taskId, contextId, status: { state: state('submitted') } });
      status('working', false, 'Looking things up');
      if (text.includes('MODE:hang')) {
        a2a.started = true;
        return sse(frames, init.signal ?? undefined);
      }
      if (text.includes('MODE:fail')) {
        status('failed', true, `fixture a2a failure token=${SECRET}`);
        return sse(frames);
      }
      if (text.includes('MODE:input') && !message.taskId) {
        status('input-required', true, 'Which file should I read?');
        return sse(frames);
      }
      const turn = (a2a.turns.get(contextId) ?? 0) + 1;
      a2a.turns.set(contextId, turn);
      const parts = [`A2A fixture turn ${turn}`, `: ${markerOf(text)}`];
      if (rpc.method === 'SendMessage' || rpc.method === 'message/send') {
        const task = {
          id: taskId,
          contextId,
          status: { state: state('completed') },
          artifacts: [{ artifactId: 'answer', parts: [part(parts.join(''))] }],
        };
        return json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: v1 ? { task } : { kind: 'task', ...task },
        });
      }
      for (const piece of parts)
        frame('artifactUpdate', 'artifact-update', {
          taskId,
          contextId,
          append: true,
          artifact: { artifactId: 'answer', parts: [part(piece)] },
        });
      status('completed', true);
      return sse(frames);
    },
  };
  return { http, a2a, routes };
}
/** Gateway requests from GatewayClient (MCP bridge), answered by app.inject. */
const injectRoute =
  (s: Gateway): Route =>
  async (url, init) => {
    const response = await s.app.inject({
      method: (init.method ?? 'GET') as never,
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body !== undefined && init.body !== null ? { payload: String(init.body) } : {}),
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers))
      if (value !== undefined)
        headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    return new Response(
      [204, 304].includes(response.statusCode) ? null : new Uint8Array(response.rawPayload),
      {
        status: response.statusCode,
        headers,
      },
    );
  };

// ---------------------------------------------------------------------------------------------
// The kernel's own fixture model (OAA's engine is held to the same contract).
// ---------------------------------------------------------------------------------------------
function kernelModel() {
  const state = { hanging: false, aborted: 0 };
  const model = new FixtureModel(async (_agent, messages, signal) => {
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const prompt = String(messages[lastUser]?.content ?? '');
    const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
    const turn = messages.filter((m) => m.role === 'user').length;
    // The same fault a real provider driver raises for an upstream error.
    if (prompt.includes('MODE:fail'))
      throw new Fault('upstream_failed', 'Fixture model failure.', 502);
    if (prompt.includes('MODE:hang')) {
      state.hanging = true;
      await sleep(60_000, signal).catch((error) => {
        state.aborted++;
        throw error;
      });
    }
    if (prompt.includes('MODE:approval'))
      return toolResults.length
        ? { text: 'Kernel approved and wrote.' }
        : { calls: [{ id: 'guard', name: 'guarded', arguments: {} }] };
    if (prompt.includes('MODE:artifact') && !toolResults.length)
      return {
        calls: [
          { id: 'w', name: 'write_file', arguments: { path: 'kernel.txt', content: 'artifact' } },
        ],
      };
    if (!toolResults.length) return { calls: [{ id: 'ls', name: 'list_files', arguments: {} }] };
    return { text: `Kernel fixture turn ${turn}: ${markerOf(prompt)}` };
  });
  return { model, state };
}

// ---------------------------------------------------------------------------------------------
// Access methods. Every behaviour is selected by a prompt marker, so one configured agent per
// access method exercises the whole contract.
// ---------------------------------------------------------------------------------------------
type Kernel = ReturnType<typeof kernelModel>;
type Remote = ReturnType<typeof remoteAgents>;
type Case = {
  name: string;
  access: ConversionProfile['access'];
  engine: string;
  install: (s: Gateway, k: Kernel, remote: Remote) => Promise<void> | void;
  answer: (turn: number, marker: string) => string;
  /** Exact error code for MODE:fail. */
  failure: string;
  approval?: { native?: string; approved: string; artifact?: string };
  artifact?: string;
  started: (s: Gateway, runId: string, k: Kernel, remote: Remote) => boolean | Promise<boolean>;
  /** Evidence that a cooperative cancel reached the agent. */
  acknowledged?: (
    s: Gateway,
    runId: string,
    k: Kernel,
    remote: Remote,
  ) => boolean | Promise<boolean>;
};
const native = (
  s: Gateway,
  engine: 'codex' | 'claude' | 'antigravity' | 'dsh',
  make: () => Json,
) => {
  s.config.localWorker!.native[engine] = make() as never;
  s.runtime.config.native[engine] = make() as never;
};
const adapter = (s: Gateway, name: string, make: () => Json) => {
  s.config.localWorker!.adapters[name] = make() as never;
  s.runtime.config.adapters[name] = make() as never;
};

const CASES: Case[] = [
  {
    name: 'kernel',
    access: 'kernel',
    engine: 'kernel',
    install: (s) => {
      const capability = capabilitySchema.parse({
        id: 'fixture/guarded',
        version: '1',
        description: 'Approval fixture',
        placement: 'host-bound',
        nodeId: 'local',
        effect: 'write',
        requiresApproval: true,
        inputSchema: { type: 'object' },
      });
      s.runtime.config.tools.push({
        reference: 'guarded',
        capability,
        handler: { kind: 'read_directory', root: s.dir },
      });
      s.runtime.handlers.set('guarded', async () => ({ value: 'written' }));
      const guarded: ToolBinding = {
        name: 'guarded',
        capability,
        handler: { kind: 'node', reference: 'guarded' },
      };
      s.store.publish(
        'owner',
        makeBundle(
          agent({
            id: 'agent/kernel',
            tools: [builtin('list_files'), builtin('write_file'), guarded],
          }),
        ),
      );
    },
    answer: (turn, marker) => `Kernel fixture turn ${turn}: ${marker}`,
    failure: 'upstream_failed',
    approval: { approved: 'Kernel approved and wrote.' },
    artifact: 'kernel.txt',
    started: (_s, _id, k) => k.state.hanging,
    acknowledged: (_s, _id, k) => k.state.aborted > 0,
  },
  {
    name: 'codex',
    access: 'native',
    engine: 'codex',
    install: (s) =>
      native(s, 'codex', () => ({
        executable: process.execPath,
        enabled: true,
        args: [fixtures.native],
      })),
    answer: (turn, marker) => `Codex fixture turn ${turn}: ${marker}`,
    failure: 'native_incomplete',
    approval: { native: 'codex', approved: 'Approved and written.', artifact: 'codex.txt' },
    artifact: 'codex.txt',
    started: streamed,
  },
  {
    name: 'claude',
    access: 'native',
    engine: 'claude',
    install: async (s) => {
      // The Agent SDK runs a `.mjs` CLI path with node; the copy is executable so the worker
      // advertises it like an installed binary.
      const cli = path.join(s.dir, 'claude-code.mjs');
      await copyFile(fixtures.claude, cli);
      await chmod(cli, 0o755);
      native(s, 'claude', () => ({ executable: cli, enabled: true, args: [] }));
    },
    answer: (turn, marker) => `Claude fixture turn ${turn}: ${marker}`,
    failure: 'native_incomplete',
    approval: {
      native: 'claude',
      approved: 'Permission granted; file written.',
      artifact: 'claude.txt',
    },
    artifact: 'claude-artifact.txt',
    started: streamed,
  },
  {
    name: 'antigravity',
    access: 'native',
    engine: 'antigravity',
    install: (s) =>
      native(s, 'antigravity', () => ({
        executable: process.execPath,
        enabled: true,
        args: [fixtures.native],
      })),
    answer: (turn, marker) => `Antigravity fixture turn ${turn}: ${marker}`,
    failure: 'native_incomplete',
    artifact: 'agy.txt',
    started: streamed,
  },
  {
    name: 'dsh',
    access: 'native',
    engine: 'dsh',
    install: async (s) => {
      // DSH is started as `<dsh> --profile headless ... -- <prompt>`, which node itself would
      // reject, so a generated launcher stands in for the installed binary.
      // Windows has no shebangs: a `.mjs` launcher is started through node by the product.
      const launcher = path.join(
        s.dir,
        process.platform === 'win32' ? 'dsh-fixture.mjs' : 'dsh-fixture',
      );
      await writeFile(
        launcher,
        `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixtures.native).href)});\n`,
      );
      await chmod(launcher, 0o755);
      native(s, 'dsh', () => ({ executable: launcher, enabled: true, args: [] }));
    },
    answer: (_turn, marker) => `DSH fixture final: ${marker}`,
    failure: 'process_failed',
    artifact: 'dsh.txt',
    started: logged('.dsh-fixture.log', 'started:'),
  },
  {
    name: 'acp',
    access: 'acp',
    engine: 'adapter/acp',
    install: (s) => {
      adapter(s, 'acp', () => ({
        transport: 'acp',
        command: process.execPath,
        args: [fixtures.acp, 'stream'],
        enabled: true,
      }));
      s.runtime.acpTimings = fast;
    },
    answer: (turn, marker) => `ACP fixture turn ${turn} (model default): ${marker}`,
    failure: 'native_protocol_error',
    approval: {
      native: 'acp',
      approved: 'Permission granted; file written.',
      artifact: 'approved.txt',
    },
    artifact: 'acp.txt',
    started: streamed,
    acknowledged: logged('.acp-fixture.log', 'cancel-acknowledged'),
  },
  {
    name: 'oaa-stdio',
    access: 'oaa-adapter',
    engine: 'adapter/legacy',
    install: (s) =>
      adapter(s, 'legacy', () => ({
        transport: 'stdio',
        command: process.execPath,
        args: [fixtures.adapter],
        enabled: true,
      })),
    answer: (turn, marker) => `Adapter turn ${turn}: ${marker}`,
    failure: 'adapter_incomplete',
    artifact: 'adapter.txt',
    started: logged('.stream-adapter.log', 'request:false'),
  },
  {
    name: 'oaa-stream',
    access: 'oaa-adapter',
    engine: 'adapter/stream',
    install: (s) =>
      adapter(s, 'stream', () => ({
        transport: 'stdio',
        protocol: 'oaa/1-stream',
        command: process.execPath,
        args: [fixtures.adapter],
        enabled: true,
      })),
    answer: (turn, marker) => `Adapter turn ${turn}: ${marker}`,
    failure: 'adapter_incomplete',
    approval: { native: 'adapter', approved: 'Approved and written.', artifact: 'stream.txt' },
    artifact: 'adapter.txt',
    started: streamed,
    acknowledged: logged('.stream-adapter.log', 'cancel'),
  },
  {
    name: 'oaa-http',
    access: 'oaa-adapter',
    engine: 'adapter/remote',
    install: (s) =>
      adapter(s, 'remote', () => ({
        transport: 'http',
        url: 'https://http-adapter.test/invoke',
        enabled: true,
      })),
    answer: (turn, marker) => `Adapter turn ${turn}: ${marker}`,
    failure: 'adapter_incomplete',
    started: (_s, _id, _k, remote) => remote.http.started,
  },
  {
    name: 'a2a',
    access: 'a2a',
    engine: 'adapter/peer',
    install: (s) =>
      adapter(s, 'peer', () => ({ transport: 'a2a', url: 'https://a2a.test/rpc', enabled: true })),
    answer: (turn, marker) => `A2A fixture turn ${turn}: ${marker}`,
    failure: 'adapter_incomplete',
    started: (_s, _id, _k, remote) => remote.a2a.started,
    acknowledged: (_s, _id, _k, remote) =>
      remote.a2a.cancels.length > 0 && remote.a2a.requests.some((r) => r.method === 'CancelTask'),
  },
];

for (const c of CASES)
  test(`conversion contract holds for ${c.name} (${c.engine})`, async () => {
    const k = kernelModel();
    const s = await setup(k.model, { approvalTimeoutMs: 30_000 });
    const remote = remoteAgents();
    const restore = stubFetch(remote.routes);
    try {
      await c.install(s, k, remote);
      const id = `agent/${c.name}`;
      if (c.engine !== 'kernel') {
        const published = await s.request('POST', '/v1/agents/publish-native', {
          id,
          engine: c.engine,
          models: ['default'],
        });
        assert.equal(published.statusCode, 200, published.body);
      }
      const profile = conversionProfile(c.engine, s.config.localWorker);
      assert.equal(profile.access, c.access);
      const listed = (await s.request('GET', '/v1/agents'))
        .json()
        .data.find((a: { id: string }) => a.id === id);
      assert.deepEqual(listed.conversion, profile, 'the catalog advertises the profile');

      // Basic: a turn through the oaa/1 endpoint returns the agent's answer.
      const invoked = await s.request('POST', '/v1/invoke', {
        protocol: 'oaa/1',
        agent: id,
        input: 'Answer MARKER:one',
      });
      assert.equal(invoked.statusCode, 200, invoked.body);
      assert.equal(invoked.json().status, 'completed', invoked.body);
      const first = s.store.run(invoked.json().id);
      assert.equal(outputText(first), c.answer(1, 'one'));

      // Streaming granularity: incremental paths stream several deltas; final-only paths
      // still reach every stream as exactly one delta.
      const deltas = deltasOf(s, first.id);
      assert.equal(deltas.join(''), outputText(first));
      if (profile.streaming === 'final') assert.equal(deltas.length, 1);
      else assert.ok(deltas.length >= 2, `expected incremental text, got ${deltas.length}`);

      // Tool visibility.
      const tools = s.store.history(first.id).filter((e) => e.type.startsWith('tool.'));
      if (profile.tool_events === 'none') assert.equal(tools.length, 0);
      else assert.ok(tools.length > 0, 'tool or status activity is visible');
      if (profile.tool_events === 'status')
        assert.ok(tools.every((e) => e.data.event === 'status'));

      // Usage.
      if (profile.usage === 'none') assert.equal(first.usage, null);
      else assert.ok((first.usage?.total_tokens ?? 0) > 0, 'usage is reported');

      // Resume: the agent's own session continues, or the continuation is refused honestly.
      const second = await execute(s, id, 'Continue MARKER:two', first.id);
      if (profile.resume === 'none') {
        assert.equal(second.status, 'failed');
        assert.equal(second.error?.code, 'native_resume_unsupported');
      } else {
        assert.equal(second.status, 'completed', JSON.stringify(second.error));
        assert.equal(outputText(second), c.answer(2, 'two'));
        if (profile.usage === 'partial')
          assert.equal(second.usage, null, 'session totals are not reported as turn usage');
      }

      // Mid-run approvals.
      if (profile.approvals === 'bridged') {
        for (const decision of ['approve', 'deny'] as const) {
          const run = submit(s, id, 'Write it MODE:approval');
          await waitFor(
            () => s.store.approvals(run.id).some((a) => a.status === 'pending'),
            15_000,
          );
          const approval = s.store.approvals(run.id).find((a) => a.status === 'pending')!;
          assert.equal(approval.kind, c.approval?.native ? 'native' : 'tool');
          if (c.approval?.native) assert.equal(approval.detail.native, c.approval.native);
          assert.equal(s.store.run(run.id).status, 'requires_action');
          const decided = await s.request('POST', `/v1/runs/${run.id}/actions/${approval.id}`, {
            decision,
          });
          assert.equal(decided.statusCode, 200, decided.body);
          const final = await s.kernel.wait(run.id);
          if (decision === 'approve') {
            assert.equal(final.status, 'completed', JSON.stringify(final.error));
            assert.equal(outputText(final), c.approval!.approved);
            if (c.approval!.artifact)
              assert.deepEqual(await artifactNames(s, run.id), [c.approval!.artifact]);
          } else {
            assert.equal(final.status, 'failed');
            assert.equal(final.error?.code, 'permission_denied');
            assert.deepEqual(await artifactNames(s, run.id), []);
          }
        }
      } else if (profile.approvals === 'denied') {
        const denied = await execute(s, id, 'Try MODE:denied');
        assert.equal(denied.status, 'failed');
        assert.equal(denied.error?.code, 'permission_denied');
        assert.equal(s.store.approvals(denied.id).length, 0, 'nothing reaches the owner');
      }

      // Artifacts: files under outputs/ are exported only where the agent shares a workspace.
      const saved = await execute(s, id, 'Save MODE:artifact MARKER:three');
      assert.equal(saved.status, 'completed', JSON.stringify(saved.error));
      assert.deepEqual(await artifactNames(s, saved.id), profile.artifacts ? [c.artifact] : []);

      // Cancellation (before the failure case: a failing provider cools its route down).
      const hang = submit(s, id, 'Wait MODE:hang');
      await waitFor(() => c.started(s, hang.id, k, remote), 15_000);
      const cancelled = await s.request('POST', `/v1/responses/${hang.id}/cancel`);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      const stopped = await s.kernel.wait(hang.id);
      if (c.engine === 'kernel') assert.equal(stopped.status, 'cancelled');
      else {
        // A started agent turn may already have had effects: reported as interrupted.
        assert.equal(stopped.status, 'interrupted');
        assert.equal(stopped.error?.code, 'effect_outcome_unknown');
      }
      if (profile.cancel === 'cooperative')
        await waitFor(() => c.acknowledged!(s, hang.id, k, remote), 10_000);
      // Failures carry a stable, documented code and never leak credentials.
      const failed = await execute(s, id, 'Break MODE:fail');
      assert.equal(failed.status, 'failed');
      const code = String(failed.error?.code ?? '');
      assert.equal(code, c.failure);
      assert.ok(await documented(code), `${code} is documented in docs/protocol.md`);
      assert.ok(!JSON.stringify(failed.error).includes(SECRET), 'credentials are redacted');

      assert.equal(s.driver.calls > 0, c.engine === 'kernel', 'only the kernel calls a model');
    } finally {
      restore();
      await s.cleanup();
    }
  });

// ---------------------------------------------------------------------------------------------
// Protocol matrix: one conversion, every dialect.
// ---------------------------------------------------------------------------------------------
const sseBlocks = (body: string) =>
  body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n'),
    }));
const sseJson = (body: string) =>
  sseBlocks(body)
    .filter((b) => b.data && b.data !== '[DONE]')
    .map((b): Json => ({ event: b.event, ...(JSON.parse(b.data) as Json) }));

async function mcpClient(s: Gateway) {
  const bridge = createMcpBridge(new GatewayClient(GATEWAY, token));
  const client = new Client({ name: 'conformance', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Json) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0]!.text) as Json;
  };
  return {
    client,
    call,
    close: async () => {
      await client.close();
      await bridge.close();
    },
  };
}
const installAdapters = (s: Gateway) => {
  adapter(s, 'stream', () => ({
    transport: 'stdio',
    protocol: 'oaa/1-stream',
    command: process.execPath,
    args: [fixtures.adapter],
    enabled: true,
  }));
  adapter(s, 'legacy', () => ({
    transport: 'stdio',
    command: process.execPath,
    args: [fixtures.adapter],
    enabled: true,
  }));
};
async function publishAdapters(s: Gateway) {
  for (const [id, engine] of [
    ['agent/stream', 'adapter/stream'],
    ['agent/legacy', 'adapter/legacy'],
  ]) {
    const published = await s.request('POST', '/v1/agents/publish-native', {
      id,
      engine,
      models: ['default'],
    });
    assert.equal(published.statusCode, 200, published.body);
  }
}

test('protocol matrix: every dialect and MCP render the same conversion, streamed or final-only', async () => {
  const s = await setup();
  const restore = stubFetch({ [new URL(GATEWAY).origin]: injectRoute(s) });
  const mcp = await mcpClient(s);
  try {
    installAdapters(s);
    await publishAdapters(s);
    for (const [id, incremental] of [
      ['agent/stream', true],
      ['agent/legacy', false],
    ] as const) {
      const expected = 'Adapter turn 1: p';
      const input = 'Answer MARKER:p';
      const post = (url: string, body: Json) => s.request('POST', url, body);
      const ok = <T extends { statusCode: number; body: string }>(r: T): T => {
        assert.equal(r.statusCode, 200, r.body);
        return r;
      };
      // Non-streaming dialects.
      assert.equal(
        ok(await post('/v1/invoke', { protocol: 'oaa/1', agent: id, input })).json().output[0]
          .content[0].text,
        expected,
      );
      assert.equal(
        ok(await post('/v1/responses', { model: id, input })).json().output[0].content[0].text,
        expected,
      );
      assert.equal(
        ok(
          await post('/v1/chat/completions', {
            model: id,
            messages: [{ role: 'user', content: input }],
          }),
        ).json().choices[0].message.content,
        expected,
      );
      assert.equal(
        ok(
          await post('/v1/messages', {
            model: id,
            max_tokens: 256,
            messages: [{ role: 'user', content: input }],
          }),
        ).json().content[0].text,
        expected,
      );
      assert.equal(
        ok(
          await post(`/v1beta/models/${id}:generateContent`, {
            contents: [{ role: 'user', parts: [{ text: input }] }],
          }),
        ).json().candidates[0].content.parts[0].text,
        expected,
      );
      assert.equal(
        ok(await post('/v1/uap', { uap: '1.0', target: id, input })).json().output.text,
        expected,
      );

      // Streaming dialects: the deltas add up to the same answer and each stream terminates.
      const pieces = (texts: string[]) => {
        assert.equal(texts.join(''), expected);
        assert.equal(texts.length, incremental ? 2 : 1);
      };
      const responses = sseJson(
        ok(await post('/v1/responses', { model: id, input, stream: true })).body,
      );
      pieces(responses.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta));
      assert.equal(responses.at(-1)!.type, 'response.completed');
      const chatBody = ok(
        await post('/v1/chat/completions', {
          model: id,
          stream: true,
          messages: [{ role: 'user', content: input }],
        }),
      ).body;
      pieces(
        sseJson(chatBody)
          .map((e) => e.choices?.[0]?.delta?.content)
          .filter((t): t is string => typeof t === 'string' && t !== ''),
      );
      assert.ok(chatBody.trimEnd().endsWith('data: [DONE]'));
      const claude = sseJson(
        ok(
          await post('/v1/messages', {
            model: id,
            max_tokens: 256,
            stream: true,
            messages: [{ role: 'user', content: input }],
          }),
        ).body,
      );
      pieces(claude.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text));
      assert.equal(claude.at(-1)!.type, 'message_stop');
      const gemini = sseJson(
        ok(
          await post(`/v1beta/models/${id}:streamGenerateContent?alt=sse`, {
            contents: [{ role: 'user', parts: [{ text: input }] }],
          }),
        ).body,
      );
      pieces(
        gemini
          .filter((e) => !e.candidates?.[0]?.content?.parts?.[0]?.thought)
          .map((e) => e.candidates?.[0]?.content?.parts?.[0]?.text)
          .filter((t): t is string => typeof t === 'string'),
      );
      assert.equal(gemini.at(-1)!.candidates[0].finishReason, 'STOP');
      const uap = ok(
        await post('/v1/uap', {
          uap: '1.0',
          target: id,
          input,
          delivery: { stream: true, format: 'uap-ndjson' },
        }),
      )
        .body.trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Json);
      pieces(uap.filter((f) => f.t === 'delta').map((f) => f.d));
      assert.equal(uap.at(-1)!.t, 'done');
      assert.equal(uap.at(-1)!.status, 'completed');
      // Tool activity is visible to UAP (step frames) only where the access method reports it.
      assert.equal(
        uap.some((f) => f.t === 'step'),
        incremental,
      );

      // MCP: invoke, wait and read through the bridge (same runs, same authorization).
      const receipt = await mcp.call('oaa_invoke', { agent: id, input });
      const waited = await mcp.call('oaa_wait_run', { response_id: receipt.id });
      assert.equal(waited.status, 'completed');
      assert.equal(waited.output.preview, expected);

      // Continuation: stateful dialects resume the adapter's own state ...
      const firstId = String(
        (await post('/v1/invoke', { protocol: 'oaa/1', agent: id, input })).json().id,
      );
      const resumed = [
        (
          await post('/v1/invoke', {
            protocol: 'oaa/1',
            agent: id,
            input: 'MARKER:q',
            previous_response_id: firstId,
          })
        ).json().output[0].content[0].text,
        (
          await post('/v1/responses', {
            model: id,
            input: 'MARKER:q',
            previous_response_id: firstId,
          })
        ).json().output[0].content[0].text,
        (
          await post('/v1/uap', {
            uap: '1.0',
            target: id,
            input: 'MARKER:q',
            session: { previous_id: firstId },
          })
        ).json().output.text,
      ];
      const viaMcp = await mcp.call('oaa_invoke', {
        agent: id,
        input: 'MARKER:q',
        previous_response_id: firstId,
      });
      resumed.push((await mcp.call('oaa_wait_run', { response_id: viaMcp.id })).output.preview);
      assert.deepEqual(resumed, Array(4).fill('Adapter turn 2: q'));
      // ... while Chat, Claude and Gemini are stateless: history is flattened into one new turn.
      const chat = ok(
        await post('/v1/chat/completions', {
          model: id,
          messages: [
            { role: 'user', content: input },
            { role: 'assistant', content: expected },
            { role: 'user', content: 'MARKER:q' },
          ],
        }),
      );
      assert.match(chat.json().choices[0].message.content, /^Adapter turn 1: /);
      const flattened = s.store.run(String(chat.headers['x-run-id']));
      assert.equal(flattened.previousId, null);
      assert.ok(flattened.input.includes('MARKER:p') && flattened.input.includes('MARKER:q'));
    }
  } finally {
    await mcp.close();
    restore();
    await s.cleanup();
  }
});

test('approval rendering: each dialect reports a pending owner decision its own way, and the run continues', async () => {
  const s = await setup(undefined, { approvalTimeoutMs: 30_000 });
  const restore = stubFetch({ [new URL(GATEWAY).origin]: injectRoute(s) });
  const mcp = await mcpClient(s);
  try {
    installAdapters(s);
    await publishAdapters(s);
    const id = 'agent/stream';
    const input = 'Write it MODE:approval';
    const pending = async (runId: () => string | undefined) => {
      await waitFor(() => {
        const current = runId();
        return !!current && s.store.approvals(current).some((a) => a.status === 'pending');
      }, 15_000);
      return runId()!;
    };
    const approve = async (runId: string) => {
      const action = s.store.approvals(runId).find((a) => a.status === 'pending')!;
      const decided = await s.request('POST', `/v1/runs/${runId}/actions/${action.id}`, {
        decision: 'approve',
      });
      assert.equal(decided.statusCode, 200, decided.body);
      const final = await s.kernel.wait(runId);
      assert.equal(final.status, 'completed', JSON.stringify(final.error));
      assert.equal(outputText(final), 'Approved and written.');
    };

    // Non-streaming dialects return as soon as the owner must decide.
    const sync: [
      string,
      Json,
      (r: { statusCode: number; headers: Record<string, unknown>; json: () => Json }) => void,
    ][] = [
      [
        '/v1/responses',
        { model: id, input },
        (r) => {
          assert.equal(r.statusCode, 200);
          assert.equal(r.json().status, 'in_progress');
          assert.equal(r.json().metadata['oaa.status'], 'requires_action');
        },
      ],
      [
        '/v1/uap',
        { uap: '1.0', target: id, input },
        (r) => {
          assert.equal(r.statusCode, 200);
          assert.equal(r.json().status, 'requires_action');
        },
      ],
      [
        '/v1/chat/completions',
        { model: id, messages: [{ role: 'user', content: input }] },
        // 运行已创建，422 + x-should-retry: false（不是 SDK 会重试的 409）。
        (r) => {
          assert.equal(r.statusCode, 422);
          assert.equal(r.headers['x-should-retry'], 'false');
          assert.equal(r.json().error.code, 'action_required');
        },
      ],
      [
        '/v1/messages',
        { model: id, max_tokens: 64, messages: [{ role: 'user', content: input }] },
        (r) => {
          assert.equal(r.statusCode, 422);
          assert.equal(r.headers['x-should-retry'], 'false');
          assert.equal(r.json().error.code, 'action_required');
        },
      ],
      [
        `/v1beta/models/${id}:generateContent`,
        { contents: [{ role: 'user', parts: [{ text: input }] }] },
        (r) => {
          assert.equal(r.statusCode, 422);
          assert.equal(r.headers['x-should-retry'], 'false');
          assert.equal(r.json().error.details[0].reason, 'action_required');
        },
      ],
    ];
    for (const [url, body, check] of sync) {
      const response = await s.request('POST', url, body);
      check(response);
      await approve(await pending(() => String(response.headers['x-run-id'])));
    }

    // Stateless streams end with their dialect's error frame; UAP ends with an action frame.
    const streams: [string, Json, (body: string) => void][] = [
      [
        '/v1/chat/completions',
        { model: id, stream: true, messages: [{ role: 'user', content: input }] },
        (body) => assert.equal(sseJson(body).at(-1)!.error.code, 'action_required'),
      ],
      [
        '/v1/messages',
        { model: id, max_tokens: 64, stream: true, messages: [{ role: 'user', content: input }] },
        (body) => assert.equal(sseJson(body).at(-1)!.type, 'error'),
      ],
      [
        `/v1beta/models/${id}:streamGenerateContent?alt=sse`,
        { contents: [{ role: 'user', parts: [{ text: input }] }] },
        // 带出真实的错误码；待审批是 FAILED_PRECONDITION（旧值 ABORTED）。
        (body) => {
          const last = sseJson(body).at(-1)!;
          assert.equal(last.error.status, 'FAILED_PRECONDITION');
          assert.equal(last.error.details[0].reason, 'action_required');
        },
      ],
      [
        '/v1/uap',
        { uap: '1.0', target: id, input, delivery: { stream: true, format: 'uap-ndjson' } },
        (body) => {
          const last = JSON.parse(body.trim().split('\n').at(-1)!) as Json;
          assert.equal(last.t, 'action');
          assert.equal(last.data.approval.kind, 'native');
        },
      ],
    ];
    for (const [url, body, check] of streams) {
      const response = await s.request('POST', url, body);
      assert.equal(response.statusCode, 200, response.body);
      check(response.body);
      await approve(await pending(() => String(response.headers['x-run-id'])));
    }

    // A Responses stream stays open across the decision and reports the pending state.
    const known = new Set(s.store.allRuns().map((r) => r.id));
    const open = s.request('POST', '/v1/responses', { model: id, input, stream: true });
    const runId = await pending(() => s.store.allRuns().find((r) => !known.has(r.id))?.id);
    await approve(runId);
    const events = sseJson((await open).body);
    const waiting = events.find(
      (e) =>
        e.type === 'response.in_progress' &&
        e.response.metadata['oaa.status'] === 'requires_action',
    );
    assert.ok(waiting, 'the pending decision is visible in the Responses stream');
    assert.equal(events.at(-1)!.type, 'response.completed');

    // MCP clients see the pending decision but cannot make it: owner decisions stay human.
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((name) => /approve|decide|action/.test(name)), tools.join(','));
    const receipt = await mcp.call('oaa_invoke', { agent: id, input });
    const blocked = await mcp.call('oaa_wait_run', { response_id: receipt.id });
    assert.equal(blocked.status, 'requires_action');
    assert.equal(blocked.pending_actions.length, 1);
    await approve(String(receipt.id));
    assert.equal((await mcp.call('oaa_wait_run', { response_id: receipt.id })).status, 'completed');
  } finally {
    await mcp.close();
    restore();
    await s.cleanup();
  }
});

test('cancellation is protocol-neutral: the run id from any dialect cancels it, including via MCP', async () => {
  const s = await setup();
  const restore = stubFetch({ [new URL(GATEWAY).origin]: injectRoute(s) });
  const mcp = await mcpClient(s);
  try {
    installAdapters(s);
    await publishAdapters(s);
    const started = async (runId: string) =>
      waitFor(() => deltasOf(s, runId).some((d) => d.includes('working')), 15_000);
    const background = await s.request('POST', '/v1/responses', {
      model: 'agent/stream',
      input: 'Wait MODE:hang',
      background: true,
    });
    const viaHttp = String(background.json().id);
    await started(viaHttp);
    assert.equal((await s.request('POST', `/v1/responses/${viaHttp}/cancel`)).statusCode, 200);
    const receipt = await mcp.call('oaa_invoke', {
      agent: 'agent/stream',
      input: 'Wait MODE:hang',
    });
    await started(String(receipt.id));
    await mcp.call('oaa_cancel', { response_id: receipt.id });
    for (const runId of [viaHttp, String(receipt.id)]) {
      const final = await s.kernel.wait(runId);
      assert.equal(final.status, 'interrupted');
      await waitFor(() => logged('.stream-adapter.log', 'cancel')(s, runId), 10_000);
    }
  } finally {
    await mcp.close();
    restore();
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Transport details that the matrix does not reach.
// ---------------------------------------------------------------------------------------------
const recorder = (answer?: (data: Json) => Json | void) => {
  const events: WorkEvent[] = [];
  return {
    events,
    emit: async (event: WorkEvent) => {
      events.push(event);
      if (event.type === 'approval') return answer?.(event.data);
    },
  };
};
const a2aWorker = (extra: Json = {}) =>
  workerSchema.parse({
    nodeId: 'local',
    dataDir: '/nonexistent',
    adapters: { peer: { transport: 'a2a', url: 'https://a2a.test/rpc', enabled: true, ...extra } },
  });
const a2aAgent = agent({ engine: 'adapter/peer', model: 'default', instructions: '' });

test('A2A: 1.0 and 0.3 request forms, input-required continuation, auth and protocol failures', async () => {
  const remote = remoteAgents();
  const restore = stubFetch(remote.routes);
  const signal = () => AbortSignal.timeout(5_000);
  try {
    const sent = await runA2A(
      a2aAgent,
      a2aWorker({ streaming: false }),
      'MARKER:x',
      signal(),
      recorder().emit,
    );
    assert.equal(sent.text, 'A2A fixture turn 1: x');
    assert.equal(sent.nativeState.protocolVersion, '1.0');
    assert.equal(remote.a2a.requests.at(-1)!.method, 'SendMessage');
    assert.deepEqual(remote.a2a.requests.at(-1)!.params.message.parts, [{ text: 'MARKER:x' }]);
    assert.deepEqual(remote.a2a.requests.at(-1)!.params.configuration, {
      acceptedOutputModes: ['text/plain', 'text/markdown'],
    });
    // 0.3 servers: the same turn in the older request forms (`message/*`, `kind`, `blocking`).
    for (const streaming of [true, false]) {
      const legacy = await runA2A(
        a2aAgent,
        a2aWorker({ protocolVersion: '0.3', streaming }),
        'MARKER:y',
        signal(),
        recorder().emit,
      );
      assert.equal(legacy.text, 'A2A fixture turn 1: y');
      const request = remote.a2a.requests.at(-1)!;
      assert.equal(request.method, streaming ? 'message/stream' : 'message/send');
      assert.deepEqual(request.params.message.parts, [{ kind: 'text', text: 'MARKER:y' }]);
      assert.equal(request.params.configuration.blocking, true);
    }

    // The agent asks a question: the turn ends with it, and the reply continues the same task.
    const asked = await runA2A(a2aAgent, a2aWorker(), 'Read MODE:input', signal(), recorder().emit);
    assert.equal(asked.text, 'Which file should I read?');
    assert.equal(asked.nativeState.state, 'input-required');
    const answered = await runA2A(
      a2aAgent,
      a2aWorker(),
      'notes.txt MODE:input',
      signal(),
      recorder().emit,
      asked.nativeState,
    );
    const continued = remote.a2a.requests.at(-1)!.params.message;
    assert.equal(continued.taskId, asked.nativeState.taskId);
    assert.equal(continued.contextId, asked.nativeState.contextId);
    assert.equal(answered.nativeState.state, 'completed');

    const failing = (status: number, body: string, type = 'application/json') =>
      stubFetch({
        'https://a2a.test': () => new Response(body, { status, headers: { 'content-type': type } }),
      });
    for (const [status, body, type, expected] of [
      [401, '{}', 'application/json', 'adapter_auth_required'],
      [500, '{}', 'application/json', 'adapter_failed'],
      [200, 'not json', 'application/json', 'invalid_protocol'],
      [200, 'data: not json\n\n', 'text/event-stream', 'invalid_protocol'],
      [
        200,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', status: { state: 'working' } } })}\n\n`,
        'text/event-stream',
        'native_incomplete',
      ],
      [
        200,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', final: true, status: { state: 'working' } } })}\n\n`,
        'text/event-stream',
        'native_incomplete',
      ],
      [
        200,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32001, message: `no task token=${SECRET}` },
        }),
        'application/json',
        'adapter_failed',
      ],
      // 1.0 shapes: no terminal state before the stream closes; a failed task; unknown result.
      [
        200,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { statusUpdate: { status: { state: 'TASK_STATE_WORKING' } } } })}\n\n`,
        'text/event-stream',
        'native_incomplete',
      ],
      [
        200,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { statusUpdate: { status: { state: 'TASK_STATE_FAILED', message: { role: 'ROLE_AGENT', parts: [{ text: `bad token=${SECRET}` }] } } } } })}\n\n`,
        'text/event-stream',
        'adapter_incomplete',
      ],
      [
        200,
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { foo: 1 } }),
        'application/json',
        'invalid_protocol',
      ],
    ] as const) {
      const undo = failing(status, body, type);
      try {
        await assert.rejects(
          runA2A(a2aAgent, a2aWorker(), 'task', signal(), recorder().emit),
          (error: unknown) =>
            error instanceof Fault && error.code === expected && !error.message.includes(SECRET),
        );
      } finally {
        undo();
      }
    }
    // A configured credential that is missing fails before any request is made.
    const requests = remote.a2a.requests.length;
    await assert.rejects(
      runA2A(
        a2aAgent,
        a2aWorker({ tokenEnv: 'OAA_CONFORMANCE_MISSING_TOKEN' }),
        'task',
        signal(),
        recorder().emit,
      ),
      (error: unknown) => error instanceof Fault && error.code === 'adapter_not_configured',
    );
    assert.equal(remote.a2a.requests.length, requests);
    // Plain-text HTTP is refused for remote agents.
    await assert.rejects(
      runA2A(
        a2aAgent,
        a2aWorker({ url: 'http://a2a.test/rpc' }),
        'task',
        signal(),
        recorder().emit,
      ),
      (error: unknown) => error instanceof Fault && error.code === 'insecure_endpoint',
    );
  } finally {
    restore();
  }
});

test('A2A agent card check reads the well-known card only and refines the profile', async () => {
  const s = await setup();
  const remote = remoteAgents();
  const restore = stubFetch(remote.routes);
  try {
    adapter(s, 'peer', () => ({ transport: 'a2a', url: 'https://a2a.test/rpc', enabled: false }));
    const check = await s.request('POST', '/v1/local/backends/adapter%2Fpeer/check');
    assert.equal(check.statusCode, 200, check.body);
    assert.equal(check.json().status, 'passed');
    assert.equal(check.json().card_path, '/.well-known/agent-card.json');
    assert.deepEqual(check.json().agent, { name: 'a2a-fixture', version: '1.0.0' });
    assert.deepEqual(check.json().protocol_versions, ['1.0', '0.3']);
    assert.deepEqual(check.json().bindings, ['JSONRPC']);
    assert.equal(check.json().streaming, true);
    assert.equal(check.json().model_called, false);
    assert.equal(remote.a2a.requests.length, 0, 'no message or task was sent');
    const row = (await s.request('GET', '/v1/local/backends'))
      .json()
      .data.find((b: { engine: string }) => b.engine === 'adapter/peer');
    assert.equal(row.evidence, 'handshake_passed');
    assert.equal(row.enabled, false);
    assert.equal(row.conversion.access, 'a2a');
  } finally {
    restore();
    await s.cleanup();
  }
});

test('oaa/1-stream rejects unknown messages and denies approvals it cannot route', async () => {
  const s = await setup();
  try {
    const script = path.join(s.dir, 'odd-adapter.mjs');
    await writeFile(
      script,
      `process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'telemetry' }) + '\\n'));\n`,
    );
    const config = (args: string[]) =>
      workerSchema.parse({
        nodeId: 'local',
        dataDir: s.dir,
        adapters: {
          x: {
            transport: 'stdio',
            protocol: 'oaa/1-stream',
            command: process.execPath,
            args,
            enabled: true,
          },
        },
      });
    const context = {
      runId: 'resp_x',
      sessionId: 'sess_x',
      owner: 'owner',
      digest: 'd',
      files: [],
    } as never;
    const definition = agent({ engine: 'adapter/x', model: 'default' });
    await assert.rejects(
      runAdapter(
        definition,
        config([script]),
        s.dir,
        'task',
        context,
        AbortSignal.timeout(5_000),
        undefined,
        recorder().emit,
      ),
      (error: unknown) => error instanceof Fault && error.code === 'invalid_protocol',
    );
    // Without an approval route (no emit) the request is denied, and denial fails the turn.
    await assert.rejects(
      runAdapter(
        definition,
        config([fixtures.adapter]),
        s.dir,
        'MODE:approval',
        context,
        AbortSignal.timeout(5_000),
      ),
      (error: unknown) => error instanceof Fault && error.code === 'permission_denied',
    );
    assert.match(await readFile(path.join(s.dir, '.stream-adapter.log'), 'utf8'), /approval:deny/);
  } finally {
    await s.cleanup();
  }
});

test('conversion profiles: handshake evidence refines ACP resume; catalog surfaces carry the profile', async () => {
  const worker = workerSchema.parse({
    nodeId: 'local',
    dataDir: '/nonexistent',
    adapters: {
      acp: { transport: 'acp', command: 'x', args: [], enabled: true },
      peer: { transport: 'a2a', url: 'https://a2a.test/rpc', enabled: true, streaming: false },
    },
  });
  assert.equal(conversionProfile('adapter/acp', worker).resume, 'agent-declared');
  assert.equal(
    conversionProfile('adapter/acp', worker, { load_session: false, resume_session: true }).resume,
    'native',
  );
  assert.equal(
    conversionProfile('adapter/acp', worker, { load_session: false, resume_session: false }).resume,
    'none',
  );
  assert.equal(conversionProfile('adapter/peer', worker).streaming, 'final');
  assert.equal(conversionProfile('adapter/peer', worker).tier, 'basic');
  assert.equal(conversionProfile('adapter/elsewhere', worker).access, 'unknown');
  assert.deepEqual(
    ['kernel', 'codex', 'claude', 'antigravity', 'dsh'].map((e) => conversionProfile(e).tier),
    ['interactive', 'interactive', 'interactive', 'streaming', 'basic'],
  );

  const s = await setup();
  try {
    installAdapters(s);
    await publishAdapters(s);
    const inspected = (
      await s.request('GET', '/v1/catalog/agent?agent=agent%2Fstream&section=overview')
    ).json();
    assert.deepEqual(
      inspected.data[0].conversion,
      conversionProfile('adapter/stream', s.config.localWorker),
    );
    const overview = (await s.request('GET', '/v1/overview')).json();
    assert.equal(
      overview.agents.find((a: { id: string }) => a.id === 'agent/legacy').conversion.transport,
      'oaa/1',
    );
    const backends = (await s.request('GET', '/v1/local/backends')).json();
    assert.ok(backends.data.every((b: { conversion?: Json }) => b.conversion?.access));
    assert.ok(backends.presets.every((p: { conversion?: Json }) => p.conversion?.access));
  } finally {
    await s.cleanup();
  }
});
