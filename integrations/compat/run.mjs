#!/usr/bin/env node
// Compatibility lab launcher (`npm run compat`).
//
// Starts an isolated gateway on 127.0.0.1 (random port, temporary data directory, offline sample agent
// plus a deterministic fixture-model agent, one generated caller key), runs every client script against
// it, replays the recorded request shapes of chat clients that cannot run here, writes the matrix and
// stops the gateway. It never calls a model service and never touches machine-wide settings.
//
//   node integrations/compat/run.mjs [--out DIR] [--only ID,ID] [--timeout SECONDS] [--strict] [--list]
//
// Output: DIR/matrix.json (machine readable), DIR/matrix.md (summary). Exit code 1 if any scenario failed
// (with --strict also if any client was skipped, e.g. a missing package: CI must not pass on a half-run lab).
// Python: COMPAT_PYTHON, else integrations/compat/.venv/bin/python, else python3 (packages from requirements.txt).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENTS } from './clients.mjs';
import { startLabGateway } from './lib/gateway.mjs';
import { buildMatrix, renderMarkdown } from './lib/report.mjs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = path.resolve(option('--out') ?? path.join(HERE, 'out'));
const only = option('--only')?.split(',').filter(Boolean);
const timeoutMs = Number(option('--timeout') ?? 240) * 1000;
const strict = args.includes('--strict');

function pythonPath() {
  if (process.env.COMPAT_PYTHON) return process.env.COMPAT_PYTHON;
  const venv = path.join(HERE, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

/** Runs one client script; returns the parsed result lines plus how the process ended. */
function runScript(client, gateway) {
  const command = client.runtime === 'python' ? pythonPath() : process.execPath;
  return new Promise((resolve) => {
    const child = spawn(command, [path.join(HERE, client.script)], {
      cwd: HERE,
      env: {
        ...process.env,
        // Lab-only: the loopback gateway must never go through a proxy (child processes only).
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        OAA_BASE_URL: gateway.baseUrl,
        OAA_API_KEY: gateway.apiKey,
        OAA_AGENT_FIXTURE: gateway.agents.fixture,
        OAA_AGENT_SAMPLE: gateway.agents.sample,
        OAA_AGENT_NATIVE: gateway.agents.native,
        OAA_AGENT_ACP: gateway.agents.acp,
        OAA_AGENT_TEXT: gateway.agents.textOnly,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => resolve({ records: [], done: false, err: String(e), code: -1 }));
    child.on('close', (code) => {
      clearTimeout(timer);
      const records = [];
      let done = false;
      for (const line of out.split('\n')) {
        if (line.startsWith('@@COMPAT-DONE')) done = true;
        else if (line.startsWith('@@COMPAT '))
          try {
            records.push(JSON.parse(line.slice(9)));
          } catch {
            // ignore a damaged line
          }
      }
      resolve({ records, done, err: err.trim().split('\n').slice(-6).join(' | '), code });
    });
  });
}

/**
 * A disconnected client does not cancel an accepted run (docs/protocol.md), so scenarios that abandon a
 * SLOW request leave it running. Cancel what is still active so the next client starts on a quiet gateway.
 */
async function cancelActiveRuns(gateway) {
  const headers = { authorization: `Bearer ${gateway.apiKey}`, 'content-type': 'application/json' };
  const { data = [] } = await (await fetch(`${gateway.baseUrl}/v1/runs?limit=200`, { headers })).json();
  const active = data.filter((r) => !['completed', 'failed', 'cancelled', 'incomplete'].includes(r.status));
  await Promise.all(active.map((r) => fetch(`${gateway.baseUrl}/v1/responses/${r.id}/cancel`, { method: 'POST', headers })));
  return active.length;
}

async function liveClient(client, gateway) {
  if (!existsSync(path.join(HERE, client.script)))
    return { ...base(client, 'live'), scenarios: { '*': { status: 'skip', detail: 'script not written yet' } } };
  const { records, done, err, code } = await runScript(client, gateway);
  const scenarios = {};
  let version = '';
  for (const r of records) {
    version = r.version || version;
    scenarios[r.scenario] = { status: r.status, detail: r.detail, ms: r.ms ?? 0 };
  }
  if (!done) {
    // The script crashed or timed out before finishing: that is a failure of the client, not a skip.
    scenarios['(script)'] = {
      status: 'fail',
      detail: `script ended without finishing (exit ${code}): ${err || 'no output'}`.slice(0, 600),
    };
  }
  if (scenarios['*']?.status === 'skip' && Object.keys(scenarios).length === 1) delete scenarios['(script)'];
  return { ...base(client, 'live'), version, scenarios };
}

const base = (client, kind) => ({
  id: client.id,
  label: client.label,
  kind,
  group: client.group,
  runtime: client.runtime,
});

/** Real-socket transport for the replay engine (node:http: no browser header restrictions). */
function socketTransport(baseUrl) {
  const url = new URL(baseUrl);
  return (request) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: url.hostname, port: url.port, method: request.method, path: request.path, headers: request.headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const headers = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('replay request timed out')));
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
}

async function replayClients(replay, files, gateway) {
  const results = [];
  const transport = socketTransport(gateway.baseUrl);
  for (const file of files) {
    const scenarios = {};
    for (const c of file.cases) {
      const evidence = c.evidence.status;
      if (replay.outOfScope(c)) {
        scenarios[c.id] = { status: 'na', detail: `${c.request.path} is not served by the gateway`, evidence };
        continue;
      }
      try {
        const r = await replay.runReplayCase(c, transport, {
          AGENT: gateway.agents.fixture,
          NATIVE: gateway.agents.native,
          KEY: gateway.apiKey,
        });
        scenarios[c.id] = {
          status: r.ok ? 'pass' : 'fail',
          detail: r.ok ? (r.ignored ? `ignored params: ${r.ignored}` : '') : r.problems.join('; '),
          evidence,
        };
      } catch (error) {
        scenarios[c.id] = { status: 'fail', detail: String(error), evidence };
      }
    }
    results.push({
      id: `replay-${file.client}`,
      label: file.label,
      kind: 'replay',
      group: 'chat-client',
      runtime: 'replay',
      version: file.version.slice(0, 60),
      note: `evidence: ${file.overall}`,
      scenarios,
    });
  }
  return results;
}

async function main() {
  if (args.includes('--list')) {
    for (const c of CLIENTS) console.log(`${c.id}\t${c.runtime}\t${c.script}`);
    return 0;
  }
  if (!existsSync(path.join(REPO, 'dist', 'src', 'gateway', 'server.js'))) {
    console.error('compat: dist/ is missing. Run `npm run build` first (npm run compat does it).');
    return 2;
  }
  const replay = await import(pathToFileURL(path.join(REPO, 'dist', 'test', 'compat-replay.js')).href);
  const replayFiles = await replay.loadReplayFiles(path.join(HERE, 'replays'));
  const selected = (id) => !only || only.some((o) => id === o || id.startsWith(o));
  const gateway = await startLabGateway({ allowedOrigins: replay.replayOrigins(replayFiles) });
  console.log(`compat: gateway on ${gateway.baseUrl} (isolated, offline)`);
  const results = [];
  try {
    for (const client of CLIENTS) {
      if (!selected(client.id)) continue;
      const started = Date.now();
      const r = await liveClient(client, gateway);
      results.push(r);
      const abandoned = await cancelActiveRuns(gateway);
      if (abandoned) r.note = `${abandoned} run(s) left running by the client were cancelled afterwards`;
      const counts = Object.values(r.scenarios).reduce((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
      console.log(`compat: ${client.id} ${JSON.stringify(counts)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
    const wanted = replayFiles.filter((f) => selected(`replay-${f.client}`) || selected('replay'));
    if (wanted.length) results.push(...(await replayClients(replay, wanted, gateway)));
  } finally {
    await gateway.stop();
  }
  const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
  const matrix = buildMatrix(results, {
    generatedAt: new Date().toISOString(),
    gateway: { version: pkg.version },
    node: process.version,
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  await writeFile(path.join(outDir, 'matrix.md'), renderMarkdown(matrix) + '\n');
  const s = matrix.summary;
  console.log(`compat: ${s.pass} pass, ${s.fail} fail, ${s.na} n/a, ${s.skip} skipped -> ${path.join(outDir, 'matrix.json')}`);
  return s.fail > 0 || (strict && s.skip > 0) ? 1 : 0;
}

process.exitCode = await main();
