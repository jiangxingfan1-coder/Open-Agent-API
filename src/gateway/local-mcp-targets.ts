import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha } from '../core/util.js';
import {
  clientInvalid,
  jsonMap,
  readClientFile,
  replaceClientFile,
  withClientLocks,
  type ClientFile,
} from '../config/local-client-files.js';
import type { McpTargetId } from './local-connection-source.js';
import type { LocalConnectionState } from './local-connection-state.js';
import type { ManagedTargetAdapter, TargetSnapshot } from './local-provider-targets.js';

export type McpTargetPaths = Partial<Record<McpTargetId, string>>;
export type McpServerEntry = { command: string; args: string[] };

export function resolveCliJsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli.js');
}

export function defaultMcpConfigPath(
  target: McpTargetId,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (target === 'claude-desktop') {
    if (platform === 'darwin')
      return path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      );
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Claude', 'claude_desktop_config.json');
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(xdg, 'Claude', 'claude_desktop_config.json');
  }
  if (target === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  if (target === 'windsurf') return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
  return path.join(home, '.claude.json');
}

export function buildMcpEntry(gatewayUrl: string, keyFilePath: string): McpServerEntry {
  return {
    command: process.execPath,
    args: [resolveCliJsPath(), 'mcp', '--url', gatewayUrl, '--token-file', keyFilePath],
  };
}

function parseMcpRoot(file: ClientFile) {
  if (file.text === null)
    return { root: {} as Record<string, unknown>, servers: {} as Record<string, unknown> };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw clientInvalid();
  }
  const root = jsonMap(parsed);
  return { root, servers: root.mcpServers === undefined ? {} : jsonMap(root.mcpServers) };
}

async function ensureParentDir(file: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw clientInvalid();
}

export class LocalMcpTargets {
  constructor(
    private readonly state: LocalConnectionState,
    private readonly paths: McpTargetPaths = {},
  ) {}

  configPath(target: McpTargetId): string {
    const custom = this.paths[target];
    return custom ? path.resolve(custom) : defaultMcpConfigPath(target);
  }

  gatewayOrigin(v1Base: string): string {
    return new URL(v1Base).origin;
  }

  adapter(target: McpTargetId): ManagedTargetAdapter {
    const snapshot = async (explicitFile?: string): Promise<TargetSnapshot> => {
      const filePath = explicitFile ?? this.configPath(target);
      const file = await readClientFile(filePath);
      const entry = parseMcpRoot(file).servers['open-agent-api'];
      return {
        file,
        revision: sha(canonical([target, filePath, file.revision])),
        entryExists: entry !== undefined,
        entryHash: entry === undefined ? null : sha(canonical(entry)),
      };
    };
    return {
      channel: 'mcp',
      entryId: 'open-agent-api',
      backupName: `${target}-mcp.json`,
      configPath: () => this.configPath(target),
      snapshot,
      locked: async (fn, explicitFile) => {
        const filePath = explicitFile ?? this.configPath(target);
        await ensureParentDir(filePath);
        return withClientLocks([filePath], async () => fn(await snapshot(filePath)));
      },
      preview: (_source, v1Base, bindingId) => {
        const gatewayUrl = this.gatewayOrigin(v1Base);
        const entry = buildMcpEntry(gatewayUrl, this.state.keyFilePath(bindingId));
        return {
          baseUrl: gatewayUrl,
          entryHash: sha(canonical(entry)),
          summary: JSON.stringify({ mcpServers: { 'open-agent-api': entry } }, null, 2),
        };
      },
      write: async (s, _source, v1Base, bindingId) => {
        const { root, servers } = parseMcpRoot(s.file);
        const entry = buildMcpEntry(this.gatewayOrigin(v1Base), this.state.keyFilePath(bindingId));
        const next = { ...root, mcpServers: { ...servers, 'open-agent-api': entry } };
        await replaceClientFile(s.file, JSON.stringify(next, null, 2) + '\n');
        return sha(canonical(entry));
      },
      remove: async (s, record) => {
        if (!s.entryExists) return true;
        if (s.entryHash !== record.owned.entryHash) return false;
        const { root, servers } = parseMcpRoot(s.file);
        const nextServers = { ...servers };
        delete nextServers['open-agent-api'];
        const nextRoot = { ...root };
        if (Object.keys(nextServers).length === 0) delete nextRoot.mcpServers;
        else nextRoot.mcpServers = nextServers;
        const drop = record.owned.createdConfig && Object.keys(nextRoot).length === 0;
        await replaceClientFile(s.file, drop ? null : JSON.stringify(nextRoot, null, 2) + '\n');
        return true;
      },
    };
  }
}
