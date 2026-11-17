import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { acpPresets, findOnPath, nativeBackends, nativeEngines } from './agent-presets.js';
import type { WorkerConfig } from './config.js';
import { MODEL_RUNTIMES, modelRuntimeDirs } from './model-runtimes.js';

export type ClientEvidence = {
  kind: 'cli' | 'application' | 'extension' | 'configured';
  path: string;
};
export type LocalClient = {
  id: string;
  name: string;
  icon: string;
  installed: boolean;
  connection: 'managed' | 'manual' | 'unavailable' | 'provider';
  runtime?: {
    preset: string;
    base_url: string;
    download_url: string;
    providers: string[];
    connections?: { provider: string; base_url: string; key_env?: string }[];
  };
  protocol?: 'responses' | 'messages' | 'chat-completions';
  guide?: string;
  evidence: ClientEvidence[];
  engines: string[];
};
type Definition = Omit<LocalClient, 'installed' | 'evidence' | 'engines'> & {
  commands: { names: readonly string[]; marker?: string }[];
  apps?: string[];
  extension?: string;
};

const product: Record<string, string> = {
  'deepseek-harness': 'dsh',
  'codex-acp': 'codex',
  'claude-acp': 'claude',
  'antigravity-acp': 'antigravity',
};
const canonical = (id: string) => product[id] ?? id;

/** Discovery is not receiver compatibility. Only DSH has a managed configuration writer. */
function catalog(): Definition[] {
  const items = new Map<string, Definition>();
  for (const id of nativeEngines) {
    const meta = nativeBackends[id];
    items.set(id, {
      id,
      name: meta.name,
      icon: meta.preset,
      connection: id === 'dsh' ? 'managed' : 'unavailable',
      commands: [{ names: [meta.executable] }],
    });
  }
  for (const preset of acpPresets) {
    const id = canonical(preset.id);
    const item = items.get(id) ?? {
      id,
      name: preset.name,
      icon: preset.id,
      connection: 'unavailable',
      commands: [],
    };
    if (preset.discover)
      item.commands.push({
        names: preset.discover.names,
        marker: preset.discover.realpathIncludes,
      });
    items.set(id, item);
  }
  const extend = (id: string, changes: Partial<Definition>) => {
    const item = items.get(id) ?? {
      id,
      name: id,
      icon: id,
      connection: 'unavailable',
      commands: [],
    };
    items.set(id, { ...item, ...changes });
  };
  extend('codex', {
    connection: 'manual',
    protocol: 'responses',
    guide: 'https://developers.openai.com/codex/config-advanced/',
  });
  extend('claude', {
    connection: 'manual',
    protocol: 'messages',
    guide: 'https://code.claude.com/docs/en/llm-gateway',
  });
  extend('dsh', { apps: ['DeepSeek Harness.app'], protocol: 'chat-completions' });
  extend('antigravity', { apps: ['Antigravity.app'] });
  extend('qoder', {
    name: 'Qoder',
    apps: ['Qoder.app'],
    connection: 'manual',
    guide: 'https://docs.qoder.com/cli/custom-models',
  });
  extend('opencode-acp', {
    name: 'OpenCode',
    apps: ['OpenCode.app'],
    connection: 'manual',
    protocol: 'chat-completions',
    guide: 'https://opencode.ai/docs/providers/',
  });
  extend('cursor', { name: 'Cursor', apps: ['Cursor.app'] });
  extend('kiro', { name: 'Kiro', apps: ['Kiro.app'] });
  extend('trae-cli', { name: 'Trae', apps: ['Trae.app'] });
  extend('windsurf', { name: 'Windsurf', apps: ['Windsurf.app'] });
  // Desktop subscription apps are not the CLI; never infer a CLI receiver from these bundles.
  extend('codex-desktop', { name: 'Codex Desktop', icon: 'codex', apps: ['Codex.app'] });
  extend('claude-desktop', { name: 'Claude Desktop', icon: 'claude', apps: ['Claude.app'] });
  extend('cline', { extension: 'saoudrizwan.claude-dev-' });
  extend('roo-code', { name: 'Roo Code', extension: 'rooveterinaryinc.roo-cline-' });
  extend('continue', { name: 'Continue', extension: 'continue.continue-' });
  extend('kilo', { extension: 'kilocode.kilo-code-' });
  for (const runtime of MODEL_RUNTIMES) {
    extend(runtime.id, {
      name: runtime.name,
      icon: runtime.id,
      commands: [{ names: runtime.commands.flatMap((name) => [name, `${name}.exe`]) }],
      apps: [...runtime.apps],
      connection: 'provider',
      protocol: 'chat-completions',
      guide: runtime.docs,
      runtime: {
        preset: runtime.id,
        base_url: runtime.baseUrl,
        download_url: runtime.download,
        providers: [],
      },
    });
  }
  return [...items.values()];
}

export type DiscoveryOptions = {
  home?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  appRoots?: string[];
  extensionRoots?: string[];
  /** Tests can omit the fixed, non-recursive installation locations. */
  installDirs?: string[];
};

async function isFile(file: string, executable = false): Promise<boolean> {
  try {
    if (executable) await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const launchers = new Set([
  'node',
  'nodejs',
  'npx',
  'npm',
  'bun',
  'bunx',
  'uv',
  'uvx',
  'python',
  'python3',
  'sh',
  'bash',
  'zsh',
  'env',
]);

/** Fixed installation metadata only: no subprocess, login, credentials, project or history reads. */
export async function discoverLocalClients(
  worker?: WorkerConfig,
  options: DiscoveryOptions = {},
): Promise<LocalClient[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const installDirs = options.installDirs ?? [
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.opencode/bin'),
    path.join(home, '.qoder/bin'),
    ...modelRuntimeDirs(home, platform),
    ...(platform === 'win32'
      ? [path.join(home, 'AppData/Roaming/npm')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ];
  const pathEnv = [
    ...new Set([
      ...(options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter),
      ...installDirs,
    ]),
  ]
    .filter((p) => path.isAbsolute(p))
    .join(path.delimiter);
  const appRoots =
    options.appRoots ??
    (platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : []);
  const extensionRoots =
    options.extensionRoots ??
    ['.vscode', '.cursor', '.windsurf', '.vscode-insiders'].map((editor) =>
      path.join(home, editor, 'extensions'),
    );
  const extensions: string[] = [];
  for (const root of extensionRoots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 4096)) {
      if (entry.isDirectory()) extensions.push(path.join(root, entry.name));
    }
  }
  const configured = new Map<string, { engine: string; command: string; args: string[] }[]>();
  const add = (id: string, engine: string, command: string, args: string[] = []) => {
    const key = canonical(id);
    configured.set(key, [...(configured.get(key) ?? []), { engine, command, args }]);
  };
  for (const [engine, native] of Object.entries(worker?.native ?? {}))
    if (native) add(engine, engine, native.executable);
  for (const [name, adapter] of Object.entries(worker?.adapters ?? {})) {
    if (adapter.transport === 'acp' || adapter.transport === 'stdio')
      add(
        adapter.transport === 'acp' ? (adapter.preset ?? name) : name,
        `adapter/${name}`,
        adapter.command,
        adapter.args,
      );
  }
  const definitions = catalog();
  for (const id of configured.keys()) {
    if (!definitions.some((item) => item.id === id))
      definitions.push({
        id,
        name: id,
        icon: id,
        connection: 'unavailable',
        commands: [],
      });
  }
  return Promise.all(
    definitions.map(async (item) => {
      const evidence: ClientEvidence[] = [];
      const engines: string[] = [];
      for (const command of item.commands) {
        const found = await findOnPath(command.names, pathEnv, command.marker);
        if (found) evidence.push({ kind: 'cli', path: found });
      }
      for (const root of appRoots)
        for (const app of item.apps ?? []) {
          const bundle = path.join(root, app);
          if (await isFile(path.join(bundle, 'Contents/Info.plist')))
            evidence.push({ kind: 'application', path: bundle });
        }
      for (const directory of extensions) {
        if (
          item.extension &&
          path.basename(directory).startsWith(item.extension) &&
          (await isFile(path.join(directory, 'package.json')))
        )
          evidence.push({ kind: 'extension', path: directory });
      }
      for (const configuredEntry of configured.get(item.id) ?? []) {
        const { command, args, engine } = configuredEntry;
        const executable = path.isAbsolute(command)
          ? (await isFile(command, true))
            ? command
            : undefined
          : await findOnPath([command], pathEnv);
        if (!executable) continue;
        const basename = path
          .basename(executable)
          .replace(/\.(exe|cmd|bat)$/i, '')
          .toLowerCase();
        if (launchers.has(basename)) {
          // Do not count a package manager or a generic interpreter as an installed agent.
          // A configured node/bun script is evidence only when its absolute entry actually exists.
          if (
            !['node', 'nodejs', 'bun'].includes(basename) ||
            !args[0] ||
            !path.isAbsolute(args[0]) ||
            !(await isFile(args[0]))
          )
            continue;
          evidence.push({ kind: 'configured', path: args[0] });
        } else evidence.push({ kind: 'configured', path: executable });
        engines.push(engine);
      }
      const unique = evidence.filter(
        (e, i) => evidence.findIndex((other) => other.path === e.path) === i,
      );
      const qoderDesktop = item.id === 'qoder' && unique.some((e) => e.kind === 'application');
      return {
        id: item.id,
        name: item.name,
        icon: item.icon,
        installed: unique.length > 0,
        connection: item.id === 'qoder' && !qoderDesktop ? 'unavailable' : item.connection,
        ...(item.protocol ? { protocol: item.protocol } : {}),
        ...(item.guide
          ? { guide: qoderDesktop ? 'https://docs.qoder.com/qoder/custom-models' : item.guide }
          : {}),
        ...(item.runtime
          ? {
              runtime: {
                ...item.runtime,
                providers: Object.entries(worker?.providers ?? {})
                  .filter(([, provider]) => provider.preset === item.runtime!.preset)
                  .map(([name]) => name),
                connections: Object.entries(worker?.providers ?? {})
                  .filter(([, provider]) => provider.preset === item.runtime!.preset)
                  .map(([name, provider]) => ({
                    provider: name,
                    base_url: provider.baseUrl,
                    ...(!provider.noApiKey && provider.apiKeyEnv
                      ? { key_env: provider.apiKeyEnv }
                      : {}),
                  })),
              },
            }
          : {}),
        evidence: unique,
        engines,
      };
    }),
  );
}

/** Coalesce polls and refreshes; never cache a failed inventory or run an agent to detect it. */
export function localClientInventory(worker?: WorkerConfig) {
  let cached: { at: number; data: LocalClient[] } | undefined;
  let pending: Promise<LocalClient[]> | undefined;
  return async (refresh = false): Promise<LocalClient[]> => {
    if (pending) return pending;
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.data;
    pending = discoverLocalClients(worker)
      .then((data) => {
        cached = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
