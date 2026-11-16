import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1 } });
  else if (message.method === 'session/new' || message.method === 'model/list')
    send({ id: message.id, error: { code: -32000, message: 'Provider-specific failure' } });
});
