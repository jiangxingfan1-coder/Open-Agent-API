import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, sha } from '../core/util.js';
import {
  clientInvalid,
  jsonMap,
  readClientFile,
  replaceClientFile,
  withClientLocks,
  type ClientFile,
} from '../config/local-client-files.js';
import type { ConnectionSource } from './local-connection-source.js';
import type { LocalConnectionState, ManagedTargetRecord } from './local-connection-state.js';

export type ProviderTargetId = 'opencode' | 'codex';
export type ProviderTargetPaths = {
  opencodeConfig?: string;
  codexHome?: string;
  codexConfig?: string;
};

export type TargetSnapshot = {
  file: ClientFile;
  revision: string;
  entryExists: boolean;
  entryHash: string | null;
};

export type ManagedTargetAdapter = {
  readonly channel: 'api' | 'mcp';
  readonly entryId: string;
  readonly backupName: string;
  configPath(): string;
  snapshot(explicitFile?: string): Promise<TargetSnapshot>;
  locked<T>(fn: (s: TargetSnapshot) => Promise<T>, explicitFile?: string): Promise<T>;
  preview(
    source: ConnectionSource | undefined,
    v1Base: string,
    bindingId: string,
  ): { baseUrl: string; entryHash: string; summary: string };
  write(
    s: TargetSnapshot,
    source: ConnectionSource | undefined,
    v1Base: string,
    bindingId: string,
  ): Promise<string>;
  remove(s: TargetSnapshot, record: ManagedTargetRecord): Promise<boolean>;
};

function stripTomlCommentAndScan(
  line: string,
  state: { multi: '"""' | "'''" | null; brackets: number; braces: number },
): string {
  let i = 0;
  let out = '';
  while (i < line.length) {
    if (state.multi) {
      const idx = line.indexOf(state.multi, i);
      if (idx === -1) return out;
      if (state.multi === '"""') {
        let bs = 0;
        for (let k = idx - 1; k >= i && line[k] === '\\'; k--) bs++;
        if (bs % 2 === 1) {
          i = idx + 3;
          continue;
        }
      }
      i = idx + 3;
      state.multi = null;
      continue;
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.multi = line.slice(i, i + 3) as '"""' | "'''";
      i += 3;
      out += '""';
      continue;
    }
    const ch = line[i]!;
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      let closed = false;
      while (i < line.length) {
        const c = line[i]!;
        out += c;
        if (quote === '"' && c === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) throw clientInvalid();
      continue;
    }
    if (ch === '[') state.brackets++;
    else if (ch === ']' && --state.brackets < 0) throw clientInvalid();
    else if (ch === '{') state.braces++;
    else if (ch === '}' && --state.braces < 0) throw clientInvalid();
    out += ch;
    i++;
  }
  return out;
}

function splitTomlPath(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (quote === '"' && ch === '\\') {
        cur += raw.slice(i, i + 2);
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '.') {
      if (!cur.trim()) throw clientInvalid();
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (quote || !cur.trim()) throw clientInvalid();
  parts.push(cur.trim());
  return parts;
}

export function inspectCodexToml(text: string | null): {
  sectionRange: { start: number; end: number } | null;
  sectionHash: string | null;
} {
  if (text === null) return { sectionRange: null, sectionHash: null };
  if (text.includes('\0')) throw clientInvalid();
  const normalized = text.replace(/\r\n/g, '\n');
  const lex = { multi: null as '"""' | "'''" | null, brackets: 0, braces: 0 };
  let currentTable: string[] = [];
  let oaaStart: number | null = null;
  let oaaEnd: number | null = null;
  let offset = 0;

  for (const line of normalized.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const wasOpen = lex.multi !== null || lex.brackets > 0 || lex.braces > 0;
    const code = stripTomlCommentAndScan(line, lex).trim();
    if (!code || wasOpen) continue;
    if (code.startsWith('[')) {
      if (lex.brackets !== 0 || lex.braces !== 0 || lex.multi !== null) throw clientInvalid();
      const arrayMatch = /^\[\[([^\[\]]+)\]\]$/.exec(code);
      const stdMatch = arrayMatch ? null : /^\[([^\[\]]+)\]$/.exec(code);
      if (!arrayMatch && !stdMatch) throw clientInvalid();
      const pathParts = splitTomlPath((arrayMatch?.[1] ?? stdMatch?.[1])!);
      if (oaaStart !== null && oaaEnd === null) oaaEnd = lineStart;
      if (arrayMatch) {
        if (pathParts[0] === 'model_providers') throw clientInvalid();
        currentTable = pathParts;
        continue;
      }
      if (pathParts[0] === 'model_providers' && pathParts[1] === 'oaa') {
        if (pathParts.length > 2 || oaaStart !== null) throw clientInvalid();
        oaaStart = lineStart;
      }
      currentTable = pathParts;
      continue;
    }
    const eq = code.indexOf('=');
    if (eq <= 0) throw clientInvalid();
    const full = [...currentTable, ...splitTomlPath(code.slice(0, eq))];
    if (full[0] === 'model_providers' && full.length === 1) throw clientInvalid();
    if (
      full[0] === 'model_providers' &&
      full[1] === 'oaa' &&
      !(
        currentTable.length === 2 &&
        currentTable[0] === 'model_providers' &&
        currentTable[1] === 'oaa'
      )
    )
      throw clientInvalid();
  }
  if (lex.multi !== null || lex.brackets !== 0 || lex.braces !== 0) throw clientInvalid();
  if (oaaStart === null) return { sectionRange: null, sectionHash: null };
  const end = oaaEnd ?? normalized.length;
  return {
    sectionRange: { start: oaaStart, end },
    sectionHash: sha(normalized.slice(oaaStart, end).trim()),
  };
}

export function buildCodexBlock(
  source: ConnectionSource,
  baseUrl: string,
  keyFile: string,
): string {
  const defaultModel = source.models[0]?.id ?? source.id;
  return [
    '[model_providers.oaa]',
    `# Managed by Open Agent API (${source.id}, model: ${defaultModel}, key_file: ${keyFile})`,
    'name = "Open Agent API"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "OAA_CODEX_API_KEY"',
  ].join('\n');
}

export function buildOpenCodeEntry(
  source: ConnectionSource,
  baseUrl: string,
  keyFile: string,
): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: `Open Agent API / ${source.id}`,
    options: { baseURL: baseUrl, apiKey: `{file:${keyFile}}` },
    models: Object.fromEntries(source.models.map((m) => [m.id, { name: m.name }])),
  };
}

async function ensureParentDir(file: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw clientInvalid();
}

function parseOpenCodeRoot(file: ClientFile) {
  if (file.text === null)
    return { root: {} as Record<string, unknown>, providers: {} as Record<string, unknown> };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    throw clientInvalid();
  }
  const root = jsonMap(parsed);
  return { root, providers: root.provider === undefined ? {} : jsonMap(root.provider) };
}

export class LocalProviderTargets {
  constructor(
    private readonly state: LocalConnectionState,
    private readonly paths: ProviderTargetPaths = {},
  ) {}

  configPath(target: ProviderTargetId): string {
    if (target === 'opencode') {
      if (this.paths.opencodeConfig) return path.resolve(this.paths.opencodeConfig);
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'opencode',
        'opencode.json',
      );
    }
    if (this.paths.codexConfig) return path.resolve(this.paths.codexConfig);
    const home =
      this.paths.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    return path.join(path.resolve(home), 'config.toml');
  }

  adapter(target: ProviderTargetId): ManagedTargetAdapter {
    const snapshot = async (explicitFile?: string): Promise<TargetSnapshot> => {
      const filePath = explicitFile ?? this.configPath(target);
      const file = await readClientFile(filePath);
      if (target === 'opencode') {
        const entry = parseOpenCodeRoot(file).providers['open-agent-api'];
        return {
          file,
          revision: sha(canonical([target, filePath, file.revision])),
          entryExists: entry !== undefined,
          entryHash: entry === undefined ? null : sha(canonical(entry)),
        };
      }
      const scan = inspectCodexToml(file.text);
      return {
        file,
        revision: sha(canonical([target, filePath, file.revision])),
        entryExists: scan.sectionHash !== null,
        entryHash: scan.sectionHash,
      };
    };
    return {
      channel: 'api',
      entryId: target === 'opencode' ? 'open-agent-api' : 'model_providers.oaa',
      backupName: target === 'opencode' ? 'opencode.json' : 'config.toml',
      configPath: () => this.configPath(target),
      snapshot,
      locked: async (fn, explicitFile) => {
        const filePath = explicitFile ?? this.configPath(target);
        await ensureParentDir(filePath);
        return withClientLocks([filePath], async () => fn(await snapshot(filePath)));
      },
      preview: (source, v1Base, bindingId) => {
        const keyFile = this.state.keyFilePath(bindingId);
        if (target === 'opencode') {
          const entry = buildOpenCodeEntry(source!, v1Base, keyFile);
          return {
            baseUrl: v1Base,
            entryHash: sha(canonical(entry)),
            summary: JSON.stringify({ provider: { 'open-agent-api': entry } }, null, 2),
          };
        }
        const block = buildCodexBlock(source!, v1Base, keyFile);
        return { baseUrl: v1Base, entryHash: sha(block.trim()), summary: block };
      },
      write: async (s, source, v1Base, bindingId) => {
        const keyFile = this.state.keyFilePath(bindingId);
        if (target === 'opencode') {
          const { root, providers } = parseOpenCodeRoot(s.file);
          const entry = buildOpenCodeEntry(source!, v1Base, keyFile);
          const next = { ...root, provider: { ...providers, 'open-agent-api': entry } };
          await replaceClientFile(s.file, JSON.stringify(next, null, 2) + '\n');
          return sha(canonical(entry));
        }
        const block = buildCodexBlock(source!, v1Base, keyFile);
        const normalized = s.file.text === null ? '' : s.file.text.replace(/\r\n/g, '\n');
        const scan = inspectCodexToml(s.file.text);
        let nextText: string;
        if (scan.sectionRange) {
          const before = normalized.slice(0, scan.sectionRange.start);
          const after = normalized.slice(scan.sectionRange.end).replace(/^\n+/, '');
          nextText = `${before}${block}\n${after ? `\n${after}` : ''}`;
        } else {
          const prefix = normalized.trimEnd();
          nextText = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
        }
        await replaceClientFile(s.file, nextText);
        return sha(block.trim());
      },
      remove: async (s, record) => {
        if (!s.entryExists) return true;
        if (s.entryHash !== record.owned.entryHash) return false;
        if (target === 'opencode') {
          const { root, providers } = parseOpenCodeRoot(s.file);
          const nextProviders = { ...providers };
          delete nextProviders['open-agent-api'];
          const nextRoot = { ...root };
          if (Object.keys(nextProviders).length === 0) delete nextRoot.provider;
          else nextRoot.provider = nextProviders;
          const drop = record.owned.createdConfig && Object.keys(nextRoot).length === 0;
          await replaceClientFile(s.file, drop ? null : JSON.stringify(nextRoot, null, 2) + '\n');
          return true;
        }
        const normalized = (s.file.text ?? '').replace(/\r\n/g, '\n');
        const scan = inspectCodexToml(s.file.text);
        if (!scan.sectionRange) return true;
        const before = normalized.slice(0, scan.sectionRange.start).replace(/\n+$/, '');
        const after = normalized.slice(scan.sectionRange.end).replace(/^\n+/, '');
        const merged = [before, after].filter(Boolean).join('\n\n');
        const drop = record.owned.createdConfig && merged.trim().length === 0;
        await replaceClientFile(s.file, drop ? null : merged ? `${merged}\n` : '');
        return true;
      },
    };
  }
}
