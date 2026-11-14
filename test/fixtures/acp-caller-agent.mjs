// ACP (v1) fixture that uses the MCP servers handed to it in session/new (caller-tool bridging).
// It speaks JSON-RPC 2.0 over stdio only, never calls a model and never uses the network.
// The prompt carries `SCRIPT:<json>` on one line: { "groups": [[{ "name", "arguments" }]] }.
// Calls in one group run in parallel, groups run one after another. Each result is written into
// the reply text. With `abandonAfterMs` the agent closes its MCP client while the first group
// still waits. With `permission: { title, rawInput? }` the agent first asks the client for
// permission (session/request_permission) once per call, as real agents do before running an MCP
// tool, and skips the call when it is not allowed. Observations go to .acp-caller.log in the
// working directory.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const log = (line) => appendFileSync(path.join(process.cwd(), '.acp-caller.log'), `${line}\n`);
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

const sessions = new Map();
const cancels = new Map();
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
process.stdin.on('end', () => {
  log('stdin-closed');
  process.exit(0);
});

let requestSeq = 0;
const answers = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `caller-req-${++requestSeq}`;
    answers.set(id, resolve);
    send({ id, method, params });
  });

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
      agentInfo: { name: 'oaa-acp-caller-fixture', version: '1.0.0' },
    });
  if (method === 'session/new' || method === 'session/load') {
    log(`${method}:${JSON.stringify(params.mcpServers)}`);
    const sessionId = params.sessionId ?? `caller-session-${process.pid}`;
    sessions.set(sessionId, params.mcpServers ?? []);
    return reply(method === 'session/new' ? { sessionId } : {});
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') {
    log('cancel');
    cancels.get(params.sessionId)?.();
    return;
  }
  if (id !== undefined)
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const input = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const script = JSON.parse(/SCRIPT:(\{.*\})/.exec(input)?.[1] ?? '{"groups":[]}');
  const servers = sessions.get(sessionId) ?? [];
  const cancelled = new Promise((resolve) => cancels.set(sessionId, resolve));
  if (!servers.length) {
    say(sessionId, 'No caller tools.');
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  const server = servers[0];
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'acp-caller-fixture', version: '1.0.0' });
  await client.connect(transport);
  log(`relay-pid:${transport.pid}`);
  const { tools } = await client.listTools();
  log(`tools:${JSON.stringify(tools)}`);
  if (script.before) say(sessionId, script.before);
  // `abandonAfterMs`: start the first group, then close the MCP client while the calls still wait
  // (an agent giving up on a call), keep working for `holdMs` and finish without the results.
  if (script.abandonAfterMs) {
    for (const call of script.groups[0] ?? [])
      client
        .callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, {
          timeout: 600_000,
        })
        .catch((error) => log(`abandoned-call:${error.message}`));
    await new Promise((resolve) => setTimeout(resolve, script.abandonAfterMs));
    await client.close();
    log('relay-closed');
    const outcome = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve('done'), script.holdMs ?? 0)),
      cancelled.then(() => 'cancelled'),
    ]);
    if (outcome === 'cancelled') return send({ id, result: { stopReason: 'cancelled' } });
    say(sessionId, 'Gave up on the caller tool.');
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  const results = [];
  const work = (async () => {
    for (const group of script.groups) {
      const answers = await Promise.all(
        group.map(async (call) => {
          if (script.permission) {
            const answer = await request('session/request_permission', {
              sessionId,
              toolCall: {
                toolCallId: `perm-${call.name}`,
                title: script.permission.title.replaceAll('<name>', call.name),
                kind: 'other',
                rawInput: script.permission.rawInput ?? { reason: 'fixture' },
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            });
            log(`permission:${call.name}:${JSON.stringify(answer?.outcome ?? null)}`);
            if (answer?.outcome?.optionId !== 'allow')
              return { isError: true, content: [{ type: 'text', text: 'not permitted' }] };
          }
          return client.callTool({ name: call.name, arguments: call.arguments ?? {} }, undefined, {
            timeout: 600_000,
          });
        }),
      );
      answers.forEach((answer, i) => {
        const text = answer.content.map((c) => c.text).join('');
        results.push(`${group[i].name}=${answer.isError ? `ERROR(${text})` : text}`);
      });
      log(`group-done:${results.length}`);
    }
  })();
  const finished = work.then(
    () => 'done',
    (error) => {
      log(`work-error:${error.message}`);
      return 'error';
    },
  );
  const outcome = await Promise.race([finished, cancelled.then(() => 'cancelled')]);
  if (outcome === 'cancelled') {
    log('cancel-acknowledged');
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (!script.keepRelay) await client.close();
  say(sessionId, `Results: ${results.join('; ')}`);
  return send({ id, result: { stopReason: 'end_turn' } });
}
