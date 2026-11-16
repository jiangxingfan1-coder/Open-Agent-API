import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerConfig } from '../config/config.js';
import { nativeEnvironment, ownedProcess, collectProcess } from './process.js';
import { AcpPeer, initializeParams, probeAcp, normalizeAcpError } from './acp.js';
import { loadClaudeSdk } from './claude-sdk.js';
import { record } from './shared.js';
import {
  normalizedModels,
  parseAgyModels,
  parseAcpModels,
  type ModelDiscoveryResult,
} from './model-catalog.js';
import { MAX_AGENT_MODELS, type DiscoveredModel } from '../core/model-catalog.js';
import { Fault, checkAbort } from '../core/util.js';

/** Metadata-only discovery: no prompt, authentication, file tool, or model generation. */
export async function discoverAgentModels(
  config: WorkerConfig,
  engine: string,
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  if (signal) checkAbort(signal);
  const native = config.native[engine as keyof WorkerConfig['native']];
  const adapter = engine.startsWith('adapter/') ? config.adapters[engine.slice(8)] : undefined;
  if (!native?.enabled && !adapter?.enabled)
    return { source: 'disabled', models: [], unsupported: true };
  if (engine === 'dsh')
    return {
      source: 'owner-configuration',
      models: Object.entries(native?.models ?? {})
        .filter(([, args]) => args.length)
        .map(([id]) => ({ id, name: id, verification: 'configured' })),
      unsupported: !Object.keys(native?.models ?? {}).length,
    };
  if (adapter && adapter.transport !== 'acp')
    return { source: adapter.transport, models: [], unsupported: true };
  const parent = path.join(config.dataDir, 'discovery');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(path.join(parent, 'models-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  const env = nativeEnvironment(config.nativeEnv);
  try {
    if (engine === 'antigravity' && native) {
      const output = await collectProcess(
        native.executable,
        [...native.args, 'models'],
        cwd,
        '',
        controller.signal,
        env,
      );
      let bridge = false;
      try {
        await probeAcp(native.executable, [...native.args, 'acp'], 5000, env, controller.signal);
        bridge = true;
      } catch {
        /* A working model catalog does not imply ACP support. */
      }
      return {
        source: 'agent-cli',
        models: parseAgyModels(output, MAX_AGENT_MODELS + 1),
        ...(bridge ? { clientTools: 'hybrid' as const } : {}),
      };
    }
    if (engine === 'claude' && native) {
      const { query } = await loadClaudeSdk();
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      async function* noPrompt() {
        await closed;
      }
      const q = query({
        prompt: noPrompt(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: native.executable,
          abortController: controller,
          env,
          settingSources: ['user'],
        },
      });
      try {
        const models = await q.supportedModels();
        return {
          source: 'agent-sdk',
          models: normalizedModels(
            models.map((m) => ({ id: m.value, name: m.displayName, verification: 'discovered' })),
            MAX_AGENT_MODELS + 1,
          ),
        };
      } finally {
        finish();
        q.close();
      }
    }
    const acp = adapter?.transport === 'acp' ? adapter : undefined;
    if (!acp && !(engine === 'codex' && native))
      return { source: 'agent', models: [], unsupported: true };
    const child = ownedProcess(
      acp?.command ?? native!.executable,
      acp?.args ?? [...native!.args, 'app-server'],
      cwd,
      controller.signal,
      env,
    );
    const peer = new AcpPeer(
      child,
      {
        request: async () => {
          throw new Error('Discovery cannot execute tools or approve actions.');
        },
        notification: () => {},
      },
      !!acp,
    );
    try {
      if (acp) {
        const init = record(await peer.call('initialize', initializeParams()));
        if (init.protocolVersion !== 1)
          throw new Fault('native_protocol_error', 'Unsupported ACP discovery protocol.', 502);
        const session = await peer.call('session/new', { cwd, mcpServers: [] });
        return { source: 'acp-session', models: parseAcpModels(session, MAX_AGENT_MODELS + 1) };
      }
      await peer.call('initialize', {
        clientInfo: { name: 'open-agent-api', version: '1' },
        capabilities: {},
      });
      peer.notify('initialized', {});
      const models: DiscoveredModel[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        checkAbort(controller.signal);
        const response = record(
          await peer.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }),
        );
        for (const raw of Array.isArray(response.data) ? response.data : []) {
          const item = record(raw);
          const id = typeof item.model === 'string' ? item.model : item.id;
          if (typeof id === 'string')
            models.push({
              id,
              name: String(item.displayName ?? id),
              isDefault: item.isDefault === true,
              verification: 'discovered',
            });
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor && models.length < MAX_AGENT_MODELS + 1);
      return {
        source: 'codex-app-server',
        models: normalizedModels(models, MAX_AGENT_MODELS + 1),
        ...(cursor ? { truncated: true } : {}),
      };
    } catch (error) {
      throw acp ? normalizeAcpError(error) : error;
    } finally {
      await peer.shutdown(100);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
    controller.abort();
    await rm(cwd, { recursive: true, force: true });
  }
}
