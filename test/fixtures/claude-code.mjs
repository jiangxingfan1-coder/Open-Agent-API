// Protocol-level stand-in for the Claude Code CLI as driven by @anthropic-ai/claude-agent-sdk
// (`--output-format stream-json --input-format stream-json`). It never calls a model or the
// network. Behaviour is selected by a marker in the prompt: MODE:permission (alias MODE:approval),
// MODE:fail, MODE:hang, MODE:artifact, MODE:not-logged-in (is_error with a success subtype, as
// the real CLI reports a missing login), MODE:error-secret (an error result carrying a credential).
// Sessions persist in the working directory so `--resume <id>` can be verified across processes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
// The SDK passes `--resume=<id>`; accept the two-argument form too.
const resumeIndex = argv.indexOf('--resume');
const resumed =
  argv.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length) ??
  (resumeIndex >= 0 ? argv[resumeIndex + 1] : undefined);
const statePath = path.join(process.cwd(), '.claude-fixture.json');
const log = (line) => appendFileSync(path.join(process.cwd(), '.claude-fixture.log'), `${line}\n`);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {});
const sessions = load();
const sessionId =
  resumed && sessions[resumed] !== undefined
    ? resumed
    : `claude-fixture-${process.pid}-${Date.now()}`;
sessions[sessionId] ??= 0;
log(`started:${resumed ?? 'new'}:${sessionId}`);
log(`argv:${JSON.stringify(argv)}`);

let seq = 0;
const pending = new Map();
const ask = (request) =>
  new Promise((resolve) => {
    const request_id = `fixture-${++seq}`;
    pending.set(request_id, resolve);
    send({ type: 'control_request', request_id, request });
  });
const assistant = (text) =>
  send({
    type: 'assistant',
    uuid: `uuid-${++seq}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fixture',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
// A read-only tool call, so tool activity is observable (names only reach OAA progress).
const assistantToolUse = () =>
  send({
    type: 'assistant',
    uuid: `uuid-${++seq}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fixture',
      content: [{ type: 'tool_use', id: `toolu_${seq}`, name: 'Read', input: { file_path: 'x' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
const result = (text, extra = {}) =>
  send({
    type: 'result',
    subtype: 'success',
    uuid: `uuid-${++seq}`,
    session_id: sessionId,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    total_cost_usd: 0,
    usage: { input_tokens: 9, output_tokens: 4 },
    permission_denials: [],
    ...extra,
  });

async function prompt(text) {
  const marker = /MARKER:(\S+)/.exec(text)?.[1] ?? 'none';
  log(`prompt:${text.split('\n')[0].slice(0, 80)}`);
  send({
    type: 'system',
    subtype: 'init',
    uuid: `uuid-${++seq}`,
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
  if (text.includes('MODE:fail')) {
    return result('fixture failure', {
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['fixture failure'],
    });
  }
  if (text.includes('MODE:not-logged-in'))
    return result('Not logged in · Please run /login', { is_error: true });
  if (text.includes('MODE:error-secret'))
    return result(`boom token=fixture-secret-value-123456 ${'x'.repeat(400)}`, { is_error: true });
  if (text.includes('MODE:hang')) {
    assistant('working...');
    return;
  }
  if (text.includes('MODE:permission') || text.includes('MODE:approval')) {
    const answer = await ask({
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: 'outputs/claude.txt', content: 'approved' },
      permission_suggestions: [],
    });
    const behavior = answer?.response?.response?.behavior ?? answer?.response?.behavior;
    log(`permission:${behavior}`);
    if (behavior === 'allow') {
      mkdirSync('outputs', { recursive: true });
      writeFileSync(path.join('outputs', 'claude.txt'), 'approved');
      assistant('Permission granted; file written.');
      return result('Permission granted; file written.');
    }
    assistant('Permission refused.');
    return result('Permission refused.', {
      permission_denials: [{ tool_name: 'Write', tool_use_id: 'tool_1', tool_input: {} }],
    });
  }
  if (text.includes('MODE:artifact')) {
    mkdirSync('outputs', { recursive: true });
    writeFileSync(path.join('outputs', 'claude-artifact.txt'), 'artifact');
  }
  assistantToolUse();
  sessions[sessionId] += 1;
  writeFileSync(statePath, JSON.stringify(sessions));
  const parts = [`Claude fixture turn ${sessions[sessionId]}`, `: ${marker}`];
  for (const part of parts) assistant(part);
  result(parts.join(''));
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      log(`control:${message.request?.subtype}`);
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response:
            message.request?.subtype === 'initialize'
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
    } else if (message.type === 'control_response') {
      const id = message.response?.request_id;
      pending.get(id)?.(message);
      pending.delete(id);
    } else if (message.type === 'user') {
      const content = message.message?.content;
      const text =
        typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join('');
      void prompt(text);
    }
  }
});
process.stdin.on('end', () => {
  log('stdin-closed');
  process.exit(0);
});
