import readline from 'node:readline';
const args = process.argv.slice(2);
const mode = args[0];
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin });
if (mode === 'agy-tool-free') {
  const at = args.indexOf('--settings');
  const settings = at >= 0 ? JSON.parse(args[at + 1]) : {};
  if (
    settings.toolPermission !== 'strict' ||
    !['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)'].every((rule) =>
      settings.permissions?.deny?.includes(rule),
    )
  ) {
    process.stderr.write('Missing tool-free permission policy');
    process.exit(1);
  }
}
if (mode?.startsWith('agy')) {
  const index = args.indexOf('--model');
  output({
    event: 'init',
    init: {
      tools: [],
      permission_mode: mode === 'agy-tool-free' ? 'strict' : 'request-review',
      ...(mode === 'agy-no-model'
        ? {}
        : {
            model:
              mode === 'agy-wrong-model'
                ? 'different-model'
                : index >= 0
                  ? args[index + 1]
                  : 'fixture-default',
          }),
    },
  });
}
if (mode === 'dsh') {
  process.stdout.write('DSH fixture final output\n');
  input.close();
} else
  input.on('line', (line) => {
    const message = JSON.parse(line);
    if (mode === 'codex') {
      if (message.method === 'initialize')
        output({ id: message.id, result: { userAgent: 'fixture' } });
      if (message.method === 'thread/start' || message.method === 'thread/resume')
        output({
          id: message.id,
          result: { thread: { id: 'fixture-thread' }, model: message.params.model ?? 'default' },
        });
      if (message.method === 'turn/start') {
        output({ id: message.id, result: { turn: { id: 'fixture-turn', status: 'inProgress' } } });
        output({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'fixture-thread',
            turnId: 'fixture-turn',
            itemId: 'message',
            delta: 'Codex fixture output',
          },
        });
        output({
          method: 'turn/completed',
          params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } },
        });
      }
    } else if (message.event === 'user' && typeof message.message?.content === 'string') {
      if (mode === 'agy-denied')
        process.stderr.write('Tool was soft-denied: command requires approval\n');
      output({
        event: 'step_update',
        step_update: { step_type: 'agent_response', text_delta: 'Antigravity fixture output' },
      });
      output({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Antigravity fixture output',
          conversation_id: 'fixture-conversation',
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        },
      });
    } else if (mode?.startsWith('agy')) {
      process.stderr.write('Invalid stream input: expected event=user with message.content.\n');
      process.exitCode = 1;
      input.close();
    }
  });
