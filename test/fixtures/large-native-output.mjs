import { writeFile } from 'node:fs/promises';

for await (const _ of process.stdin) {
  // Consume the single stdio invocation before writing the worker-local output.
}
await writeFile('outputs/report.bin', Buffer.alloc(12 * 1024 * 1024, 55));
console.log(
  JSON.stringify({
    protocol: 'oaa/1',
    type: 'result',
    status: 'completed',
    output_text: 'report ready',
  }),
);
