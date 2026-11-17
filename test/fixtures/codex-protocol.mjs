import readline from 'node:readline';
const mode = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const context = { threadId: 'thread', turnId: 'turn' };
const notify = (method, params) => send({ method, params: { ...context, ...params } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === 'elicitation' && !m.method) {
    if (m.result?.action !== 'accept') process.exit(1);
    notify('item/agentMessage/delta', { itemId: 'message', delta: 'OK' });
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    return;
  }
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (
      mode === 'auto-policy' &&
      (m.params.approvalPolicy !== 'never' || m.params.sandbox !== 'danger-full-access')
    ) {
      send({ id: m.id, error: { code: -1, message: 'Automatic policy was not forwarded' } });
      return;
    }
    if (mode === 'rpc-error') send({ id: m.id, error: { code: -1, message: 'model unavailable' } });
    else
      send({
        id: m.id,
        result: {
          thread: { id: 'thread' },
          model: mode === 'wrong-model' ? 'other' : m.params.model,
        },
      });
  }
  if (m.method !== 'turn/start') return;
  // Actual app-server notifications may precede the turn/start response.
  notify('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  send({ id: m.id, result: { turn: { id: 'turn' } } });
  if (mode === 'elicitation') {
    send({
      id: 'elicitation',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread', serverName: 'fixture', turnId: null },
    });
    return;
  }
  notify('item/agentMessage/delta', { threadId: 'foreign', delta: 'LEAK' });
  notify('item/agentMessage/delta', { turnId: 'old-turn', delta: 'STALE' });
  notify('turn/completed', { threadId: 'foreign', turn: { id: 'turn', status: 'completed' } });
  send({
    id: 'foreign-approval',
    method: 'item/commandExecution/requestApproval',
    params: { ...context, threadId: 'foreign' },
  });
  if (mode !== 'snapshot') notify('item/agentMessage/delta', { itemId: 'message', delta: 'OK' });
  notify('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'OK' } });
  notify('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
  });
  notify('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
  });
  notify('turn/completed', {
    turn: {
      id: 'turn',
      status: mode === 'failed' ? 'failed' : 'completed',
      error: { message: 'upstream overloaded' },
    },
  });
  if (mode === 'linger') setInterval(() => {}, 1000);
  if (mode === 'early-exit') setTimeout(() => process.exit(0), 0);
});
