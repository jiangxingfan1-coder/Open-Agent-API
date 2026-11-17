import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [base, tokenFile, agent, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? '') || !tokenFile || !agent || !output)
  throw new Error('Use an isolated loopback gateway, token file, agent and new report directory.');
const token = (await readFile(tokenFile, 'utf8')).trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const request = async (method, endpoint, body) => {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${value.error?.code}`);
  return value;
};
const view = () => request('GET', `/v1/local/evaluations?agent=${encodeURIComponent(agent)}`);
const initial = await view();
if (initial.settings.enabled || initial.running || initial.routes.length !== 1)
  throw new Error('Use a single-model test agent with evaluation disabled and idle.');
await mkdir(output, { recursive: false });
const report = { started: new Date().toISOString(), agent, suite: initial.suite };
try {
  await request('POST', '/v1/local/evaluations/settings', {
    agent,
    revision: initial.settings_revision,
    settings: { enabled: true, intervalHours: 24, maxCallsPerDay: 8 },
  });
  const deadline = Date.now() + 18 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const current = await view();
    console.log(JSON.stringify({ running: current.running, routes: current.routes }));
    if (!current.running) {
      report.result = current;
      break;
    }
  }
  if (!report.result) throw new Error('Evaluation did not settle before the probe deadline.');
  report.complete = report.result.routes[0]?.performance?.samples === 8;
  if (!report.complete) process.exitCode = 1;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  const current = await view();
  await request('POST', '/v1/local/evaluations/settings', {
    agent,
    revision: current.settings_revision,
    settings: initial.settings,
  });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
}
