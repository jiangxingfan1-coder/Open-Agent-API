import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gatewaySchema, workerSchema } from '../config/config.js';
import { bi } from '../core/locale.js';
import { PRODUCT_VERSION } from '../core/version.js';
import { sha } from '../core/util.js';
import { nativeEnvironment } from '../engines/process.js';
import { createGateway } from '../gateway/server.js';
import { EXPECT, type Env, type VerifyTarget } from './verify-env.js';
import { SCENARIOS, deriveUsage, nativeArgs } from './verify-catalog.js';
import {
  Gateway,
  PidTracker,
  Secrets,
  get,
  http,
  runScenario,
  scanForSecrets,
  terminateLeftovers,
  waitGone,
  type Ctx,
  type ScenarioResult,
} from './verify-harness.js';
import { s1, s2, s3, s4, s5, s6 } from './verify-scenarios-a.js';
import { s10, s11, s7, s8, s9 } from './verify-scenarios-b.js';

export type RunOptions = {
  target: VerifyTarget;
  /** Scenario ids (`S1`...) to run, in any order; they run in table order. */
  scenarios: string[];
  model: string;
  timeoutMs: number;
  /** Gateway data and agent working directories live below this (it must exist). */
  workDir: string;
  nativeEnvMode?: 'inherit' | 'allowlist';
  /** Enable the developer platform (needed by the billing scenario only). */
  platform?: boolean;
  agyMode?: string;
  /** Aborted on Ctrl+C: the running scenario stops, the rest are skipped, processes are cleaned up. */
  interrupt?: AbortSignal;
  onResult?: (result: ScenarioResult) => void;
  /** Called once the gateway is up, before the first scenario. */
  onReady?: (info: { agentId: string }) => void;
};

export type RunOutcome = {
  agentId: string;
  results: ScenarioResult[];
  setupError?: string;
  interrupted: boolean;
  gatewayVersion: string;
  baseHost?: string;
  nativeArgs: string[];
  childEnv: {
    mode: string;
    names: string[];
    secret_like_names: string[];
    provider_related_names: string[];
  };
  /** Values that must never reach a report (keys, tokens, secret-looking environment values). */
  secrets: string[];
  startedAt: string;
  finishedAt: string;
};

const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION/i;
const OWNER = 'live-acceptance';

async function fixtureEnvNames(dir: string): Promise<string[]> {
  const names = new Set<string>();
  const visit = async (p: string): Promise<void> => {
    if (!existsSync(p)) return;
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name === '.live-fixture-env.json')
        for (const n of (JSON.parse(await readFile(full, 'utf8')) as { names: string[] }).names)
          names.add(n);
    }
  };
  await visit(dir);
  return [...names].sort();
}

/**
 * Starts an isolated gateway (127.0.0.1, random port, everything under `workDir`), publishes the
 * agent, creates a caller key, runs the chosen scenarios against it through real HTTP, and always
 * shuts the gateway and the agent processes down. Reads and writes nothing of the user's own data
 * directory and touches no network or proxy setting. Calls the agent only through the scenarios;
 * nothing retries.
 */
export async function runVerification(options: RunOptions): Promise<RunOutcome> {
  const { target, model, timeoutMs, workDir } = options;
  const wanted = new Set(options.scenarios);
  const root = path.resolve(workDir);
  const workspace = path.join(root, 'workspace');
  const short = target.kind === 'acp' ? (target.adapter?.name ?? 'agent') : target.kind;
  const agentId = `agent/live-${short}`;
  const secrets = new Secrets();
  const adminToken = randomBytes(32).toString('base64url');
  secrets.add(adminToken);
  const tokenEnv = `OAA_VERIFY_ADMIN_TOKEN_${randomBytes(4).toString('hex').toUpperCase()}`;
  process.env[tokenEnv] = adminToken;

  const args = nativeArgs(target.kind, {
    agyMode: options.agyMode,
    timeoutMs,
    agyLogFile: path.join(root, 'agy.log'),
  });
  const nativeEnvMode = options.nativeEnvMode ?? 'inherit';
  const worker = workerSchema.parse({
    nodeId: 'live-acceptance-node',
    owner: OWNER,
    dataDir: workspace,
    concurrency: 4,
    nativeEnv: { mode: nativeEnvMode, allow: [] },
    native: target.native
      ? { [target.native.engine]: { enabled: true, executable: target.native.executable, args } }
      : {},
    adapters: target.adapter
      ? { [target.adapter.name]: { ...target.adapter.config, enabled: true } }
      : {},
  });
  // The environment handed to the agent process (the same function native.ts and acp.ts use): names only.
  const childEnv = nativeEnvironment(worker.nativeEnv);
  const secretNames = Object.keys(childEnv).filter((k) => SECRETISH.test(k));
  const envSecrets = new Secrets();
  for (const k of secretNames) envSecrets.add(childEnv[k]);

  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  const outcome: RunOutcome = {
    agentId,
    results,
    interrupted: false,
    gatewayVersion: PRODUCT_VERSION,
    nativeArgs: args,
    childEnv: {
      mode: nativeEnvMode,
      names: Object.keys(childEnv).sort(),
      secret_like_names: secretNames.sort(),
      provider_related_names: Object.keys(childEnv)
        .filter((k) => /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE|AWS|AZURE)_|PROXY$/i.test(k))
        .sort(),
    },
    secrets: [],
    startedAt,
    finishedAt: startedAt,
  };
  const gateway = await createGateway(
    gatewaySchema.parse({
      host: '127.0.0.1',
      port: 0,
      dataDir: path.join(root, 'gateway'),
      maxActiveRuns: 8,
      approvalTimeoutMs: 600_000,
      localWorker: worker,
      keys: [
        {
          name: 'live-admin',
          owner: OWNER,
          tokenEnv,
          agents: ['*'],
          scopes: ['read', 'invoke', 'files', 'approve', 'admin', 'billing'],
        },
      ],
      ...(options.platform ? { platform: { owner: OWNER, registration: 'closed' } } : {}),
    }),
  );
  const pids = new PidTracker();
  const interrupted = () => options.interrupt?.aborted === true;
  try {
    const base = await gateway.listen();
    outcome.baseHost = new URL(base).hostname;
    const gw = new Gateway(base, adminToken);
    gw.signal = options.interrupt;
    pids.start();
    const published = await http(base, 'POST', '/v1/agents/publish-native', adminToken, {
      id: agentId,
      engine: target.engine,
      models: [model],
      approvals: 'ask',
    });
    if (published.status !== 200)
      throw new Error(`publishing the agent failed: HTTP ${published.status}`);
    const made = await http(base, 'POST', '/v1/keys', adminToken, {
      name: 'live-caller',
      agents: [agentId],
      scopes: ['invoke', 'read', 'files'],
      execution: 'host',
    });
    const key = get(made.body, 'token') as string | undefined;
    if (!key?.startsWith('sk-oaa-'))
      throw new Error(`creating the sk-oaa- key failed: HTTP ${made.status}`);
    secrets.add(key);
    const sessionOf = (runId: string) => {
      try {
        return gateway.store.run(runId).sessionId;
      } catch {
        return undefined;
      }
    };
    const env: Env = {
      kind: target.kind,
      agentId,
      base,
      key,
      gateway: gw,
      sessionOf,
      workspaceOf: (runId) => {
        const s = sessionOf(runId);
        return s ? path.join(workspace, 'sessions', sha(OWNER).slice(0, 16), s) : undefined;
      },
      expect: EXPECT[target.kind],
    };
    options.onReady?.({ agentId });
    const bodies: Record<string, (ctx: Ctx) => Promise<void>> = {
      S1: (c) => s1(env, c),
      S2: (c) => s2(env, c),
      S3: (c) => s3(env, c),
      S4: (c) => s4(env, c),
      S5: (c) => s5(env, c),
      S6: (c) => s6(env, c),
      S7: (c) => s7(env, c, pids),
      S8: (c) => s8(env, c),
      S9: (c) => s9(env, c),
      S10: (c) => s10(env, c, secrets),
      S11: (c) => s11(env, c, secrets),
      S12: async (c) => {
        await pids.sample();
        const all = [...pids.seen].map(([pid, v]) => ({ pid, ...v }));
        c.observe('child_processes_seen', all.length);
        c.observe('child_commands', [...new Set(all.map((p) => p.comm))]);
        const left = await waitGone(
          all.map((p) => p.pid),
          15_000,
        );
        c.check(
          bi('脚本记录的子进程全部已退出', 'Every child process that was recorded has exited'),
          left.length === 0,
          left,
        );
        const fixtureEnv = await fixtureEnvNames(workspace);
        if (fixtureEnv.length) c.observe('fixture_observed_env_names', fixtureEnv);
        const scan = await scanForSecrets([root], secrets.list());
        const envScan = await scanForSecrets(
          [path.join(root, 'gateway'), path.join(root, 'agy.log')],
          envSecrets.list(),
        );
        c.observe('files_scanned', scan.files);
        c.observe('secret_values_checked', secrets.list().length);
        c.observe('env_secret_values_checked', envSecrets.list().length);
        c.check(
          bi(
            '数据与工作目录中没有管理密钥、sk-oaa- 密钥、账号密钥或会话令牌',
            'The data and working directories contain no admin key, sk-oaa- key, account key or session token',
          ),
          scan.hits.length === 0,
          scan.hits.map((h) => path.relative(root, h.file)),
        );
        c.check(
          bi(
            '网关数据目录中没有子进程环境里的秘密值',
            "The gateway data directory contains no secret value from the child process's environment",
          ),
          envScan.hits.length === 0,
          envScan.hits.map((h) => path.relative(root, h.file)),
        );
      },
    };
    for (const meta of SCENARIOS) {
      if (!wanted.has(meta.id) || !bodies[meta.id]) continue;
      if (interrupted()) {
        const skipped: ScenarioResult = {
          id: meta.id,
          key: meta.key,
          title: meta.title,
          status: 'skipped',
          elapsed_ms: 0,
          agent_invocations: 0,
          observations: {},
          checks: [],
          run_ids: [],
          doc_mismatches: [],
          error: {
            code: 'interrupted',
            message: bi('已中断，没有运行。', 'Interrupted; not run.'),
          },
        };
        results.push(skipped);
        options.onResult?.(skipped);
        continue;
      }
      const r = await runScenario(
        { id: meta.id, key: meta.key, title: meta.title },
        meta.id === 'S7' ? Math.min(timeoutMs, 120_000) : timeoutMs,
        gw,
        secrets,
        pids,
        bodies[meta.id]!,
        options.interrupt,
      );
      results.push(r);
      options.onResult?.(r);
    }
    if (wanted.has('S13')) {
      const usage = deriveUsage(results);
      results.push(usage);
      options.onResult?.(usage);
    }
  } catch (error) {
    outcome.setupError = secrets.redact(String((error as Error).message ?? error)).slice(0, 500);
  } finally {
    pids.stop();
    await gateway.app.close();
    delete process.env[tokenEnv];
    // Whatever agent processes are still ours after the gateway closed (an interrupt, a hung agent).
    await pids.sample();
    outcome.interrupted = interrupted();
    await terminateLeftovers([...pids.seen.keys()]);
    outcome.secrets = [...secrets.list(), ...envSecrets.list()];
    outcome.finishedAt = new Date().toISOString();
  }
  return outcome;
}
