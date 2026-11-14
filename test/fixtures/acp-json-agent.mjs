// ACP (v1) fixture for structured-output tests: it answers with scripted text, never calls a model
// and never uses the network. The first argument picks the script:
//   bad-then-good  first prompt: prose that is not JSON; a "[Structured output repair]" prompt: {"ok":true}
//   always-bad     every prompt: prose that is not JSON
//   good           every prompt: a JSON object wrapped in a code fence and a sentence
//   noload         like bad-then-good, but the agent cannot load a session (cannot be continued)
// Every prompt it receives is appended to .acp-json.log in the working directory.
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'bad-then-good';
const log = (line) => appendFileSync(path.join(process.cwd(), '.acp-json.log'), `${line}\n`);
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

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

function handle({ id, method, params = {} }) {
  const reply = (result) => send({ id, result });
  if (method === 'initialize')
    return reply({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: mode !== 'noload',
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
      agentInfo: { name: 'oaa-json-fixture', version: '1.0.0' },
    });
  if (method === 'session/new') return reply({ sessionId: `json-${process.pid}-${Date.now()}` });
  if (method === 'session/load') return reply({});
  if (method === 'session/prompt') {
    const input = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const repair = input.includes('[Structured output repair]');
    log(`${repair ? 'repair' : 'prompt'}:${input.slice(0, 80).replace(/\n/g, ' ')}`);
    const text =
      mode === 'good'
        ? 'Sure, here it is:\n```json\n{"ok": true}\n```\nAnything else?'
        : repair && mode !== 'always-bad'
          ? '{"ok":true}'
          : 'I have finished the task but forgot the JSON.';
    say(params.sessionId, text);
    return reply({ stopReason: 'end_turn' });
  }
  if (id !== undefined)
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}
