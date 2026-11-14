import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setup, researchFixture, researchBundle } from '../test/helpers.js';

const demo = await setup(researchFixture());
try {
  demo.store.publish('owner', researchBundle());
  const fileIds = [];
  for (const [name, text] of [
    ['scope.txt', 'The platform exposes registered agents through one API.'],
    ['routing.txt', 'A continuing session keeps its selected model route.'],
    [
      'evidence.txt',
      'This demonstration uses a deterministic local model fixture, not a live provider.',
    ],
  ]) {
    const file = await demo.store.addFile('owner', name!, Buffer.from(text!));
    fileIds.push(file.id);
  }
  const response = await demo.request('POST', '/v1/invoke', {
    protocol: 'oaa/1',
    agent: 'agent/research',
    input: 'Produce a source-grounded report using the supplied skill and files.',
    file_ids: fileIds,
  });
  const body = response.json();
  if (body.status !== 'completed') throw new Error(JSON.stringify(body));
  const run = demo.store.run(body.id);
  const result = await demo.store.filePayload(run.artifactIds[0]!, 'owner');
  const out = path.resolve('.oaa-demo');
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writeFile(path.join(out, 'report.md'), Buffer.from(result.content, 'base64'), {
    mode: 0o600,
  });
  const receipt = {
    model_evidence: 'deterministic_fixture',
    live_model_called: false,
    run: run.id,
    status: run.status,
    steps: demo.store
      .steps(run.id)
      .map((s) => ({ name: s.name, status: s.status, node: s.nodeId })),
    artifact: path.join(out, 'report.md'),
    sha256: result.sha256,
  };
  await writeFile(path.join(out, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
} finally {
  await demo.cleanup();
}
