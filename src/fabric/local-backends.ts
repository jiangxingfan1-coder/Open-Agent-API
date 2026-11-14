/**
 * Local worker backend catalog for the console: built-in native engines plus owner-installed
 * adapters (ACP and the oaa/1 stdio/http ABI). Enabling only changes this platform's own database
 * entry and in-memory worker configuration; no native agent's global configuration is touched.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkerConfig } from '../config/config.js';
import { WorkerRuntime, adapterReady, type Executor } from './worker.js';
import { probeAcp, type AcpProbe } from '../engines/acp.js';
import { nativeEnvironment } from '../engines/process.js';
import { claudeSdkStatus } from '../engines/claude-sdk.js';
import { probeA2A } from '../engines/a2a.js';
import {
  conversionProfile,
  presetProfile,
  type HandshakeEvidence,
} from '../engines/conformance.js';
import {
  acpPreset,
  acpPresets,
  findOnPath,
  isNativeEngine,
  nativeBackends,
  nativeEngines,
  type NativeEngine,
} from '../config/agent-presets.js';
import { bi, pick, processLocale, type Locale } from '../core/locale.js';
import { presetNotes } from '../config/agent-presets-en.js';
import { Fault, executableExists } from '../core/util.js';

type AdapterConfig = WorkerConfig['adapters'][string];
export type BackendTarget =
  { kind: 'native'; engine: NativeEngine } | { kind: 'adapter'; engine: string; name: string };
export type A2AProbe = Awaited<ReturnType<typeof probeA2A>>;
export type HandshakeRecord = { identity: string; checked_at: string; result: AcpProbe | A2AProbe };
const evidenceOf = (result: AcpProbe | A2AProbe): HandshakeEvidence =>
  'load_session' in result
    ? { load_session: result.load_session, resume_session: result.resume_session }
    : { streaming: result.streaming };

export function parseBackendEngine(raw: string): BackendTarget {
  if (isNativeEngine(raw)) return { kind: 'native', engine: raw };
  const match = /^adapter\/([a-z0-9_-]{1,120})$/.exec(raw);
  if (match) return { kind: 'adapter', engine: `adapter/${match[1]}`, name: match[1]! };
  throw new Fault(
    'invalid_engine',
    'Choose a built-in native engine (codex, claude, antigravity, dsh) or adapter/<name>.',
  );
}

/** The value persisted with an enable decision; a changed command invalidates the decision. */
const identity = (a: AdapterConfig) =>
  a.transport === 'http' || a.transport === 'a2a' ? a.url : a.command;
const fingerprint = (a: AdapterConfig) =>
  JSON.stringify(
    a.transport === 'http' || a.transport === 'a2a'
      ? [a.transport, a.url]
      : [a.transport, a.command, a.args],
  );

/** Presentation preset (icon id) for an engine, if one is known. */
export function presetForEngine(engine: string, worker?: WorkerConfig): string | undefined {
  if (isNativeEngine(engine)) return nativeBackends[engine].preset;
  if (!engine.startsWith('adapter/')) return undefined;
  const name = engine.slice('adapter/'.length);
  const adapter = worker?.adapters[name];
  if (adapter?.transport === 'acp' && adapter.preset) return adapter.preset;
  return acpPreset(name)?.id;
}

export function backendDisplayName(engine: string, worker?: WorkerConfig): string {
  if (isNativeEngine(engine)) return nativeBackends[engine].name;
  return acpPreset(presetForEngine(engine, worker))?.name ?? engine;
}

/** 发布到某个适配器的智能体的默认描述（按进程默认语言），例如 `Gemini CLI（ACP 智能体）`。 */
export function adapterAgentDescription(engine: string, worker?: WorkerConfig): string {
  const transport = worker?.adapters[engine.slice('adapter/'.length)]?.transport;
  const name = backendDisplayName(engine, worker);
  if (transport === 'acp') return pick(bi(`${name}（ACP 智能体）`, `${name} (ACP agent)`));
  if (transport) return pick(bi(`${name}（外部适配器）`, `${name} (external adapter)`));
  return pick(bi(`${name}（外部智能体）`, `${name} (external agent)`));
}

/** 发布到一个没有任何在线节点启用的适配器。 */
export const backendNotEnabled = () =>
  new Fault(
    'backend_not_enabled',
    bi(
      '该适配器未在任何在线节点上启用；请先在本机后端中启用它（或由远程节点通告）后再发布。',
      'This adapter is not enabled on any online node. Enable it under local backends (or have a remote node advertise it) before publishing.',
    ),
    409,
  );

/** Re-apply persisted owner choices while the configured executable is unchanged. */
export function restoreLocalBackends(
  db: DatabaseSync,
  worker: WorkerConfig | undefined,
  executor?: Executor,
): void {
  if (!worker) return;
  const targets = [
    worker,
    ...(executor instanceof WorkerRuntime && executor.config !== worker ? [executor.config] : []),
  ];
  for (const row of db.prepare('SELECT * FROM local_backends WHERE owner=?').all(worker.owner)) {
    const engine = String(row.engine);
    const enabled = row.enabled === 1;
    for (const target of targets) {
      if (isNativeEngine(engine)) {
        const backend = target.native[engine];
        if (backend && backend.executable === row.executable) backend.enabled = enabled;
      } else if (engine.startsWith('adapter/')) {
        const adapter = target.adapters[engine.slice('adapter/'.length)];
        if (adapter && identity(adapter) === row.executable) adapter.enabled = enabled;
      }
    }
  }
}

export function listLocalBackends(
  worker: WorkerConfig,
  handshakes: Map<string, HandshakeRecord>,
): Record<string, unknown>[] {
  const natives = Object.entries(worker.native).map(([engine, c]) => {
    const meta = nativeBackends[engine as NativeEngine];
    const installed = executableExists(c!.executable);
    const sdk = sdkRequirement(engine);
    return {
      engine,
      kind: 'native',
      preset: meta.preset,
      name: meta.name,
      executable: c!.executable,
      enabled: c!.enabled,
      ...('docs_url' in meta ? { docs_url: meta.docs_url } : {}),
      publishable: c!.enabled && installed && !sdk,
      ...(sdk ? { requires_separate_install: sdk } : {}),
      model_overrides: engine === 'dsh' ? Object.keys(c!.models ?? {}) : 'declared routes',
      evidence: installed ? 'installed_not_exercised' : 'not_installed',
      conversion: conversionProfile(engine, worker),
    };
  });
  const adapters = Object.entries(worker.adapters).map(([name, a]) => {
    const engine = `adapter/${name}`;
    const presetId = presetForEngine(engine, worker);
    const preset = a.transport === 'acp' ? acpPreset(presetId) : undefined;
    const usable = adapterReady(name, { ...a, enabled: true });
    const check = handshakes.get(engine);
    const verified = check && check.identity === fingerprint(a) ? check : undefined;
    return {
      engine,
      kind: a.transport === 'acp' ? 'acp' : 'adapter',
      transport: a.transport,
      ...(presetId && (a.transport === 'acp' || acpPreset(presetId)) ? { preset: presetId } : {}),
      name: preset?.name ?? name,
      executable: identity(a),
      ...(a.transport === 'stdio' || a.transport === 'acp' ? { args: a.args } : {}),
      enabled: a.enabled,
      ...(preset
        ? {
            maturity: preset.maturity,
            docs_url: preset.docs_url,
            verified: preset.verified ?? null,
          }
        : {}),
      publishable: a.enabled && usable,
      evidence: verified
        ? 'handshake_passed'
        : usable
          ? 'installed_not_exercised'
          : 'not_installed',
      ...(verified ? { handshake: { checked_at: verified.checked_at, ...verified.result } } : {}),
      conversion: conversionProfile(engine, worker, verified && evidenceOf(verified.result)),
    };
  });
  return [...natives, ...adapters];
}

/** The Claude engine needs the separately installed Claude Agent SDK (not in release packages). */
function sdkRequirement(engine: string) {
  if (engine !== 'claude') return undefined;
  const sdk = claudeSdkStatus();
  return sdk.status === 'available'
    ? undefined
    : { package: sdk.package, install: sdk.install, message: sdk.message };
}

let installedCache: { at: number; pathEnv: string; found: Map<string, string | null> } | undefined;

/** Whole supported-agent catalog, including presets that are not configured on this host. */
export async function presetCatalog(
  worker: WorkerConfig | undefined,
  locale: Locale = processLocale(),
): Promise<Record<string, unknown>[]> {
  const pathEnv = process.env.PATH ?? '';
  if (
    !installedCache ||
    installedCache.pathEnv !== pathEnv ||
    Date.now() - installedCache.at > 30_000
  ) {
    const found = new Map<string, string | null>();
    await Promise.all([
      ...nativeEngines.map(async (engine) =>
        found.set(engine, (await findOnPath([nativeBackends[engine].executable], pathEnv)) ?? null),
      ),
      ...acpPresets.map(async (preset) =>
        found.set(
          `acp:${preset.id}`,
          preset.discover
            ? ((await findOnPath(
                preset.discover.names,
                pathEnv,
                preset.discover.realpathIncludes,
              )) ?? null)
            : null,
        ),
      ),
    ]);
    installedCache = { at: Date.now(), pathEnv, found };
  }
  const found = installedCache.found;
  const adapters = Object.entries(worker?.adapters ?? {});
  return [
    ...nativeEngines.map((engine) => {
      const meta = nativeBackends[engine];
      const configured = !!worker?.native[engine];
      return {
        id: engine,
        preset: meta.preset,
        kind: 'native',
        name: meta.name,
        executable: meta.executable,
        args: [],
        ...('docs_url' in meta ? { docs_url: meta.docs_url } : {}),
        configured,
        ...(configured ? { engine } : {}),
        installed_executable: found.get(engine) ?? null,
        ...(sdkRequirement(engine) ? { requires_separate_install: sdkRequirement(engine) } : {}),
        conversion: presetProfile('native', engine),
      };
    }),
    ...acpPresets.map((preset) => {
      const configured = adapters.find(
        ([name, a]) => a.transport === 'acp' && (a.preset ?? name) === preset.id,
      );
      return {
        id: preset.id,
        preset: preset.id,
        kind: 'acp',
        name: preset.name,
        executable: preset.executable,
        args: [...preset.args],
        maturity: preset.maturity,
        // Date the command was checked against official documentation; null means 待验证.
        verified: preset.verified ?? null,
        docs_url: preset.docs_url,
        ...(preset.launcher ? { launcher: preset.launcher } : {}),
        notes: presetNotes(preset, locale),
        configured: !!configured,
        ...(configured ? { engine: `adapter/${configured[0]}` } : {}),
        installed_executable: found.get(`acp:${preset.id}`) ?? null,
        conversion: presetProfile('acp', preset.id),
      };
    }),
  ];
}

export async function setLocalBackend(
  db: DatabaseSync,
  owner: string,
  worker: WorkerConfig,
  executor: Executor | undefined,
  raw: string,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  const target = parseBackendEngine(raw);
  let persisted: string;
  if (target.kind === 'native') {
    const backend = worker.native[target.engine];
    if (!backend)
      throw new Fault(
        'backend_not_configured',
        'Declare the native executable in the local worker configuration first.',
        404,
      );
    // A missing native executable is a stable client-visible condition, not a server error.
    if (enabled)
      await access(backend.executable, constants.X_OK).catch(() => {
        throw new Fault(
          'backend_unavailable',
          'The native executable is missing or not executable; it was not enabled.',
          409,
        );
      });
    backend.enabled = enabled;
    if (executor instanceof WorkerRuntime && executor.config.native[target.engine])
      executor.config.native[target.engine]!.enabled = enabled;
    persisted = backend.executable;
  } else {
    const adapter = worker.adapters[target.name];
    if (!adapter)
      throw new Fault(
        'backend_not_configured',
        bi(
          '请先在本地 worker 配置的 adapters 中声明该智能体（oaa doctor --write 可写入已发现的 ACP 智能体，默认停用）。',
          'Declare this agent under adapters in the local worker configuration first (oaa doctor --write adds discovered ACP agents, disabled by default).',
        ),
        404,
      );
    if (enabled && !adapterReady(target.name, { ...adapter, enabled: true }, { fresh: true }))
      throw new Fault(
        'backend_unavailable',
        adapter.transport === 'http' || adapter.transport === 'a2a'
          ? bi(
              '适配器端点或令牌尚未就绪，未启用。',
              'The adapter endpoint or token is not ready; it was not enabled.',
            )
          : bi(
              '适配器可执行文件不存在或不可执行，未启用。',
              'The adapter executable is missing or not executable; it was not enabled.',
            ),
        409,
      );
    adapter.enabled = enabled;
    if (executor instanceof WorkerRuntime && executor.config.adapters[target.name])
      executor.config.adapters[target.name]!.enabled = enabled;
    persisted = identity(adapter);
  }
  db.prepare(
    'INSERT INTO local_backends VALUES(?,?,?,?) ON CONFLICT(owner,engine) DO UPDATE SET executable=excluded.executable,enabled=excluded.enabled',
  ).run(owner, target.engine, persisted, enabled ? 1 : 0);
  return { engine: target.engine, enabled, global_agent_configuration_changed: false };
}

const checking = new Map<string, Promise<HandshakeRecord>>();

/**
 * Owner-requested handshake: ACP `initialize`, or A2A agent-card discovery. No session, task or
 * prompt is created; no model is called.
 */
export async function checkLocalBackend(
  worker: WorkerConfig,
  raw: string,
  handshakes: Map<string, HandshakeRecord>,
): Promise<Record<string, unknown>> {
  const target = parseBackendEngine(raw);
  const adapter = target.kind === 'adapter' ? worker.adapters[target.name] : undefined;
  if (target.kind === 'adapter' && !adapter)
    throw new Fault(
      'backend_not_configured',
      bi(
        '该适配器未在本地 worker 配置中声明。',
        'This adapter is not declared in the local worker configuration.',
      ),
      404,
    );
  if (adapter?.transport === 'a2a') {
    // Agent-card discovery only: no message is sent and no task is created.
    const result = await probeA2A(adapter);
    const record: HandshakeRecord = {
      identity: fingerprint(adapter),
      checked_at: new Date().toISOString(),
      result,
    };
    handshakes.set(target.engine, record);
    return { engine: target.engine, checked_at: record.checked_at, ...result };
  }
  if (adapter?.transport !== 'acp')
    throw new Fault(
      'check_unsupported',
      bi(
        '握手检查只适用于 ACP 与 A2A 适配器。',
        'Handshake checks apply only to ACP and A2A adapters.',
      ),
      400,
    );
  if (!executableExists(adapter.command, { fresh: true }))
    throw new Fault(
      'backend_unavailable',
      bi(
        '适配器可执行文件不存在或不可执行。',
        'The adapter executable is missing or not executable.',
      ),
      409,
    );
  const key = `${target.engine}\n${fingerprint(adapter)}`;
  let pending = checking.get(key);
  if (!pending) {
    // Same environment policy as a real run, so a passing check reflects what runs will see.
    pending = probeAcp(
      adapter.command,
      adapter.args,
      undefined,
      nativeEnvironment(worker.nativeEnv),
    ).then((result) => ({
      identity: fingerprint(adapter),
      checked_at: new Date().toISOString(),
      result,
    }));
    checking.set(key, pending);
  }
  try {
    const record = await pending;
    handshakes.set(target.engine, record);
    return { engine: target.engine, checked_at: record.checked_at, ...record.result };
  } finally {
    checking.delete(key);
  }
}
