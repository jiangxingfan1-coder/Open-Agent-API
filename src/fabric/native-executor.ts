import { workerSchema, type WorkerConfig } from '../config/config.js';
import type { AgentDefinition, Work } from '../core/contracts.js';
import { runNative, type NativeSandbox } from '../engines/native.js';
import { runAcp, type AcpTimings } from '../engines/acp.js';
import { runAdapter } from '../engines/adapter.js';
import { runA2A } from '../engines/a2a.js';
import type { Emit } from '../engines/shared.js';
import * as img from './image-capabilities.js';
import { Fault } from '../core/util.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readBounded, sha } from '../core/util.js';
import type { ArtifactPayload } from '../core/contracts.js';

export async function executeNative(
  work: Extract<Work, { kind: 'native' }>,
  agent: AgentDefinition,
  config: WorkerConfig,
  root: string,
  signal: AbortSignal,
  emit: Emit,
  timings: AcpTimings,
  sandbox?: NativeSandbox,
  nativeAcp = false,
  projectRoot?: string,
) {
  const cwd = projectRoot ?? root;
  const nativeInput = img.nativeInputText(
    projectRoot
      ? `Publisher-bound project directory: ${JSON.stringify(projectRoot)}. This is the process working directory; task attachments and downloadable outputs remain separate.\n\n${work.input}`
      : work.input,
    work.context,
    projectRoot ? root : undefined,
  );
  const name = agent.engine.startsWith('adapter/') ? agent.engine.slice(8) : undefined;
  const transport = name ? config.adapters[name]?.transport : undefined;
  if (work.toolsDisabled) {
    if (agent.engine !== 'antigravity' && agent.engine !== 'claude')
      throw new Fault(
        'capability_unavailable',
        'This engine does not offer enforced tool-free reasoning.',
        503,
      );
    return runNative(
      agent,
      config,
      root,
      nativeInput,
      signal,
      emit,
      work.nativeState,
      sandbox,
      work.context.images,
      root,
      true,
    );
  }
  if (projectRoot && (transport === 'a2a' || transport === 'http'))
    throw new Fault(
      'capability_unavailable',
      'A remote adapter cannot use a local project working directory.',
      503,
    );
  if (
    agent.engine === 'antigravity' &&
    (work.clientTools?.length || (agent.access && agent.access.approval !== 'native'))
  ) {
    if (!nativeAcp)
      throw new Fault(
        'adapter_unavailable',
        'This Antigravity executable has not confirmed ACP support for the requested tool and approval policy. Refresh its capabilities first.',
        503,
      );
    const native = config.native.antigravity!;
    const adapter = 'oaa-antigravity-native';
    return runAcp(
      { ...agent, engine: `adapter/${adapter}` },
      {
        ...config,
        adapters: {
          ...config.adapters,
          ...workerSchema.shape.adapters.parse({
            [adapter]: {
              transport: 'acp',
              command: native.executable,
              args: [...native.args, 'acp'],
              enabled: true,
            },
          }),
        },
      },
      cwd,
      nativeInput,
      signal,
      emit,
      work.nativeState,
      timings,
      work.clientTools,
      work.context.images,
      root,
    );
  }
  if (transport === 'a2a') return runA2A(agent, config, work.input, signal, emit, work.nativeState);
  if (transport === 'acp')
    return runAcp(
      agent,
      config,
      cwd,
      nativeInput,
      signal,
      emit,
      work.nativeState,
      timings,
      work.clientTools,
      work.context.images,
      root,
    );
  if (name)
    return runAdapter(
      agent,
      config,
      cwd,
      projectRoot ? nativeInput : work.input + img.imageNote(work.context),
      work.context,
      signal,
      work.nativeState,
      emit,
    );
  return runNative(
    agent,
    config,
    cwd,
    nativeInput,
    signal,
    emit,
    work.nativeState,
    sandbox,
    work.context.images,
    root,
  );
}

export async function collectNativeArtifacts(outputRoot: string): Promise<ArtifactPayload[]> {
  const artifacts: ArtifactPayload[] = [];
  let total = 0;
  const collect = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(outputRoot, rel), { withFileTypes: true })) {
      const name = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink())
        throw new Fault(
          'unsafe_artifact',
          'Native output contains a symlink; automatic export refused.',
          403,
        );
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) {
        const data = await readBounded(outputRoot, name);
        total += data.length;
        if (total > 8 * 1024 * 1024 || artifacts.length >= 100)
          throw new Fault('artifacts_too_large', 'Native output export exceeds its limit.', 413);
        artifacts.push({ name, content: data.toString('base64'), sha256: sha(data) });
      }
    }
  };
  await collect('');
  return artifacts;
}
