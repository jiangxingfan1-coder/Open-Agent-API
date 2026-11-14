import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sha, canonical, id } from '../../src/core/util.js';
import { FixtureOracle, profiles, shapes, workload, type Profile, type Shape } from './workload.js';

type Trial = {
  profile: Profile;
  shape: Shape;
  sample: number;
  cold: boolean;
  status: string;
  first_event_ms: number | null;
  first_event_type: string | null;
  first_text_ms: number | null;
  final_ms: number;
  output_verified: boolean;
  model_calls: number;
  tool_calls: number;
  peak_tools: number;
  system_hashes: string[];
  reported_fixture_usage: unknown;
  error: string | null;
  diagnostics?: unknown;
};
type Running = {
  id: string;
  oracle: FixtureOracle;
  start: number;
  firstEvent: number | null;
  firstType: string | null;
  firstText: number | null;
  resolve: (frame: any) => void;
  reject: (error: Error) => void;
  abort: AbortController;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repository = path.basename(root) === 'dist' ? path.dirname(root) : root;

export function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
    OTEL_SDK_DISABLED: 'true',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OPENBLAS_NUM_THREADS: '1',
    OMP_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
  };
}

class Runner {
  readonly child: ChildProcessWithoutNullStreams;
  private ready = Promise.withResolvers<any>();
  private exited = Promise.withResolvers<void>();
  private running: Running | undefined;
  private buffer = '';
  private stderr = '';
  private stopped = false;
  private sentBye = false;
  lifecycleError: string | null = null;
  constructor(
    readonly profile: Profile,
    python: string,
    home: string,
    codeRoot: string,
    profileOaa: boolean,
  ) {
    const pythonProfile = profile.startsWith('agentscope');
    this.child = spawn(
      pythonProfile ? python : process.execPath,
      pythonProfile
        ? ['-I', '-B', path.join(codeRoot, 'bench/paired/agentscope_adapter.py')]
        : [path.join(codeRoot, 'dist/bench/paired/oaa.js')],
      { cwd: home, env: isolatedEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16000);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.fail(Error('Benchmark stdout exceeded frame limit.'));
        return;
      }
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        try {
          this.frame(JSON.parse(line));
        } catch (error) {
          this.fail(error as Error);
        }
      }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.once('close', (code) => {
      this.stopped = true;
      if (!this.sentBye || code !== 0)
        this.fail(Error(`Benchmark child exited (${code}): ${this.stderr.slice(-2000)}`));
      this.exited.resolve();
    });
    this.send({
      type: 'configure',
      concurrency: profile.endsWith('parallel') ? 4 : 1,
      workload,
      profile_oaa: profileOaa,
    });
  }
  private send(frame: unknown) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  private fail(error: Error) {
    this.lifecycleError ??= error.message;
    this.ready.reject(error);
    this.running?.reject(error);
    this.running?.abort.abort();
  }
  private frame(frame: any) {
    if (frame.type === 'ready') {
      const expected = this.profile.startsWith('agentscope') ? 'agentscope' : 'oaa';
      if (
        frame.engine !== expected ||
        typeof frame.runtime !== 'string' ||
        typeof frame.durability !== 'string'
      )
        throw Error('Unexpected framework identity in benchmark handshake.');
      if (
        expected === 'agentscope' &&
        (frame.version !== '2.0.11' ||
          frame.dependencies?.agentscope !== '2.0.11' ||
          typeof frame.package_file !== 'string')
      )
        throw Error('AgentScope release/dependency verification failed.');
      this.ready.resolve(frame);
      return;
    }
    if (frame.type === 'fatal') {
      this.fail(Error(String(frame.message)));
      return;
    }
    if (frame.type === 'bye') {
      this.sentBye = true;
      return;
    }
    const run = this.running;
    if (!run || frame.run !== run.id) throw Error('Unexpected or stale benchmark run frame.');
    if (frame.type === 'event') {
      run.firstEvent ??= performance.now() - run.start;
      run.firstType ??= String(frame.event);
      if (typeof frame.delta === 'string' && frame.delta.length)
        run.firstText ??= performance.now() - run.start;
    } else if (frame.type === 'call') {
      if (!Number.isSafeInteger(frame.id)) throw Error('Invalid benchmark call ID.');
      const response =
        frame.operation === 'model'
          ? run.oracle.model(frame.payload, run.abort.signal)
          : frame.operation === 'tool'
            ? run.oracle.tool(frame.payload, run.abort.signal)
            : Promise.reject(Error('Unknown fixture operation.'));
      void response.then(
        (result) => this.send({ type: 'result', id: frame.id, result }),
        (error: Error) => this.send({ type: 'result', id: frame.id, error: error.message }),
      );
    } else if (frame.type === 'done') run.resolve(frame);
    else throw Error('Unknown benchmark frame.');
  }
  async initialize() {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Benchmark adapter startup timed out.')), 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async trial(
    shape: Shape,
    sample: number,
    seed: string,
  ): Promise<{ result: Trial; trace: unknown[] }> {
    const oracle = new FixtureOracle(shape, seed);
    const id = `${shape}-${sample}`;
    let timer: NodeJS.Timeout | undefined;
    const completion = Promise.withResolvers<any>();
    const run: Running = {
      id,
      oracle,
      start: performance.now(),
      firstEvent: null,
      firstType: null,
      firstText: null,
      resolve: completion.resolve,
      reject: completion.reject,
      abort: new AbortController(),
    };
    this.running = run;
    let frame: any = {},
      error: string | null = null;
    try {
      this.send({ type: 'run', id, shape });
      frame = await Promise.race([
        completion.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('Benchmark trial timed out.')), 15000);
        }),
      ]);
      if (frame.status !== 'completed')
        throw Error(frame.error ?? `Framework status: ${frame.status}`);
      oracle.verify(frame.output, frame.usage);
      const expectedPeak =
        shape === 'simple' ? 0 : shape === 'parallel' && this.profile.endsWith('parallel') ? 3 : 1;
      if (oracle.peakTools !== expectedPeak)
        throw Error('The requested concurrency profile was not actually exercised.');
      if (run.firstEvent === null || run.firstText === null)
        throw Error('Framework did not deliver the expected lifecycle/text stream.');
    } catch (failure) {
      error = String((failure as Error).message);
    } finally {
      clearTimeout(timer);
      run.abort.abort();
      this.running = undefined;
    }
    return {
      result: {
        profile: this.profile,
        shape,
        sample,
        cold: sample === 0,
        status: error ? 'failed' : 'completed',
        first_event_ms: run.firstEvent,
        first_event_type: run.firstType,
        first_text_ms: run.firstText,
        final_ms: performance.now() - run.start,
        output_verified: !error,
        model_calls: oracle.modelCalls,
        tool_calls: oracle.toolCalls,
        peak_tools: oracle.peakTools,
        system_hashes: [...oracle.systems],
        reported_fixture_usage: frame.usage ?? null,
        error,
        diagnostics: frame.diagnostics,
      },
      trace: oracle.trace,
    };
  }
  async close() {
    if (this.stopped) return;
    this.send({ type: 'shutdown' });
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 1500);
    const force = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try {
      await this.exited.promise;
    } finally {
      clearTimeout(timer);
      clearTimeout(force);
    }
  }
}

export function summarize(trials: Trial[]) {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    return (
      (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
    );
  };
  return [...new Set(trials.map((trial) => `${trial.shape}:${trial.profile}`))].map((key) => {
    const group = trials.filter((trial) => `${trial.shape}:${trial.profile}` === key);
    const warm = group.filter((trial) => !trial.cold && trial.status === 'completed');
    return {
      shape: group[0]!.shape,
      profile: group[0]!.profile,
      attempted: group.length,
      successful: group.filter((trial) => trial.status === 'completed').length,
      cold: group.find((trial) => trial.cold) ?? null,
      warm_p50_first_event_ms: median(warm.map((trial) => trial.first_event_ms!)),
      warm_p50_first_text_ms: median(warm.map((trial) => trial.first_text_ms!)),
      warm_p50_final_ms: median(warm.map((trial) => trial.final_ms)),
      warm_p95_final_ms: warm.length
        ? warm.map((trial) => trial.final_ms).sort((a, b) => a - b)[
            Math.ceil(warm.length * 0.95) - 1
          ]
        : null,
    };
  });
}

export async function runBenchmark(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      python: { type: 'string' },
      samples: { type: 'string', default: '7' },
      profiles: { type: 'string', default: profiles.join(',') },
      'profile-oaa': { type: 'boolean', default: false },
    },
  });
  if (!values.out) throw Error('Use --out NEW_REPORT.json; reports are never overwritten.');
  const samples = z.coerce.number().int().min(1).max(30).parse(values.samples);
  const chosen = z.array(z.enum(profiles)).min(1).parse(values.profiles.split(','));
  if (new Set(chosen).size !== chosen.length) throw Error('Duplicate benchmark profile.');
  const out = path.resolve(values.out),
    python = path.resolve(
      values.python ?? path.join(repository, '.oaa-bench/agentscope-venv/bin/python'),
    );
  await mkdir(path.dirname(out), { recursive: true });
  const destination = await open(out, 'wx', 0o600);
  const work = await mkdtemp(path.join(path.dirname(out), 'paired-work-'));
  const trials: Trial[] = [],
    processes: Record<string, unknown>[] = [],
    traces: unknown[] = [];
  let failure: string | null = null;
  const seed = id('paired');
  const sourceHashes: Record<string, string> = {};
  const capture = async (file: string) => {
    const bytes = await readFile(path.join(repository, file));
    sourceHashes[file] = sha(bytes);
    const copy = path.join(work, 'sources', file);
    await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 });
  };
  try {
    for (const directory of ['src', 'bench/paired', 'dist/src', 'dist/bench/paired']) {
      const recursive = directory === 'src' || directory === 'dist/src';
      for (const entry of await readdir(path.join(repository, directory), {
        withFileTypes: true,
        recursive,
      })) {
        if (!entry.isFile() || !/\.(ts|js|py)$/.test(entry.name) || entry.name.endsWith('.d.ts'))
          continue;
        const relative = path.relative(path.join(repository, directory), entry.parentPath);
        const file = relative
          ? `${directory}/${relative.split(path.sep).join('/')}/${entry.name}`
          : `${directory}/${entry.name}`;
        await capture(file);
      }
    }
    for (const file of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'test/helpers.ts',
      'dist/test/helpers.js',
      'bench/paired/requirements-macos-py313.lock',
    ])
      await capture(file);
    await symlink(
      path.join(repository, 'node_modules'),
      path.join(work, 'sources/node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const shape of shapes) {
      const runners: Runner[] = [];
      try {
        for (const profile of chosen) {
          const home = path.join(work, `${shape}-${profile}`);
          await mkdir(home, { mode: 0o700 });
          const start = performance.now();
          const runner = new Runner(
            profile,
            python,
            home,
            path.join(work, 'sources'),
            values['profile-oaa'],
          );
          runners.push(runner);
          const ready = await runner.initialize();
          const record: Record<string, unknown> = {
            shape,
            profile,
            fresh_process_ready_ms: performance.now() - start,
            ...ready,
          };
          if (ready.package_file) {
            const packageRoot = path.dirname(String(ready.package_file));
            record.package_source_hashes = Object.fromEntries(
              await Promise.all(
                ['agent/_agent.py', 'model/_base.py', 'tool/_base.py'].map(async (file) => [
                  file,
                  sha(await readFile(path.join(packageRoot, file))),
                ]),
              ),
            );
            delete record.package_file;
          }
          processes.push(record);
        }
        for (let sample = 0; sample <= samples; sample++) {
          const ordered = [
            ...runners.slice(sample % runners.length),
            ...runners.slice(0, sample % runners.length),
          ];
          for (const runner of ordered) {
            const { result, trace } = await runner.trial(
              shape,
              sample,
              `${seed}:${shape}:${sample}`,
            );
            trials.push(result);
            traces.push({ profile: runner.profile, shape, sample, trace });
            if (result.error) throw Error(`${runner.profile}/${shape}: ${result.error}`);
          }
        }
      } finally {
        for (const runner of runners) await runner.close();
        const failed = runners.find((runner) => runner.lifecycleError);
        if (failed) throw Error(`${failed.profile}: ${failed.lifecycleError}`);
      }
    }
    if (
      sha(await readFile(path.join(repository, 'package-lock.json'))) !==
      sourceHashes['package-lock.json']
    )
      throw Error('Node dependency lock changed during the benchmark.');
  } catch (error) {
    failure = String((error as Error).message);
  }
  const summary = summarize(trials);
  const report = {
    format: 'oaa.paired-report.v1',
    recorded_at: new Date().toISOString(),
    status: failure ? 'failed' : 'completed',
    error: failure,
    live_models_tested: false,
    model_fees_measured: false,
    reasoning_quality_measured: false,
    cross_machine_tested: false,
    hosted_agents_api_tested: false,
    target_30_percent_proven: false,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      inherited_provider_credentials: false,
    },
    workload,
    fixture_seed: seed,
    workload_sha256: sha(canonical(workload)),
    source_hashes: sourceHashes,
    source_snapshot: path.join(work, 'sources'),
    adapters_execute_from_source_snapshot: true,
    profiles: chosen,
    dependency_fingerprints: [
      ...new Set(
        processes
          .filter((process) => process.dependencies)
          .map((process) => sha(canonical(process.dependencies))),
      ),
    ],
    warm_samples: samples,
    measurement_mode: values['profile-oaa'] ? 'instrumented_oaa' : 'latency_only',
    work_directory: work,
    processes,
    summary,
    trials,
    traces,
    pairing_verified: !failure && trials.length === shapes.length * chosen.length * (samples + 1),
    independent_framework_tested:
      !failure &&
      chosen.some((profile) => profile.startsWith('oaa-')) &&
      chosen.some((profile) => profile.startsWith('agentscope-')),
    limitations: [
      'Scripted model responses and controlled in-memory source records; this is not a reasoning/quality or monetary-cost evaluation.',
      'OAA uses its actual SQLite FULL checkpoint/output journal; AgentScope uses native in-memory AgentState. Durability is not equivalent.',
      'Both receive the same base instructions and tool schema, but framework-generated system context differs and its hashes are recorded.',
      'The common boundary is subprocess NDJSON, not an HTTP gateway. First-event kinds differ by framework and are recorded.',
      'Cold is the first request in a fresh process with warm OS filesystem caches possible; process startup is reported separately.',
      'No framework source is patched. AgentScope parallel tools are declared concurrency-safe; the serial profile is a separate control.',
      'Each OAA process has a resident published definition and creates a fresh kernel run/session per trial. AgentScope constructs a fresh Agent/AgentState per trial.',
      'This suite exercises common reasoning/tool-loop paths, not dynamic graph fusion, private-skill quality, multi-node placement or hosted agent services.',
      'The source snapshot references the project node_modules rather than vendoring dependencies; the lock and framework dependency manifests are recorded.',
    ],
  };
  await destination.writeFile(JSON.stringify(report, null, 2) + '\n');
  await destination.close();
  process.stdout.write(
    JSON.stringify(
      {
        report: out,
        status: report.status,
        summary: summary.map(({ cold: _, ...row }) => row),
        error: failure,
      },
      null,
      2,
    ) + '\n',
  );
  if (failure) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runBenchmark();
