let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(
  JSON.stringify({
    protocol: 'oaa/1',
    type: 'result',
    status: 'completed',
    output_text: `Custom adapter received ${request.model}: ${request.input}`,
    state: { session: request.session_id },
    usage: null,
  }) + '\n',
);
