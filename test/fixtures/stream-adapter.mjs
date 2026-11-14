// oaa/1 adapter fixture for both ABIs, no model or network:
// - `oaa/1-stream` (request has `stream: true`): NDJSON in both directions; deltas, progress,
//   approvals and cooperative cancel.
// - legacy `oaa/1`: one request on stdin, then EOF; exactly one result document on stdout.
// Modes come from the task text: MODE:approval, MODE:hang, MODE:fail, MODE:artifact
// (default: an answer whose turn number comes from previous_state).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const log = (line) => appendFileSync(path.join(process.cwd(), '.stream-adapter.log'), `${line}\n`);
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let request;
let streaming = false;
// Legacy adapters may only print the final result document.
const send = (value) => {
  if (streaming) write(value);
};
const waiting = new Map();
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
    if (!request) {
      request = message;
      streaming = request.stream === true;
      void run();
    } else if (message.type === 'approval_result') {
      waiting.get(message.id)?.(message.decision);
    } else if (message.type === 'cancel') {
      log('cancel');
      result('', {}, 'incomplete', 'cancelled');
      process.stdin.destroy();
    }
  }
});

function result(output_text, state = {}, status = 'completed', error) {
  write({
    protocol: 'oaa/1',
    type: 'result',
    status,
    output_text,
    state,
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    ...(error ? { error } : {}),
  });
}
const output = (name, content) => {
  mkdirSync(path.join(request.workspace, 'outputs'), { recursive: true });
  writeFileSync(path.join(request.workspace, 'outputs', name), content);
};

async function run() {
  const input = String(request.input ?? '');
  log(`request:${streaming}:${request.session_id}`);
  if (input.includes('MODE:fail'))
    return result('', {}, 'failed', 'fixture adapter failure token=fixture-secret-value-123456');
  if (input.includes('MODE:hang')) {
    send({ type: 'delta', text: 'working...' });
    // A legacy adapter cannot be told to stop; only the host terminating it ends the turn.
    if (!streaming) setInterval(() => {}, 1_000);
    return;
  }
  if (input.includes('MODE:approval') && streaming) {
    send({ type: 'progress', event: 'tool', tool: 'write_note', status: 'pending' });
    send({
      type: 'approval',
      id: 'a1',
      title: 'Write outputs/stream.txt',
      kind: 'edit',
      input: { path: 'outputs/stream.txt' },
    });
    const decision = await new Promise((resolve) => waiting.set('a1', resolve));
    log(`approval:${decision}`);
    if (decision === 'approve') {
      output('stream.txt', 'approved');
      send({ type: 'delta', text: 'Approved and written.' });
      return result('Approved and written.');
    }
    send({ type: 'delta', text: 'Not written.' });
    return result('Not written.', {}, 'completed');
  }
  if (input.includes('MODE:artifact')) output('adapter.txt', 'artifact');
  const turn = Number(request.previous_state?.turn ?? 0) + 1;
  const marker = /MARKER:(\S+)/.exec(input)?.[1] ?? 'none';
  send({ type: 'progress', event: 'tool', tool: 'lookup', status: 'completed' });
  const parts = [`Adapter turn ${turn}`, `: ${marker}`];
  for (const part of parts) send({ type: 'delta', text: part });
  result(parts.join(''), { turn });
}
