// Local Agent Client Protocol (v1) fixture for Open Agent API tests.
// It speaks JSON-RPC 2.0 over stdio only, never calls a model and never uses the network.
// Behaviour is selected by the first argument (or per turn by a MODE:<name> prompt marker);
// protocol observations are appended to .acp-fixture.log in the working directory so tests can
// assert what the client sent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'stream';
const statePath = path.join(process.cwd(), '.acp-fixture.json');
const log = (line) => appendFileSync(path.join(process.cwd(), '.acp-fixture.log'), `${line}\n`);
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const say = (sessionId, text, kind = 'agent_message_chunk') =>
  update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });
const load = () =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { sessions: {} };
const save = (state) => writeFileSync(statePath, JSON.stringify(state));

let seq = 0;
let model = 'fixture-small';
const outgoing = new Map();
const prompts = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `fixture-${++seq}`;
    outgoing.set(id, resolve);
    send({ id, method, params });
  });
const modelOption = () => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: model,
  options: [
    {
      group: 'fixture',
      name: 'Fixture models',
      options: [
        { value: 'fixture-small', name: 'Small' },
        { value: 'fixture-large', name: 'Large' },
      ],
    },
  ],
});

if (mode === 'garbage') process.stdout.write('this is not a JSON-RPC message\n');
if (mode === 'stubborn') {
  // Ignore EOF and SIGTERM and keep the event loop alive: only SIGKILL can stop this agent.
  process.on('SIGTERM', () => log('sigterm-ignored'));
  setInterval(() => {}, 1_000);
}
log(`started:${mode}:${process.pid}`);

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
  if (mode !== 'stubborn') process.exit(0);
});

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = outgoing.get(message.id);
    outgoing.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => send({ id, result });
  const error = (code, text) => send({ id, error: { code, message: text } });
  if (method === 'initialize') {
    log(
      `initialize:${params.protocolVersion}:fs=${params.clientCapabilities?.fs?.readTextFile}/${params.clientCapabilities?.fs?.writeTextFile}:terminal=${params.clientCapabilities?.terminal}:client=${params.clientInfo?.name}`,
    );
    if (mode === 'silent') return;
    return reply({
      protocolVersion: mode === 'version2' ? 2 : 1,
      agentCapabilities: {
        loadSession: mode !== 'noload',
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [{ id: 'fixture-login', name: 'Fixture login' }],
      agentInfo: { name: 'oaa-acp-fixture', version: '1.0.0' },
    });
  }
  if (method === 'session/new') {
    log(`session/new:${params.cwd}:mcp=${params.mcpServers?.length}`);
    if (mode === 'auth') return error(-32000, 'Authentication required');
    const sessionId = `fixture-session-${process.pid}-${Date.now()}`;
    const state = load();
    state.sessions[sessionId] = [];
    save(state);
    // Pre-prompt chatter that must not become task output.
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    say(sessionId, 'NOT-PART-OF-THE-TURN');
    return reply({ sessionId, ...(mode === 'models' ? { configOptions: [modelOption()] } : {}) });
  }
  if (method === 'session/load') {
    const history = load().sessions[params.sessionId];
    log(`session/load:${params.sessionId}:${params.cwd}`);
    if (!history) return error(-32002, 'Session not found');
    // Replayed history arrives before the response and must not be duplicated into new output.
    for (const turn of history) {
      say(params.sessionId, turn.user, 'user_message_chunk');
      say(params.sessionId, turn.agent);
    }
    return reply({});
  }
  if (method === 'session/set_config_option') {
    if (params.configId !== 'model' || !['fixture-small', 'fixture-large'].includes(params.value))
      return error(-32602, 'Unknown configuration value');
    model = params.value;
    log(`model:${model}`);
    return reply({ configOptions: [modelOption()] });
  }
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/cancel') {
    log(`cancel:${params.sessionId}`);
    prompts.get(params.sessionId)?.();
    return;
  }
  if (id !== undefined) error(-32601, `Method not found: ${method}`);
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const input = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
  log(`prompt:${input.split('\n')[0]}`);
  const reply = (result) => send({ id, result });
  // A `MODE:<name>` marker in the prompt overrides the process mode for this turn, so one
  // configured adapter can exercise every behaviour (used by the conformance matrix).
  const requested = /MODE:([a-z-]+)/.exec(input)?.[1];
  const turnMode =
    requested === 'approval'
      ? 'permission'
      : requested && requested !== 'artifact'
        ? requested
        : mode;
  if (requested === 'artifact') {
    mkdirSync('outputs', { recursive: true });
    writeFileSync(path.join('outputs', 'acp.txt'), 'artifact');
  }
  if (turnMode === 'fail')
    return send({
      id,
      error: { code: -32603, message: 'fixture failure token=fixture-secret-value-123456' },
    });
  if (turnMode === 'crash') {
    process.stderr.write('fixture crashed on purpose\n');
    process.exit(3);
  }
  if (turnMode === 'refusal') {
    say(sessionId, 'I refuse.');
    return reply({ stopReason: 'refusal' });
  }
  if (turnMode === 'hang' || turnMode === 'stubborn') {
    say(sessionId, 'working...');
    if (turnMode === 'stubborn') return;
    await new Promise((resolve) => prompts.set(sessionId, resolve));
    log('cancel-acknowledged');
    return reply({ stopReason: 'cancelled' });
  }
  if (turnMode === 'permission' || turnMode === 'permission-always') {
    const toolCall = {
      toolCallId: 'call-1',
      title: 'Write outputs/approved.txt',
      kind: 'edit',
      rawInput: { path: 'outputs/approved.txt', content: 'approved' },
      locations: [{ path: 'outputs/approved.txt' }],
    };
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
    const options =
      turnMode === 'permission-always'
        ? [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ]
        : [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ];
    const answer = await ask('session/request_permission', { sessionId, toolCall, options });
    const outcome = answer.result?.outcome;
    log(`permission:${outcome?.outcome}:${outcome?.optionId ?? ''}`);
    if (outcome?.outcome === 'selected' && outcome.optionId === 'once') {
      mkdirSync('outputs', { recursive: true });
      writeFileSync(path.join('outputs', 'approved.txt'), 'approved');
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      });
      say(sessionId, 'Permission granted; file written.');
    } else {
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'failed',
      });
      say(sessionId, 'Permission refused; nothing written.');
    }
    return reply({ stopReason: 'end_turn' });
  }
  const state = load();
  const history = state.sessions[sessionId] ?? [];
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'PRIVATE-THOUGHT' },
  });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'read-1',
    title: 'Read input',
    kind: 'read',
    status: 'in_progress',
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'read-1',
    status: 'completed',
  });
  update(sessionId, {
    sessionUpdate: 'plan',
    entries: [{ content: 'Answer', priority: 'high', status: 'completed' }],
  });
  const marker = /MARKER:(\S+)/.exec(input)?.[1] ?? 'none';
  const parts = [
    `ACP fixture turn ${history.length + 1}`,
    ` (model ${mode === 'models' ? model : 'default'})`,
    `: ${marker}`,
  ];
  for (const part of parts) say(sessionId, part);
  update(sessionId, { sessionUpdate: 'usage_update', used: 1234, size: 200000 });
  history.push({ user: input, agent: parts.join('') });
  state.sessions[sessionId] = history;
  save(state);
  return reply({
    stopReason: 'end_turn',
    ...(turnMode === 'zero-usage'
      ? { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      : mode === 'stream'
        ? { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }
        : {}),
  });
}
