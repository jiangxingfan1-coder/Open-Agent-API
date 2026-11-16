import { createInterface } from 'node:readline';
let selected = 'family-medium';
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize')
    return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new')
    return send({
      id: m.id,
      result: {
        sessionId: 'dual-model-session',
        models: {
          currentModelId: selected,
          availableModels: [
            { modelId: 'family-low', name: 'Family Low' },
            { modelId: 'family-medium', name: 'Family Medium' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'family',
            options: [{ value: 'family', name: 'Family' }],
          },
        ],
      },
    });
  if (m.method === 'session/set_model') {
    selected = m.params.modelId;
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/prompt') {
    send({
      method: 'session/update',
      params: {
        sessionId: 'dual-model-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Selected ${selected}` },
        },
      },
    });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined)
    send({ id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
