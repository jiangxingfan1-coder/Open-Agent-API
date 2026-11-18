import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  claudeCallerMcpServers,
  codexCallerArgs,
  codexCallerTool,
  codexDecisionPayload,
  codexReasoningArgs,
  isClaudeCallerTool,
  isCodexCallerTool,
} from '../src/engines/native-bridge.js';
import { codex } from '../src/engines/codex.js';
import { runNative } from '../src/engines/native.js';
import { runAcp, type AcpTimings } from '../src/engines/acp.js';
import { REASONING_ONLY } from '../src/engines/reasoning-policy.js';
import { workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { makeBundle } from '../src/lang/bundle.js';
import type { ClientTool, WorkEvent } from '../src/core/contracts.js';
import { Fault, sha } from '../src/core/util.js';
import { agent, setup, token, waitFor } from './helpers.js';

// 原生引擎（Claude Code、Codex）与 ACP 的双层 Harness 桥接、流式、优雅中断及无工具纯推理测试。
// 全程使用本机假进程与 Unix 域套接字 / 命名管道，不打开任何网络端口。

type Gateway = Awaited<ReturnType<typeof setup>>;

const MCP_CLIENT_URL = import.meta.resolve('@modelcontextprotocol/sdk/client/index.js');
const MCP_STDIO_URL = import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js');
const FAST_ACP: AcpTimings = { handshakeTimeoutMs: 5_000, cancelGraceMs: 800, exitGraceMs: 800 };

const EDIT_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};
const EDIT_TOOL = {
  type: 'function',
  function: { name: 'edit-file', description: 'Edit a caller file.', parameters: EDIT_SCHEMA },
};
const LINT_TOOL = {
  type: 'function',
  function: { name: 'lint', parameters: { type: 'object', properties: {} } },
};
const CLIENT_TOOLS: ClientTool[] = [
  { name: 'edit-file', description: 'Edit a caller file.', parameters: EDIT_SCHEMA },
  { name: 'lint', parameters: { type: 'object', properties: {} } },
];

type ScriptCall = { name: string; arguments?: Record<string, unknown> };
const scriptPrompt = (groups: ScriptCall[][], extra: Record<string, unknown> = {}) =>
  `Run task.\nSCRIPT:${JSON.stringify({ groups, ...extra })}`;
const userMsg = (content: string) => ({ role: 'user', content });
const toolMsg = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });
const assistantCallsMsg = (calls: { id: string }[]) => ({
  role: 'assistant',
  content: null,
  tool_calls: calls,
});

const workspaceOf = (s: Gateway, runId: string) =>
  path.join(
    s.runtime.config.dataDir,
    'sessions',
    sha('owner').slice(0, 16),
    s.store.run(runId).sessionId,
  );

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function buildCodexFixtureSource(): string {
  return `
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Client } from ${JSON.stringify(MCP_CLIENT_URL)};
import { StdioClientTransport } from ${JSON.stringify(MCP_STDIO_URL)};

const argv = process.argv.slice(2);
const log = (line) => appendFileSync(path.join(process.cwd(), '.codex-bridge.log'), line + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
log('started:' + process.pid + ':' + JSON.stringify(argv));

function parseCallerServer(args) {
  let command = '';
  let serverArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c' || typeof args[i + 1] !== 'string') continue;
    const entry = args[i + 1];
    if (entry.startsWith('mcp_servers.oaa-caller.command='))
      command = JSON.parse(entry.slice('mcp_servers.oaa-caller.command='.length));
    if (entry.startsWith('mcp_servers.oaa-caller.args='))
      serverArgs = JSON.parse(entry.slice('mcp_servers.oaa-caller.args='.length));
  }
  return command ? { command, args: serverArgs } : null;
}

const callerServer = parseCallerServer(argv);
let threadId = '';
const turnId = 'turn-bridge-1';
let rpcSeq = 500;
let hangTimer = undefined;
let stubborn = false;
const waiting = new Map();

process.on('SIGTERM', () => {
  log('sigterm');
  if (!stubborn) process.exit(0);
});

const askHost = (method, params) =>
  new Promise((resolve) => {
    const id = ++rpcSeq;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const delta = (d) =>
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg1', delta: d } });
const completeTurn = (status = 'completed') =>
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });

async function handleTurn(params, instructions) {
  const input = (params.input ?? []).map((p) => p.text ?? '').join('');
  log('instructions:' + JSON.stringify(instructions ?? ''));
  const spec = JSON.parse(/SCRIPT:(\\{.*\\})/.exec(input)?.[1] ?? '{"groups":[]}');
  if (spec.hang) {
    stubborn = Boolean(spec.stubborn);
    delta('working...');
    hangTimer = setInterval(() => {}, 1000);
    return;
  }
  if (spec.hostCommand) {
    const hostAns = await askHost('item/commandExecution/requestApproval', {
      threadId,
      turnId,
      itemId: 'cmd-host',
      command: 'echo hi',
    });
    log('host-decision:' + JSON.stringify(hostAns));
    if (hostAns?.decision !== 'accept') {
      send({
        method: 'item/completed',
        params: { threadId, turnId, item: { id: 'cmd-host', type: 'commandExecution', status: 'declined' } },
      });
      delta('Host denied.');
      return completeTurn('completed');
    }
  }
  if (!callerServer) {
    delta('Codex no relay.');
    return completeTurn('completed');
  }
  const transport = new StdioClientTransport({
    command: callerServer.command,
    args: callerServer.args,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'codex-bridge-fixture', version: '1.0.0' });
  await client.connect(transport);
  log('relay-pid:' + transport.pid);
  log('relay-args:' + JSON.stringify(callerServer.args));
  const listed = await client.listTools();
  log('tools:' + JSON.stringify(listed.tools.map((t) => t.name)));

  if (spec.abandonAfterMs) {
    for (const call of spec.groups[0] ?? []) {
      client.callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, { timeout: 60000 })
        .catch((err) => log('abandoned:' + err.message));
    }
    await new Promise((r) => setTimeout(r, spec.abandonAfterMs));
    await client.close();
    log('relay-closed');
    await new Promise((r) => setTimeout(r, spec.holdMs ?? 200));
    delta('Codex continued after abandoning.');
    return completeTurn('completed');
  }

  const parts = [];
  for (const group of spec.groups ?? []) {
    const answers = await Promise.all(
      group.map(async (call, callIdx) => {
        if (spec.askMcpApproval) {
          if (callIdx === 0) {
            const elic = await askHost('mcpServer/elicitation/request', {
              threadId,
              turnId,
              serverName: 'oaa-caller',
              mode: 'form',
              _meta: {
                codex_approval_kind: 'mcp_tool_call',
                persist: ['session', 'always'],
                tool_name: call.name,
                tool_params: call.arguments ?? {},
              },
              message: 'Allow the oaa-caller MCP server to run tool "' + call.name + '"?',
              requestedSchema: { type: 'object', properties: {} },
            });
            log('mcp-approval:' + call.name + ':' + JSON.stringify(elic));
            if (
              elic?.action !== 'accept' ||
              JSON.stringify(elic?.content) !== '{}' ||
              elic?._meta !== null
            )
              return { isError: true, content: [{ type: 'text', text: 'declined-elicitation' }] };
          } else {
            const perm = await askHost('item/mcpToolCall/requestApproval', {
              threadId,
              turnId,
              server: 'oaa-caller',
              tool: call.name,
            });
            log('mcp-approval:' + call.name + ':' + JSON.stringify(perm));
            if (perm?.decision !== 'accept')
              return { isError: true, content: [{ type: 'text', text: 'declined' }] };
          }
        }
        return client.callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, {
          timeout: 60000,
        });
      }),
    );
    answers.forEach((ans, idx) => {
      const txt = ans.content.map((c) => c.text).join('');
      parts.push(group[idx].name + '=' + (ans.isError ? 'ERR:' + txt : txt));
    });
  }
  await client.close();
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: { total: { inputTokens: 6, outputTokens: 4, totalTokens: 10 } },
    },
  });
  delta('Codex results: ' + parts.join('; '));
  completeTurn('completed');
}

let savedInstructions = '';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg.result);
    waiting.delete(msg.id);
    return;
  }
  if (msg.method === 'initialize') return send({ id: msg.id, result: { userAgent: 'codex-fixture' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    threadId = msg.params.threadId ?? 'codex-t-' + process.pid;
    savedInstructions = msg.params.developerInstructions ?? '';
    log('thread-params:' + JSON.stringify({
      approvalPolicy: msg.params.approvalPolicy,
      sandbox: msg.params.sandbox,
    }));
    return send({ id: msg.id, result: { thread: { id: threadId }, model: msg.params.model ?? 'default' } });
  }
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    void handleTurn(msg.params, savedInstructions);
    return;
  }
  if (msg.method === 'turn/interrupt') {
    log('interrupt:' + msg.params?.threadId + ':' + msg.params?.turnId);
    if (stubborn) return;
    clearInterval(hangTimer);
    if (msg.id !== undefined) send({ id: msg.id, result: {} });
    completeTurn('interrupted');
    return;
  }
});
process.stdin.on('end', () => {
  log('stdin-end');
  if (!stubborn) {
    clearInterval(hangTimer);
    process.exit(0);
  }
});
`;
}

function buildClaudeFixtureSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from ${JSON.stringify(MCP_CLIENT_URL)};
import { StdioClientTransport } from ${JSON.stringify(MCP_STDIO_URL)};

const argv = process.argv.slice(2);
const log = (line) => appendFileSync(path.join(process.cwd(), '.claude-bridge.log'), line + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const sessionId = 'claude-b-' + process.pid;
log('argv:' + JSON.stringify(argv));

const mcpIdx = argv.indexOf('--mcp-config');
const mcpCfg = mcpIdx >= 0 && argv[mcpIdx + 1] ? JSON.parse(argv[mcpIdx + 1]) : null;
const callerServer = mcpCfg?.mcpServers?.['oaa-caller'] ?? null;

let seq = 0;
const pending = new Map();
const askCanUseTool = (toolName, input) =>
  new Promise((resolve) => {
    const request_id = 'perm-' + (++seq);
    pending.set(request_id, resolve);
    send({
      type: 'control_request',
      request_id,
      request: { subtype: 'can_use_tool', tool_name: toolName, input, permission_suggestions: [] },
    });
  });

const emitStreamedAssistant = (chunks) => {
  for (const chunk of chunks) {
    send({
      type: 'stream_event',
      uuid: 'u-' + (++seq),
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
    });
  }
  // Subagent stream noise must be ignored by top-level output collector.
  send({
    type: 'stream_event',
    uuid: 'u-' + (++seq),
    session_id: sessionId,
    parent_tool_use_id: 'subagent-tool-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT_NOISE' } },
  });
  send({
    type: 'assistant',
    uuid: 'u-' + (++seq),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'm_' + seq,
      type: 'message',
      role: 'assistant',
      model: 'claude-fixture',
      content: [{ type: 'text', text: chunks.join('') }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 2 },
    },
  });
};

const finish = (resultText, denials = []) =>
  send({
    type: 'result',
    subtype: 'success',
    uuid: 'u-' + (++seq),
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: resultText,
    total_cost_usd: 0,
    usage: { input_tokens: 8, output_tokens: 4 },
    permission_denials: denials,
  });

async function onPrompt(promptText) {
  send({
    type: 'system',
    subtype: 'init',
    uuid: 'u-' + (++seq),
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ['Write'],
    mcp_servers: [],
    model: 'claude-fixture',
    permissionMode: 'default',
    apiKeySource: 'none',
    slash_commands: [],
    output_style: 'default',
  });
  const spec = JSON.parse(/SCRIPT:(\\{.*\\})/.exec(promptText)?.[1] ?? '{"groups":[]}');
  if (spec.tryForbiddenCallerTool) {
    const ans = await askCanUseTool('mcp__oaa-caller__edit-file', { path: 'x.ts' });
    const behavior = ans?.response?.response?.behavior ?? ans?.response?.behavior;
    log('forbidden-behavior:' + behavior);
    if (behavior !== 'allow') {
      return finish('Denied.', [
        { tool_name: 'mcp__oaa-caller__edit-file', tool_use_id: 't1', tool_input: {} },
      ]);
    }
  }
  if (spec.hostWrite) {
    const ans = await askCanUseTool('Write', { file_path: 'outputs/host.txt', content: 'ok' });
    const behavior = ans?.response?.response?.behavior ?? ans?.response?.behavior;
    log('host-write-behavior:' + behavior);
    if (behavior !== 'allow')
      return finish('Denied.', [{ tool_name: 'Write', tool_use_id: 't2', tool_input: {} }]);
  }
  if (!callerServer) {
    emitStreamedAssistant(['Claude ', 'pure ', 'answer.']);
    return finish('Claude pure answer.');
  }
  const transport = new StdioClientTransport({
    command: callerServer.command,
    args: callerServer.args ?? [],
    env: { ...process.env, ...(callerServer.env ?? {}) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-bridge-fixture', version: '1.0.0' });
  await client.connect(transport);
  log('relay-pid:' + transport.pid);
  log('relay-args:' + JSON.stringify(callerServer.args));

  if (spec.beforeChunks) emitStreamedAssistant(spec.beforeChunks);

  if (spec.abandonAfterMs) {
    for (const call of spec.groups[0] ?? []) {
      client.callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, { timeout: 60000 })
        .catch((err) => log('abandoned:' + err.message));
    }
    await new Promise((r) => setTimeout(r, spec.abandonAfterMs));
    await client.close();
    log('relay-closed');
    await new Promise((r) => setTimeout(r, spec.holdMs ?? 200));
    emitStreamedAssistant(['Claude ', 'after ', 'abandon.']);
    return finish('Claude after abandon.');
  }

  const results = [];
  for (const group of spec.groups ?? []) {
    const batch = await Promise.all(
      group.map(async (call) => {
        const perm = await askCanUseTool('mcp__oaa-caller__' + call.name, call.arguments ?? {});
        const behavior = perm?.response?.response?.behavior ?? perm?.response?.behavior;
        log('caller-perm:' + call.name + ':' + behavior);
        if (behavior !== 'allow')
          return { isError: true, content: [{ type: 'text', text: 'denied' }] };
        return client.callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, {
          timeout: 60000,
        });
      }),
    );
    batch.forEach((res, idx) => {
      const txt = res.content.map((c) => c.text).join('');
      results.push(group[idx].name + '=' + (res.isError ? 'ERR:' + txt : txt));
    });
  }
  await client.close();
  const replyChunks = ['Claude results: ', results.join('; ')];
  emitStreamedAssistant(replyChunks);
  finish((spec.beforeChunks ? spec.beforeChunks.join('') : '') + replyChunks.join(''));
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'control_request') {
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response:
            msg.request?.subtype === 'initialize'
              ? {
                  commands: [],
                  output_style: 'default',
                  available_output_styles: ['default'],
                  models: [],
                  account: {},
                }
              : {},
        },
      });
    } else if (msg.type === 'control_response') {
      const id = msg.response?.request_id;
      pending.get(id)?.(msg);
      pending.delete(id);
    } else if (msg.type === 'user') {
      const c = msg.message?.content;
      const text = typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('');
      void onPrompt(text);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

async function nativeBridgeSetup(extra: Record<string, unknown> = {}) {
  const s = await setup(undefined, { approvalTimeoutMs: 15_000, ...extra });
  const codexScript = path.join(s.dir, 'codex-bridge-fixture.mjs');
  const claudeScript = path.join(s.dir, 'claude-bridge-fixture.mjs');
  await writeFile(codexScript, buildCodexFixtureSource());
  await writeFile(claudeScript, `${buildClaudeFixtureSource()}`);
  await chmod(claudeScript, 0o755);

  const codexCfg = () => ({ executable: process.execPath, args: [codexScript], enabled: true });
  const claudeCfg = () => ({ executable: claudeScript, args: [], enabled: true });
  s.config.localWorker!.native.codex = codexCfg() as never;
  s.runtime.config.native.codex = codexCfg() as never;
  s.config.localWorker!.native.claude = claudeCfg() as never;
  s.runtime.config.native.claude = claudeCfg() as never;

  for (const engine of ['codex', 'claude'] as const) {
    const pub = await s.request('POST', '/v1/agents/publish-native', {
      id: `agent/${engine}`,
      engine,
      models: ['default'],
      approvals: 'ask',
    });
    assert.equal(pub.statusCode, 200, pub.body);
  }
  return { s, codexScript, claudeScript };
}

async function assertRelayCleaned(ws: string, logName: string) {
  const raw = await readFile(path.join(ws, logName), 'utf8');
  const lines = raw.trim().split('\n');
  const relayArgs = lines
    .filter((l) => l.startsWith('relay-args:'))
    .flatMap((l) => JSON.parse(l.slice('relay-args:'.length)) as string[]);
  const files = [relayArgs[3], relayArgs[5]].filter((v): v is string => typeof v === 'string');
  const pids = lines
    .filter((l) => l.startsWith('relay-pid:'))
    .map((l) => Number(l.slice('relay-pid:'.length)));
  await waitFor(
    () => files.every((f) => !existsSync(f)) && pids.every((p) => !processAlive(p)),
    8_000,
  );
  for (const f of files) {
    if (!f.startsWith('\\\\.\\pipe\\')) assert.equal(existsSync(path.dirname(f)), false);
  }
}

test('native-bridge helpers: Claude mcpServers, Codex -c overrides and caller-tool permission matchers', () => {
  const relayServer = {
    name: 'oaa-caller',
    command: '/path/with spaces/node',
    args: [
      '/dir/cli.js',
      'mcp-relay',
      '--socket',
      '\\\\.\\pipe\\oaa-relay-123',
      '--token-file',
      '/t',
    ],
    env: [{ name: 'CUSTOM_FLAG', value: '1' }],
  };
  const claudeServers = claudeCallerMcpServers(relayServer);
  assert.deepEqual(claudeServers, {
    'oaa-caller': {
      type: 'stdio',
      command: '/path/with spaces/node',
      args: relayServer.args,
      env: { CUSTOM_FLAG: '1' },
    },
  });

  assert.equal(isClaudeCallerTool('mcp__oaa-caller__edit-file', CLIENT_TOOLS), true);
  assert.equal(isClaudeCallerTool('mcp__oaa-caller__lint', CLIENT_TOOLS), true);
  assert.equal(isClaudeCallerTool('mcp__oaa-caller__undeclared', CLIENT_TOOLS), false);
  assert.equal(isClaudeCallerTool('mcp__other__edit-file', CLIENT_TOOLS), false);
  assert.equal(isClaudeCallerTool('Write', CLIENT_TOOLS), false);
  assert.equal(isClaudeCallerTool('mcp__oaa-caller__edit-file', []), false);

  const codexArgs = codexCallerArgs({ ...relayServer, env: [] });
  assert.equal(codexArgs.length, 4);
  assert.equal(codexArgs[0], '-c');
  assert.equal(codexArgs[1], 'mcp_servers.oaa-caller.command="/path/with spaces/node"');
  assert.equal(codexArgs[2], '-c');
  assert.deepEqual(
    JSON.parse(codexArgs[3]!.slice('mcp_servers.oaa-caller.args='.length)),
    relayServer.args,
  );

  assert.deepEqual(codexReasoningArgs(false), [
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'approval_policy="on-request"',
    '-c',
    'mcp_servers={}',
  ]);
  assert.deepEqual(codexReasoningArgs(true), [
    '-c',
    'approval_policy="on-request"',
    '-c',
    'mcp_servers={}',
  ]);

  assert.equal(
    codexCallerTool(
      'item/mcpToolCall/requestApproval',
      { server: 'oaa-caller', tool: 'edit-file' },
      CLIENT_TOOLS,
    ),
    'edit-file',
  );
  assert.equal(
    isCodexCallerTool(
      'item/mcpToolCall/requestApproval',
      { item: { serverName: 'oaa-caller', toolName: 'lint' } },
      CLIENT_TOOLS,
    ),
    true,
  );
  // Host commands, file changes, other MCP servers and elicitation never auto-approve.
  assert.equal(
    isCodexCallerTool(
      'item/commandExecution/requestApproval',
      { server: 'oaa-caller', tool: 'edit-file' },
      CLIENT_TOOLS,
    ),
    false,
  );
  assert.equal(
    isCodexCallerTool(
      'item/fileChange/requestApproval',
      { server: 'oaa-caller', tool: 'edit-file' },
      CLIENT_TOOLS,
    ),
    false,
  );
  assert.equal(
    isCodexCallerTool(
      'mcpServer/elicitation/request',
      { server: 'oaa-caller', tool: 'edit-file' },
      CLIENT_TOOLS,
    ),
    false,
  );
  // Real Codex 0.167+ emits `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"`.
  const realCodexElicitation = {
    threadId: 'th-1',
    turnId: 'tu-1',
    serverName: 'oaa-caller',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_name: 'edit-file',
      tool_params: { path: 'src/a.ts' },
    },
    message: 'Allow the oaa-caller MCP server to run tool "edit-file"?',
    requestedSchema: { type: 'object', properties: {} },
  };
  assert.equal(
    codexCallerTool('mcpServer/elicitation/request', realCodexElicitation, CLIENT_TOOLS),
    'edit-file',
  );
  assert.equal(
    isCodexCallerTool(
      'mcpServer/elicitation/request',
      { ...realCodexElicitation, serverName: 'other-mcp' },
      CLIENT_TOOLS,
    ),
    false,
  );
  assert.equal(
    isCodexCallerTool(
      'mcpServer/elicitation/request',
      {
        ...realCodexElicitation,
        _meta: { ...realCodexElicitation._meta, tool_name: 'undeclared' },
      },
      CLIENT_TOOLS,
    ),
    false,
  );
  assert.deepEqual(
    codexDecisionPayload('mcpServer/elicitation/request', realCodexElicitation, true),
    {
      action: 'accept',
      content: {},
      _meta: null,
    },
  );
  assert.deepEqual(codexDecisionPayload('mcpServer/elicitation/request', { mode: 'url' }, true), {
    action: 'accept',
    content: null,
    _meta: null,
  });
  assert.deepEqual(
    codexDecisionPayload('mcpServer/elicitation/request', realCodexElicitation, false),
    {
      action: 'decline',
      content: null,
      _meta: null,
    },
  );
  assert.equal(
    isCodexCallerTool(
      'item/mcpToolCall/requestApproval',
      { server: 'other-mcp', tool: 'edit-file' },
      CLIENT_TOOLS,
    ),
    false,
  );
  assert.equal(
    isCodexCallerTool(
      'item/mcpToolCall/requestApproval',
      { server: 'oaa-caller', tool: 'rm-rf' },
      CLIENT_TOOLS,
    ),
    false,
  );
});

test('WorkerRuntime advertisement exposes codex, claude and ACP in clientTools.native and toolFreeReasoning only when enabled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-native-adv-'));
  try {
    const disabled = new WorkerRuntime(
      workerSchema.parse({
        nodeId: 'n1',
        dataDir: dir,
        native: {
          codex: { executable: process.execPath, enabled: false },
          claude: { executable: process.execPath, enabled: false },
        },
        adapters: {
          gem: { transport: 'acp', command: process.execPath, args: [], enabled: false },
        },
      }),
    );
    const offExec = disabled.advertisement().execution!;
    assert.deepEqual(offExec.clientTools?.native, ['kernel']);
    assert.deepEqual(offExec.toolFreeReasoning, ['kernel']);
    await disabled.close();

    const enabled = new WorkerRuntime(
      workerSchema.parse({
        nodeId: 'n2',
        dataDir: dir,
        native: {
          codex: { executable: process.execPath, enabled: true },
          claude: { executable: process.execPath, enabled: true },
          dsh: { executable: process.execPath, enabled: true },
        },
        adapters: {
          gem: { transport: 'acp', command: process.execPath, args: [], enabled: true },
          http1: { transport: 'http', url: 'https://example.com/invoke', enabled: true },
        },
      }),
    );
    const onExec = enabled.advertisement().execution!;
    assert.deepEqual(onExec.clientTools?.native.sort(), [
      'adapter/gem',
      'claude',
      'codex',
      'kernel',
    ]);
    assert.deepEqual(onExec.toolFreeReasoning?.sort(), [
      'adapter/gem',
      'claude',
      'codex',
      'kernel',
    ]);
    await enabled.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codex bridge: -c MCP override, auto-allowed caller permission, parallel calls and preserved host approval', async () => {
  const { s } = await nativeBridgeSetup();
  const fakeHome = path.join(s.dir, 'fake-home');
  await mkdir(path.join(fakeHome, '.codex'), { recursive: true });
  const configToml = path.join(fakeHome, '.codex', 'config.toml');
  await writeFile(configToml, '# user config untouched\n');
  s.runtime.config.nativeEnv = { mode: 'inherit', allow: [] };
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // Parallel caller tools + MCP approval auto-allow, on the strict OpenAI endpoint (auto -> bridge).
    const prompt = scriptPrompt(
      [
        [
          { name: 'edit-file', arguments: { path: 'src/a.ts' } },
          { name: 'lint', arguments: {} },
        ],
      ],
      { askMcpApproval: true, hostCommand: true },
    );
    // Owner approvals stay invisible to the caller's HTTP request: approve in parallel, then receive tool_calls.
    const knownRuns = new Set(s.store.allRuns().map((r) => r.id));
    const pendingChat = s.request('POST', '/v1/chat/completions', {
      model: 'agent/codex',
      tools: [EDIT_TOOL, LINT_TOOL],
      messages: [userMsg(prompt)],
    });
    await waitFor(
      () =>
        s.store
          .allRuns()
          .some(
            (r) =>
              !knownRuns.has(r.id) &&
              s.store.approvals(r.id).some((a) => a.kind === 'native' && a.status === 'pending'),
          ),
      10_000,
    );
    const runId = s.store.allRuns().find((r) => !knownRuns.has(r.id))!.id;
    const hostApproval = s.store
      .approvals(runId)
      .find((a) => a.kind === 'native' && a.status === 'pending')!;
    const approveRes = await s.request('POST', `/v1/runs/${runId}/actions/${hostApproval.id}`, {
      decision: 'approve',
    });
    assert.equal(approveRes.statusCode, 200, approveRes.body);

    const initial = await pendingChat;
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.headers['x-oaa-client-tools'], 'bridge');
    assert.equal(initial.json().choices[0].finish_reason, 'tool_calls');
    const toolCalls = initial.json().choices[0].message.tool_calls as {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }[];
    assert.equal(toolCalls.length, 2);
    const autoAllowed = s.store
      .history(runId)
      .filter((e) => e.type === 'tool.progress' && e.data.event === 'permission_auto_allowed');
    assert.equal(autoAllowed.length, 2, 'both oaa-caller MCP tools were auto-allowed');
    const resumed = await s.request(
      'POST',
      '/v1/compat/chat/completions',
      {
        model: 'agent/codex',
        tools: [EDIT_TOOL, LINT_TOOL],
        messages: [
          userMsg('continue'),
          assistantCallsMsg(toolCalls),
          ...toolCalls.map((c) => toolMsg(c.id, `done-${c.function.name}`)),
        ],
      },
      token,
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.headers['x-run-id'], runId);
    assert.equal(
      resumed.json().choices[0].message.content,
      'Codex results: edit-file=done-edit-file; lint=done-lint',
    );
    assert.equal(await readFile(configToml, 'utf8'), '# user config untouched\n');
    await assertRelayCleaned(workspaceOf(s, runId), '.codex-bridge.log');
  } finally {
    process.env.HOME = prevHome;
    await s.cleanup();
  }
});

test('claude bridge: MCP dictionary, canUseTool auto-allow, parallel calls, host approval and token streaming deduplication', async () => {
  const { s } = await nativeBridgeSetup();
  try {
    const prompt = scriptPrompt(
      [
        [
          { name: 'edit-file', arguments: { path: 'src/b.ts' } },
          { name: 'lint', arguments: {} },
        ],
      ],
      { beforeChunks: ['Checking ', 'caller ', 'tools. '], hostWrite: true },
    );
    // Start in background so we can approve the host Write tool first, then answer caller tools.
    const started = await s.request('POST', '/v1/compat/responses', {
      model: 'agent/claude',
      tools: [
        { type: 'function', name: 'edit-file', parameters: EDIT_SCHEMA },
        { type: 'function', name: 'lint', parameters: { type: 'object', properties: {} } },
      ],
      input: prompt,
      background: true,
    });
    assert.equal(started.statusCode, 200, started.body);
    const runId = String(started.json().id);

    await waitFor(
      () => s.store.approvals(runId).some((a) => a.kind === 'native' && a.status === 'pending'),
      10_000,
    );
    const hostWrite = s.store
      .approvals(runId)
      .find((a) => a.kind === 'native' && a.status === 'pending')!;
    assert.equal(hostWrite.detail.tool, 'Write');
    await s.request('POST', `/v1/runs/${runId}/actions/${hostWrite.id}`, { decision: 'approve' });

    await waitFor(
      () =>
        s.store.approvals(runId).filter((a) => a.kind === 'client_tool' && a.status === 'pending')
          .length === 2,
      10_000,
    );
    const awaiting = s.store.history(runId).filter((e) => e.type === 'run.awaiting_caller');
    assert.equal(awaiting.length, 1);
    const pendingCalls = s.store
      .approvals(runId)
      .filter((a) => a.kind === 'client_tool' && a.status === 'pending');

    const autoEvents = s.store
      .history(runId)
      .filter((e) => e.type === 'tool.progress' && e.data.event === 'permission_auto_allowed');
    assert.deepEqual(autoEvents.map((e) => e.data.tool).sort(), [
      'mcp__oaa-caller__edit-file',
      'mcp__oaa-caller__lint',
    ]);

    const cont = await s.request(
      'POST',
      '/v1/compat/responses',
      {
        model: 'agent/claude',
        tools: [
          { type: 'function', name: 'edit-file', parameters: EDIT_SCHEMA },
          { type: 'function', name: 'lint', parameters: { type: 'object', properties: {} } },
        ],
        previous_response_id: runId,
        input: pendingCalls.map((a) => ({
          type: 'function_call_output',
          call_id: a.id,
          output: `ok-${String(a.detail.tool)}`,
        })),
      },
      token,
      { 'x-oaa-client-tools': 'bridge' },
    );
    assert.equal(cont.statusCode, 200, cont.body);
    assert.equal(cont.headers['x-run-id'], runId);

    const finalRun = s.store.run(runId);
    assert.equal(finalRun.status, 'completed');
    // Streamed chunks before and after tool calls must appear once each, without assistant duplication or subagent noise.
    const fullOutput = finalRun.output.map((m) => m.text).join('');
    assert.equal(
      fullOutput,
      'Checking caller tools. Claude results: edit-file=ok-edit-file; lint=ok-lint',
    );
    assert.ok(!fullOutput.includes('SUBAGENT_NOISE'));
    const deltas = s.store
      .history(runId)
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => String(e.data.delta));
    assert.equal(deltas.join(''), fullOutput, 'deltas equal exact output without duplication');
    assert.ok(deltas.length >= 4, `expected token-level deltas, got ${deltas.length}`);
    await assertRelayCleaned(workspaceOf(s, runId), '.claude-bridge.log');
  } finally {
    await s.cleanup();
  }
});

test('native bridge abandoned calls: codex and claude mark abandoned steps failed and complete the run cleanly', async () => {
  const { s } = await nativeBridgeSetup();
  try {
    for (const [engine, logFile, expectedText] of [
      ['codex', '.codex-bridge.log', 'Codex continued after abandoning.'],
      ['claude', '.claude-bridge.log', 'Claude after abandon.'],
    ] as const) {
      const prompt = scriptPrompt([[{ name: 'edit-file', arguments: { path: 'z.ts' } }]], {
        abandonAfterMs: 350,
        holdMs: 900,
      });
      const first = await s.request(
        'POST',
        '/v1/compat/chat/completions',
        { model: `agent/${engine}`, tools: [EDIT_TOOL], messages: [userMsg(prompt)] },
        token,
        { 'x-oaa-client-tools': 'bridge' },
      );
      assert.equal(first.statusCode, 200, first.body);
      const runId = String(first.headers['x-run-id']);
      assert.equal(first.json().choices[0].finish_reason, 'tool_calls');

      await waitFor(
        () => s.store.steps(runId).find((st) => st.name === 'edit-file')?.status === 'failed',
        6_000,
      );
      const step = s.store.steps(runId).find((st) => st.name === 'edit-file')!;
      assert.equal(step.error, 'client_tool_abandoned');
      assert.equal(s.store.approvals(runId)[0]!.status, 'expired');

      const final = await s.kernel.wait(runId);
      assert.equal(final.status, 'completed', JSON.stringify(final.error));
      assert.equal(final.output.map((m) => m.text).join(''), expectedText);
      await assertRelayCleaned(workspaceOf(s, runId), logFile);
    }
  } finally {
    await s.cleanup();
  }
});

test('codex cooperative interrupt sends turn/interrupt first, and terminates stubborn processes after grace', async () => {
  const { s, codexScript } = await nativeBridgeSetup();
  try {
    // 1. Cooperative exit on turn/interrupt without SIGTERM.
    const coopDir = path.join(s.dir, 'coop');
    await mkdir(coopDir, { recursive: true });
    const coopAbort = new AbortController();
    const coopStarted = Date.now();
    await assert.rejects(
      codex(
        process.execPath,
        [codexScript],
        agent({ engine: 'codex', model: 'default' }),
        coopDir,
        [{ type: 'text', text: scriptPrompt([], { hang: true }) }],
        coopAbort.signal,
        async (ev) => {
          if (ev.type === 'text') coopAbort.abort();
        },
        undefined,
        process.env,
        undefined,
        { interruptGraceMs: 2_500 },
      ),
      (err: unknown) => err instanceof Fault && err.code === 'cancelled',
    );
    assert.ok(Date.now() - coopStarted < 1_500, 'exited cooperatively well before the 2500ms cap');
    const coopLog = (await readFile(path.join(coopDir, '.codex-bridge.log'), 'utf8')).split('\n');
    assert.ok(
      coopLog.some((l) => l.startsWith('interrupt:codex-t-') && l.endsWith(':turn-bridge-1')),
    );
    assert.ok(!coopLog.includes('sigterm'), 'cooperative exit did not require SIGTERM');

    // 2. Stubborn process that ignores turn/interrupt is terminated after grace expires.
    const stubDir = path.join(s.dir, 'stubborn');
    await mkdir(stubDir, { recursive: true });
    const stubAbort = new AbortController();
    await assert.rejects(
      codex(
        process.execPath,
        [codexScript],
        agent({ engine: 'codex', model: 'default' }),
        stubDir,
        [{ type: 'text', text: scriptPrompt([], { hang: true, stubborn: true }) }],
        stubAbort.signal,
        async (ev) => {
          if (ev.type === 'text') stubAbort.abort();
        },
        undefined,
        process.env,
        undefined,
        { interruptGraceMs: 250 },
      ),
      (err: unknown) => err instanceof Fault && err.code === 'cancelled',
    );
    const stubLog = (await readFile(path.join(stubDir, '.codex-bridge.log'), 'utf8')).split('\n');
    assert.ok(stubLog.some((l) => l.startsWith('interrupt:codex-t-')));
    const stubPid = Number(stubLog.find((l) => l.startsWith('started:'))!.split(':')[1]);
    await waitFor(() => !processAlive(stubPid), 5_000);
  } finally {
    await s.cleanup();
  }
});

test('toolsDisabled enforces tool-free reasoning across codex, claude and ACP engines', async () => {
  const { s, codexScript, claudeScript } = await nativeBridgeSetup();
  try {
    const cfg = workerSchema.parse({
      nodeId: 'tf',
      dataDir: s.dir,
      native: {
        codex: { executable: process.execPath, args: [codexScript], enabled: true },
        claude: { executable: claudeScript, args: [], enabled: true },
        dsh: { executable: process.execPath, args: [], enabled: true },
      },
      adapters: {
        acp1: {
          transport: 'acp',
          command: process.execPath,
          args: [path.resolve('test/fixtures/acp-agent.mjs'), 'stream'],
          enabled: true,
        },
      },
    });

    // DSH still has no tool-free path.
    await assert.rejects(
      runNative(
        agent({ engine: 'dsh', model: 'default' }),
        cfg,
        s.dir,
        'hi',
        AbortSignal.timeout(5_000),
        async () => {},
        undefined,
        undefined,
        undefined,
        s.dir,
        true,
      ),
      (err: unknown) => err instanceof Fault && err.code === 'capability_unavailable',
    );

    // Codex tool-free success: read-only sandbox, empty mcp_servers, REASONING_ONLY, no relay opened.
    const codexDir = path.join(s.dir, 'tf-codex-ok');
    await mkdir(codexDir, { recursive: true });
    const codexOk = await runNative(
      agent({ engine: 'codex', model: 'default', approvals: 'auto', instructions: 'Base rule.' }),
      cfg,
      codexDir,
      scriptPrompt([]),
      AbortSignal.timeout(8_000),
      async () => {},
      undefined,
      undefined,
      undefined,
      codexDir,
      true,
      CLIENT_TOOLS,
    );
    assert.equal(codexOk.text, 'Codex no relay.');
    const codexLog = await readFile(path.join(codexDir, '.codex-bridge.log'), 'utf8');
    assert.match(codexLog, /sandbox_mode=\\"read-only\\"/);
    assert.match(codexLog, /mcp_servers=\{\}/);
    assert.ok(!codexLog.includes('oaa-caller'));
    assert.ok(codexLog.includes(REASONING_ONLY.slice(0, 40)));
    assert.match(codexLog, /"approvalPolicy":"on-request","sandbox":"read-only"/);

    // Codex tool-free denial: any approval request is declined without prompting the owner and fails the turn.
    const codexDenyDir = path.join(s.dir, 'tf-codex-deny');
    await mkdir(codexDenyDir, { recursive: true });
    let ownerPrompted = 0;
    const codexProgress: WorkEvent[] = [];
    await assert.rejects(
      runNative(
        agent({ engine: 'codex', model: 'default' }),
        cfg,
        codexDenyDir,
        scriptPrompt([], { hostCommand: true }),
        AbortSignal.timeout(8_000),
        async (ev) => {
          if (ev.type === 'approval') ownerPrompted++;
          if (ev.type === 'progress') codexProgress.push(ev);
        },
        undefined,
        undefined,
        undefined,
        codexDenyDir,
        true,
      ),
      (err: unknown) => err instanceof Fault && err.code === 'permission_denied',
    );
    assert.equal(ownerPrompted, 0);
    assert.ok(codexProgress.some((e) => e.data.reason === 'tools_disabled'));

    // Claude tool-free denial: even a forged mcp__oaa-caller__* tool request is denied.
    const claudeDenyDir = path.join(s.dir, 'tf-claude-deny');
    await mkdir(claudeDenyDir, { recursive: true });
    await assert.rejects(
      runNative(
        agent({ engine: 'claude', model: 'default' }),
        cfg,
        claudeDenyDir,
        scriptPrompt([], { tryForbiddenCallerTool: true }),
        AbortSignal.timeout(8_000),
        async (ev) => {
          if (ev.type === 'approval') ownerPrompted++;
        },
        undefined,
        undefined,
        undefined,
        claudeDenyDir,
        true,
        CLIENT_TOOLS,
      ),
      (err: unknown) => err instanceof Fault && err.code === 'permission_denied',
    );
    assert.equal(ownerPrompted, 0);
    const claudeLog = await readFile(path.join(claudeDenyDir, '.claude-bridge.log'), 'utf8');
    assert.match(claudeLog, /--strict-mcp-config/);
    assert.match(claudeLog, /forbidden-behavior:deny/);

    // ACP tool-free success + permission denial through WorkerRuntime and runAcp.
    const acpOkDir = path.join(s.dir, 'tf-acp-ok');
    await mkdir(acpOkDir, { recursive: true });
    const acpOk = await runAcp(
      agent({ engine: 'adapter/acp1', model: 'default', instructions: 'Stay concise.' }),
      cfg,
      acpOkDir,
      'MARKER:pure',
      AbortSignal.timeout(8_000),
      async () => {},
      undefined,
      FAST_ACP,
      CLIENT_TOOLS,
      undefined,
      acpOkDir,
      true,
    );
    assert.equal(acpOk.text, 'ACP fixture turn 1 (model default): pure');
    const acpOkLog = await readFile(path.join(acpOkDir, '.acp-fixture.log'), 'utf8');
    assert.match(acpOkLog, /mcp=0/);
    const acpState = JSON.parse(await readFile(path.join(acpOkDir, '.acp-fixture.json'), 'utf8'));
    const recordedUser = Object.values(
      acpState.sessions as Record<string, { user: string }[]>,
    )[0]![0]!.user;
    assert.ok(recordedUser.includes(REASONING_ONLY));

    const acpDenyDir = path.join(s.dir, 'tf-acp-deny');
    await mkdir(acpDenyDir, { recursive: true });
    const runtime = new WorkerRuntime(cfg);
    runtime.acpTimings = FAST_ACP;
    try {
      const acpBundle = makeBundle(
        agent({ id: 'agent/acp1', engine: 'adapter/acp1', model: 'default' }),
      );
      await runtime.install(acpBundle);
      await assert.rejects(
        runtime.execute(
          {
            kind: 'native',
            toolsDisabled: true,
            agent: acpBundle.agent,
            input: 'Write MODE:permission',
            context: {
              runId: 'resp_tf',
              sessionId: 'sess_tf',
              owner: 'owner',
              digest: acpBundle.digest,
              files: [],
            },
          },
          AbortSignal.timeout(8_000),
          async (ev) => {
            if (ev.type === 'approval') ownerPrompted++;
          },
        ),
        (err: unknown) => err instanceof Fault && err.code === 'permission_denied',
      );
      assert.equal(ownerPrompted, 0);
    } finally {
      await runtime.close();
    }
  } finally {
    await s.cleanup();
  }
});
