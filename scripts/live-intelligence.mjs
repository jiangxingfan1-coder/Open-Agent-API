import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [base, tokenFile, output] = process.argv.slice(2);
if (!base || !tokenFile || !output || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error('Use a dedicated loopback gateway, token file and output directory.');
const token = (await readFile(tokenFile, 'utf8')).trim();
const report = { started: new Date().toISOString(), cases: [] };
for (const engine of ['codex', 'claude', 'antigravity']) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(150_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `agent/live-${engine}@default`,
        messages: [
          {
            role: 'user',
            content: 'Do not use tools. Reply with exactly OAA_LIVE_OK and nothing else.',
          },
        ],
      }),
    });
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    report.cases.push({
      engine,
      status: response.status,
      ok: response.ok && answer === 'OAA_LIVE_OK',
      elapsedMs: Date.now() - started,
      ...(data.error ? { error: data.error.code } : {}),
    });
  } catch (error) {
    report.cases.push({ engine, ok: false, elapsedMs: Date.now() - started, error: error.name });
  }
  console.log(JSON.stringify(report.cases.at(-1)));
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'live-result.json'), JSON.stringify(report, null, 2), {
  flag: 'wx',
  mode: 0o600,
});
process.exitCode = report.cases.every((c) => c.ok) ? 0 : 1;
