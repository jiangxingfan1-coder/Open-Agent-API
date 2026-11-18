// Protocol-level stand-ins for the built-in native engines, for the conformance matrix. They never
// call a model or the network. The engine is recognised from how OAA starts the process:
// - codex: `app-server --listen stdio://` JSON-RPC (initialize, thread/start|resume, turn/start)
// - dsh: `--profile headless ... -- <prompt>` one-shot (started through a generated launcher)
// - antigravity (default): `--input-format stream-json --output-format stream-json`
// Behaviour per prompt marker: MODE:approval, MODE:hang, MODE:fail, MODE:denied, MODE:artifact;
// MARKER:<x> is echoed. Turn counters persist in the working directory per session/thread.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const kind = argv.includes('app-server') ? 'codex' : argv.includes('--profile') ? 'dsh' : 'agy';
const log = (line) => appendFileSync(path.join(process.cwd(), `.${kind}-fixture.log`), `${line}\n`);
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const statePath = path.join(process.cwd(), `.${kind}-fixture.json`);
const nextTurn = (key) => {
  const all = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  all[key] = (all[key] ?? 0) + 1;
  writeFileSync(statePath, JSON.stringify(all));
  return all[key];
};
const markerOf = (text) => /MARKER:(\S+)/.exec(text)?.[1] ?? 'none';
const writeOutput = (name, content) => {
  mkdirSync('outputs', { recursive: true });
  writeFileSync(path.join('outputs', name), content);
};
log(`started:${JSON.stringify(argv)}`);

if (kind === 'dsh') {
  const prompt = argv.at(-1) ?? '';
  if (prompt.includes('MODE:fail')) {
    process.stderr.write('dsh fixture failure token=fixture-secret-value-123456\n');
    process.exitCode = 4;
  } else if (prompt.includes('MODE:hang')) {
    setInterval(() => {}, 1_000);
  } else {
    if (prompt.includes('MODE:artifact')) writeOutput('dsh.txt', 'artifact');
    process.stdout.write(`DSH fixture final: ${markerOf(prompt)}`);
  }
} else if (kind === 'codex') {
  let threadId = '';
  let seq = 1_000;
  let hangTimer = undefined;
  const waiting = new Map();
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      output({ id, method, params });
    });
  const delta = (text) =>
    output({
      method: 'item/agentMessage/delta',
      params: { threadId, turnId: 'turn-1', itemId: 'message', delta: text },
    });
  const item = (method, id, type, status) =>
    output({ method, params: { threadId, turnId: 'turn-1', item: { id, type, status } } });
  const done = (status = 'completed') =>
    output({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status } } });
  const turn = async (params) => {
    const text = (params.input ?? []).map((part) => part.text ?? '').join('');
    if (text.includes('MODE:fail')) return done('failed');
    if (text.includes('MODE:hang')) {
      delta('working...');
      hangTimer = setInterval(() => {}, 1_000);
      return;
    }
    if (text.includes('MODE:approval')) {
      item('item/started', 'fc1', 'fileChange', 'inProgress');
      const answer = await ask('item/fileChange/requestApproval', {
        threadId,
        turnId: 'turn-1',
        itemId: 'fc1',
        reason: 'Write outputs/codex.txt',
      });
      log(`approval:${answer?.decision}`);
      if (answer?.decision === 'accept') {
        writeOutput('codex.txt', 'approved');
        item('item/completed', 'fc1', 'fileChange', 'completed');
        delta('Approved and written.');
      } else {
        item('item/completed', 'fc1', 'fileChange', 'declined');
        delta('Not written.');
      }
      return done();
    }
    if (text.includes('MODE:artifact')) writeOutput('codex.txt', 'artifact');
    item('item/completed', 'cmd1', 'commandExecution', 'completed');
    const n = nextTurn(threadId);
    output({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId: 'turn-1',
        tokenUsage: { total: { inputTokens: 7 * n, outputTokens: 3 * n, totalTokens: 10 * n } },
      },
    });
    delta(`Codex fixture turn ${n}`);
    delta(`: ${markerOf(text)}`);
    done();
  };
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg.result);
      waiting.delete(msg.id);
      return;
    }
    if (msg.method === 'initialize')
      return output({ id: msg.id, result: { userAgent: 'codex-fixture' } });
    if (msg.method === 'initialized') return;
    if (msg.method === 'thread/start') {
      threadId = `codex-thread-${process.pid}-${Date.now()}`;
      return output({
        id: msg.id,
        result: { thread: { id: threadId }, model: msg.params.model ?? 'default' },
      });
    }
    if (msg.method === 'thread/resume') {
      threadId = msg.params.threadId;
      log(`resume:${threadId}`);
      return output({
        id: msg.id,
        result: { thread: { id: threadId }, model: msg.params.model ?? 'default' },
      });
    }
    if (msg.method === 'turn/start') {
      output({ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      void turn(msg.params);
      return;
    }
    if (msg.method === 'turn/interrupt') {
      clearInterval(hangTimer);
      log(`interrupt:${msg.params?.threadId}:${msg.params?.turnId}`);
      if (msg.id !== undefined) output({ id: msg.id, result: {} });
      done('interrupted');
      return;
    }
    if (msg.id !== undefined)
      output({ id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } });
  });
  process.stdin.on('end', () => clearInterval(hangTimer));
} else {
  const at = argv.indexOf('--conversation');
  const conversation = at >= 0 ? argv[at + 1] : `agy-conversation-${process.pid}-${Date.now()}`;
  if (at >= 0) log(`resume:${conversation}`);
  const model = argv.indexOf('--model');
  output({
    event: 'init',
    init: {
      tools: ['write_file'],
      permission_mode: 'request-review',
      model: model >= 0 ? argv[model + 1] : 'fixture-default',
    },
  });
  const step = (text_delta) =>
    output({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta } });
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.event !== 'user') return;
    const text = String(msg.message?.content ?? '');
    if (text.includes('MODE:hang')) return step('working...');
    if (text.includes('MODE:fail'))
      return output({
        event: 'result',
        result: {
          status: 'ERROR',
          error: 'agy fixture failure token=fixture-secret-value-123456',
          conversation_id: conversation,
        },
      });
    if (text.includes('MODE:denied'))
      process.stderr.write('Tool was soft-denied: command requires approval\n');
    if (text.includes('MODE:artifact')) writeOutput('agy.txt', 'artifact');
    output({
      event: 'step_update',
      step_update: { step_type: 'tool', tool_name: 'write_file', state: 'completed' },
    });
    const n = nextTurn(conversation);
    const parts = [`Antigravity fixture turn ${n}`, `: ${markerOf(text)}`];
    for (const part of parts) step(part);
    output({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: parts.join(''),
        conversation_id: conversation,
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    });
  });
}
