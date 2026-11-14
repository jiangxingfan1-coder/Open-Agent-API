// 「真实智能体端到端验证」脚本（examples/live-agents-acceptance.ts）的离线替身：ACP v1 over stdio。
// 不调用任何模型、不联网。读懂脚本发给真实智能体的同一组中文提示词，给出可机器校验的回答：
// - 「只回复这一串字符：X」→ 分几段流式回复 X，并记入会话历史（供续接）；
// - 「上一轮」→ 回复本会话上一轮给过的那串字符（session/load 续接）；
// - 「note.txt」+「内容只有一行：X」（演示视频的英文版提示词用 “containing exactly one line: X”）→ 先请求写文件的权限，批准才写入；
// - 「数到」→ 每 100 毫秒输出一个数字，直到被取消；
// - 「get_order_status」+「订单号 X」→ 经网关交来的 MCP 中继调用调用方工具，回复工具结果。
// 启动时把自己拿到的环境变量名（不含值）写到工作目录的 .live-fixture-env.json。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const statePath = () => path.join(process.cwd(), '.live-fixture.json');
const load = () =>
  existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : { sessions: {} };
const save = (state) => writeFileSync(statePath(), JSON.stringify(state));
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const say = (sessionId, text) =>
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
writeFileSync(
  path.join(process.cwd(), '.live-fixture-env.json'),
  JSON.stringify({ pid: process.pid, names: Object.keys(process.env).sort() }),
);

const sessions = new Map();
const cancels = new Map();
const answers = new Map();
let seq = 0;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `live-fixture-${++seq}`;
    answers.set(id, resolve);
    send({ id, method, params });
  });

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === undefined && answers.has(id)) {
    answers.get(id)(message.result ?? null);
    answers.delete(id);
    return;
  }
  const reply = (result) => send({ id, result });
  if (method === 'initialize')
    return reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: false, sse: false } },
      agentInfo: { name: 'oaa-live-fixture', version: '1.0.0' },
    });
  if (method === 'session/new' || method === 'session/load') {
    const sessionId = params.sessionId ?? `live-session-${process.pid}-${Date.now()}`;
    sessions.set(sessionId, params.mcpServers ?? []);
    if (method === 'session/load' && !load().sessions[sessionId])
      return send({ id, error: { code: -32002, message: 'Session not found' } });
    return reply(method === 'session/new' ? { sessionId } : {});
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') {
    cancels.get(params.sessionId)?.();
    return;
  }
  if (id !== undefined)
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const usage = { inputTokens: 12, outputTokens: 5, totalTokens: 17 };

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const input = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const done = (stopReason = 'end_turn') => send({ id, result: { stopReason, usage } });
  let cancelled = false;
  const cancel = new Promise((resolve) =>
    cancels.set(sessionId, () => {
      cancelled = true;
      resolve();
    }),
  );
  const state = load();
  const history = (state.sessions[sessionId] ??= []);

  if (input.includes('get_order_status')) {
    const server = (sessions.get(sessionId) ?? [])[0];
    if (!server) {
      say(sessionId, '没有可用的调用方工具。');
      return done();
    }
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'live-fixture', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name.includes('get_order_status'));
    const orderId = /订单号\s*[:：]?\s*([A-Za-z0-9-]+)/.exec(input)?.[1] ?? 'unknown';
    const result = await client.callTool(
      { name: tool?.name ?? 'get_order_status', arguments: { order_id: orderId } },
      undefined,
      { timeout: 600_000 },
    );
    await client.close();
    const text = result.content.map((c) => c.text ?? '').join('');
    say(sessionId, `订单状态：${text}`);
    return done();
  }

  if (input.includes('note.txt')) {
    const line =
      /(?:内容只有一行[:：]|containing exactly one line:)\s*([A-Za-z0-9-]+)/.exec(input)?.[1] ??
      'missing';
    const toolCall = {
      toolCallId: 'write-note',
      title: 'Write note.txt',
      kind: 'edit',
      rawInput: { path: 'note.txt', content: `${line}\n` },
      locations: [{ path: 'note.txt' }],
    };
    send({
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' } },
    });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    if (answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'once') {
      writeFileSync(path.join(process.cwd(), 'note.txt'), `${line}\n`);
      say(sessionId, 'DONE');
    } else say(sessionId, '未获批准，没有写文件。');
    return done();
  }

  if (input.includes('数到')) {
    for (let n = 1; n <= 600 && !cancelled; n++) {
      say(sessionId, `${n}\n`);
      await Promise.race([sleep(100), cancel]);
    }
    return done(cancelled ? 'cancelled' : 'end_turn');
  }

  let answer;
  if (input.includes('上一轮')) answer = history.at(-1)?.token ?? '我不记得上一轮。';
  else answer = /只回复这一串字符[:：]\s*([A-Za-z0-9-]+)/.exec(input)?.[1] ?? '收到。';
  const parts = answer.match(/.{1,3}/g) ?? [answer];
  for (const part of parts) {
    say(sessionId, part);
    await sleep(30);
  }
  history.push({ token: answer });
  save(state);
  return done();
}
