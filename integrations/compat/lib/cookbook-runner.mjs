// Runs the cookbook scenarios (../cookbook.mjs) of one runtime against the lab gateway.
//
// The examples are copied to a temporary directory first and run from there, exactly as a user runs them from
// their own folder: the copy gets a `node_modules` link to the lab's packages (so `import 'openai'` resolves), and
// nothing is written inside the repository. The child processes see the same environment variables a user sets.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, runtimeOf, scenarioId } from '../cookbook.mjs';
import { check, createLab, env, makeKey, NotApplicable } from './harness.mjs';

const LAB = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(LAB, '..', '..');
const SOURCE = path.join(REPO, 'examples', 'cookbook');
const TIMEOUT_MS = 90_000;

function pythonPath() {
  if (process.env.COMPAT_PYTHON) return process.env.COMPAT_PYTHON;
  const venv = path.join(LAB, '.venv', process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
  return existsSync(venv) ? venv : 'python3';
}

/** Runs a command, resolves { code, out } (stdout and stderr together); never rejects. */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (error) => resolve({ code: -1, out: String(error) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** @param {'python' | 'node' | 'shell'} runtime */
export async function runCookbook(clientId, runtime) {
  const scenarios = SCENARIOS.filter((scenario) => runtimeOf(scenario.file) === runtime);
  const lab = createLab(clientId, '');
  if (runtime === 'python') {
    const probe = await run(pythonPath(), ['-c', 'import openai, anthropic, google.genai'], { cwd: LAB });
    if (probe.code !== 0) {
      lab.skip(`the lab's Python lacks openai, anthropic or google-genai (pip install -r integrations/compat/requirements.txt in a virtual environment): ${probe.out.trim().split('\n').pop()}`);
      return lab.done();
    }
  }
  if (runtime === 'node' && !existsSync(path.join(LAB, 'node_modules', 'openai'))) {
    lab.skip('integrations/compat/node_modules is missing (npm ci --prefix integrations/compat)');
    return lab.done();
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'oaa-cookbook-'));
  try {
    const dir = path.join(work, 'cookbook');
    await cp(SOURCE, dir, { recursive: true });
    if (existsSync(path.join(LAB, 'node_modules'))) await symlink(path.join(LAB, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    // The examples get a key of their own: they make hundreds of requests (polling included), and the lab key's
    // requests-per-minute budget (600) is shared with every other client and replay of the lab.
    const apiKey = await makeKey({ agents: ['*'], scopes: ['admin', 'invoke', 'read', 'files', 'approve'], quota: { rpm: 20_000 } });
    const agents = { fixture: env.fixture, sample: env.sample, textOnly: env.textOnly, native: env.native };
    const fill = (value) => value.replaceAll('{BASE}', env.baseUrl).replaceAll('{KEY}', apiKey);
    const tail = (text) => text.trim().split('\n').slice(-4).join(' | ').slice(0, 400);
    const runScenario = async (scenario) => {
      if (runtime === 'shell' && process.platform === 'win32') throw new NotApplicable('the shell examples need a POSIX shell');
      const childEnv = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
      for (const name of ['OAA_PROMPT', 'OAA_LONG_PROMPT', 'OAA_ADMIN_KEY']) delete childEnv[name];
      Object.assign(childEnv, { OAA_BASE_URL: env.baseUrl, OAA_API_KEY: apiKey, OAA_AGENT: agents[scenario.agent] });
      for (const [name, value] of Object.entries(scenario.env)) childEnv[name] = fill(value);
      const file = path.join(dir, scenario.file);
      // `python -I` ignores PYTHON* variables and the script directory: the examples must not depend on either.
      const [command, prefix] = runtime === 'python' ? [pythonPath(), ['-I']] : runtime === 'node' ? [process.execPath, []] : ['/bin/sh', []];
      const result = await run(command, [...prefix, file, ...scenario.args], { cwd: dir, env: childEnv });
      check(result.code === scenario.exit, `exit ${result.code}, expected ${scenario.exit}. Output tail: ${tail(result.out)}`);
      for (const pattern of scenario.expect) check(pattern.test(result.out), `output does not match ${pattern}. Output tail: ${tail(result.out)}`);
      return `exit ${result.code}; ${result.out.trim().split('\n').filter(Boolean).slice(-2).join(' | ')}`.slice(0, 300);
    };
    // A few at a time: Node examples end only when the SDK's keep-alive sockets close (a few seconds each), and the
    // examples are independent of one another.
    const queue = [...scenarios];
    const worker = async () => {
      for (let scenario = queue.shift(); scenario; scenario = queue.shift()) await lab.scenario(scenarioId(scenario), () => runScenario(scenario));
    };
    await Promise.all(Array.from({ length: runtime === 'node' ? 4 : 2 }, worker));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  lab.done();
}
