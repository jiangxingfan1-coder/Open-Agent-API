import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [base, tokenFile, engine, modelList, output] = process.argv.slice(2);
if (
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? '') ||
  !tokenFile ||
  !engine ||
  !modelList ||
  !output
)
  throw new Error(
    'Usage: live-intelligence-modes <isolated-loopback-url> <token-file> <engine> <model1,model2> <new-report-directory>',
  );
const token = (await readFile(tokenFile, 'utf8')).trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const models = modelList.split(',');
const agent = 'agent/live-intelligence';
const request = async (endpoint, body) => {
  const r = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  return { status: r.status, body: await r.json() };
};
const published = await request('/v1/agents/publish-native', {
  id: agent,
  engine,
  models,
  access: { modes: ['managed'], defaultMode: 'managed', approval: 'auto', trust: 'private' },
  orchestration: { enabled: true, scope: 'agent', maxStages: 8, timeoutMs: 180000 },
});
if (published.status !== 200)
  throw new Error(`Publication failed: ${published.status} ${published.body.error?.code}`);
const report = { started: new Date().toISOString(), engine, models, cases: [] };
for (const mode of ['fixed', 'recommend', 'speed', 'quality']) {
  const started = Date.now();
  const result = await request('/v1/responses', {
    model: mode === 'fixed' ? `${agent}@${models[0]}` : agent,
    input:
      'Without using tools, calculate 17 * 23 and respond with exactly 391. Do not inspect files or access the network.',
    metadata: {
      'oaa.routing_strategy': mode === 'quality' ? 'quality' : 'speed',
      ...(mode === 'recommend' ? { 'oaa.orchestration_action': 'recommend' } : {}),
    },
  });
  const text = (result.body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  let ok = result.status === 200 && result.body.status === 'completed' && text === '391';
  if (mode === 'recommend') {
    try {
      ok = result.status === 200 && JSON.parse(text).executed === false;
    } catch {
      ok = false;
    }
  }
  const row = {
    mode,
    ok,
    status: result.status,
    elapsedMs: Date.now() - started,
    selectedModel: result.body.metadata?.['oaa.selected_model'],
    review: result.body.metadata?.['oaa.review'],
    ...(result.body.error ? { error: result.body.error.code } : {}),
  };
  report.cases.push(row);
  console.log(JSON.stringify(row));
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'modes-result.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
process.exitCode = report.cases.every((row) => row.ok) ? 0 : 1;
