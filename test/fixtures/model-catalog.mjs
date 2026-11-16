import { createInterface } from 'node:readline';
if (process.argv.includes('models')) {
  process.stdout.write(
    process.argv.includes('many')
      ? Array.from({ length: 404 }, (_, i) => `catalog-${i}\tCatalog ${i}\n`).join('')
      : 'discovered-one\tFirst discovered model\ndiscovered-two\tSecond discovered model\n',
  );
} else {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.event === 'user') {
      process.stdout.write(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: 'discovered model executed',
            conversation_id: 'fixture-session',
          },
        }) + '\n',
      );
      process.exit(0);
    }
  });
  const at = process.argv.indexOf('--model');
  process.stdout.write(
    JSON.stringify({
      event: 'init',
      init: { model: at >= 0 ? process.argv[at + 1] : 'discovered-one', tools: [] },
    }) + '\n',
  );
}
