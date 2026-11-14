#!/usr/bin/env node
// Open Agent API 的离线示例智能体（ACP，JSON-RPC over stdio）。
// 它不调用任何模型、不联网、不花钱：回答是按固定规则拼出来的，只用来演示网关的多步执行、
// 一次工具调用和一次可选的审批。`oaa quickstart` 会把它发布成 agent/sample。
// Offline sample agent for Open Agent API (ACP over stdio). It calls no model and uses no network;
// the answer is assembled by fixed rules to demonstrate steps, one tool call and an optional approval.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let seq = 0;
const outgoing = new Map();
const cancels = new Map();
const turns = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `sample-${++seq}`;
    outgoing.set(id, resolve);
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
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      process.stderr.write('sample-agent: ignored a line that is not JSON\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    outgoing.get(message.id)?.(message);
    outgoing.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => send({ id, result });
  if (method === 'initialize')
    return reply({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
      agentInfo: { name: 'oaa-sample-agent', title: 'Sample agent (offline)', version: '1.0.0' },
    });
  if (method === 'session/new') {
    const sessionId = `sample-${process.pid}-${Date.now()}`;
    turns.set(sessionId, 0);
    return reply({ sessionId });
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') return cancels.get(params.sessionId)?.();
  if (id !== undefined)
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const input = (params.prompt ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  const zh = /\p{Script=Han}/u.test(input);
  const t = (cn, en) => (zh ? cn : en);
  const turn = (turns.get(sessionId) ?? 0) + 1;
  turns.set(sessionId, turn);
  const wantsApproval = /审批|批准|approv/i.test(input);
  const cancelled = new Promise((resolve) => cancels.set(sessionId, () => resolve('cancelled')));
  const plan = (done) =>
    update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: t('读取任务', 'Read the task'), priority: 'high', status: 'completed' },
        {
          content: t('读取本机时间（工具调用）', 'Read the local time (tool call)'),
          priority: 'high',
          status: done >= 2 ? 'completed' : 'in_progress',
        },
        ...(wantsApproval
          ? [
              {
                content: t('经批准后写入文件', 'Write a file after approval'),
                priority: 'medium',
                status: done >= 3 ? 'completed' : 'pending',
              },
            ]
          : []),
        {
          content: t('给出回答', 'Answer'),
          priority: 'high',
          status: done >= 4 ? 'completed' : 'pending',
        },
      ],
    });

  plan(1);
  const now = new Date().toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'clock-1',
    title: t('读取本机时间', 'Read the local time'),
    kind: 'read',
    status: 'in_progress',
    rawInput: {},
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'clock-1',
    status: 'completed',
    rawOutput: { time: now },
  });
  plan(2);

  let approvalLine = '';
  if (wantsApproval) {
    const toolCall = {
      toolCallId: 'write-1',
      title: t('写入 outputs/sample-note.txt', 'Write outputs/sample-note.txt'),
      kind: 'edit',
      rawInput: { path: 'outputs/sample-note.txt' },
      locations: [{ path: 'outputs/sample-note.txt' }],
    };
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
    const answer = await Promise.race([
      ask('session/request_permission', {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow', name: t('允许一次', 'Allow once'), kind: 'allow_once' },
          { optionId: 'reject', name: t('拒绝', 'Reject'), kind: 'reject_once' },
        ],
      }),
      cancelled,
    ]);
    if (answer === 'cancelled') return send({ id, result: { stopReason: 'cancelled' } });
    const outcome = answer.result?.outcome;
    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow';
    if (allowed) {
      mkdirSync('outputs', { recursive: true });
      writeFileSync(
        path.join('outputs', 'sample-note.txt'),
        `${t('示例智能体写下的文件', 'Written by the sample agent')}: ${input}\n`,
      );
    }
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'write-1',
      status: allowed ? 'completed' : 'failed',
    });
    approvalLine = allowed
      ? t('已获批准，写入了 outputs/sample-note.txt。', 'Approved; wrote outputs/sample-note.txt.')
      : t('未获批准，没有写入任何文件。', 'Not approved; nothing was written.');
    plan(3);
  }

  const parts = [
    t(
      '【这是 Open Agent API 的离线示例智能体，不调用任何模型，回答由固定规则生成。】',
      '[This is the Open Agent API offline sample agent. It calls no model; this answer is generated by fixed rules.]',
    ),
    t(
      `这是本会话的第 ${turn} 轮。我调用了一次工具「读取本机时间」，结果是 ${now}。`,
      `This is turn ${turn} of this session. I called one tool, "read the local time", and it returned ${now}.`,
    ),
    approvalLine,
    wantsApproval
      ? ''
      : t(
          '在任务里写上「审批」可以演示一次审批。',
          'Put "approve" in the task to see an approval.',
        ),
    t(
      '接上你自己的智能体：运行 oaa doctor 查看本机找到的智能体，再按 oaa quickstart 结尾的提示发布。',
      'To connect your own agent, run oaa doctor to see what this machine has, then follow the steps printed at the end of oaa quickstart.',
    ),
  ].filter(Boolean);
  for (const part of parts) say(sessionId, part + (zh ? '' : ' '));
  plan(4);
  cancels.delete(sessionId);
  send({ id, result: { stopReason: 'end_turn' } });
}
