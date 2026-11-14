import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerConfig } from '../config/config.js';
import { validateEndpoint } from '../config/config.js';
import type { WorkContext } from '../core/contracts.js';
import { Fault, canonical, checkAbort, executableExists, sha } from '../core/util.js';
import { PRODUCT_VERSION } from '../core/version.js';

type Scope = Pick<WorkContext, 'owner' | 'sessionId' | 'digest'>;
type Entry = {
  key: string;
  server: string;
  version: string;
  client: Client;
  ready: Promise<void>;
  controller: AbortController;
  references: number;
  connected: boolean;
  retired: boolean;
  idle?: NodeJS.Timeout;
  closing?: Promise<void>;
  done: Promise<void>;
  finish: () => void;
};
function connectionSettings(config: WorkerConfig, name: string) {
  const settings = Object.hasOwn(config.mcp, name) ? config.mcp[name] : undefined;
  if (!settings)
    throw new Fault(
      'mcp_unconfigured',
      'Selected MCP server is not configured on this worker.',
      503,
    );
  if (settings.transport === 'http') {
    validateEndpoint(settings.url);
    const token = settings.tokenEnv ? process.env[settings.tokenEnv] : undefined;
    if (settings.tokenEnv && !token)
      throw new Fault(
        'mcp_credentials_unavailable',
        'A declared MCP credential environment reference is unavailable.',
        503,
      );
    return { settings, token, env: undefined, version: sha(canonical(settings) + (token ?? '')) };
  }
  if (!executableExists(settings.command))
    throw new Fault('mcp_executable_unavailable', 'Configured MCP executable is unavailable.', 503);
  const env = {
    ...getDefaultEnvironment(),
    ...Object.fromEntries(
      settings.envNames
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]!]),
    ),
  };
  return { settings, token: undefined, env, version: sha(canonical({ settings, env })) };
}
export function mcpConfigured(config: WorkerConfig, name: string): boolean {
  try {
    connectionSettings(config, name);
    return true;
  } catch {
    return false;
  }
}
function waitForConnection(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Fault('cancelled', 'MCP connection wait was cancelled.', 409));
    };
    signal.addEventListener('abort', abort, { once: true });
    void ready.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class McpConnections {
  private entries = new Map<string, Entry>();
  private all = new Set<Entry>();
  private closing = false;
  constructor(
    readonly config: WorkerConfig,
    readonly idleMs = 60_000,
    readonly maxIdle = 16,
  ) {}
  private retire(entry: Entry): void {
    entry.retired = true;
    clearTimeout(entry.idle);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.references === 0 && !entry.closing) {
      entry.controller.abort();
      entry.closing = Promise.resolve()
        .then(() => entry.client.close())
        .catch(() => {})
        .then(() => {
          this.all.delete(entry);
          entry.finish();
        });
    }
  }
  private create(
    key: string,
    server: string,
    connection: ReturnType<typeof connectionSettings>,
  ): Entry {
    const client = new Client({ name: 'open-agent-api-worker', version: PRODUCT_VERSION });
    const complete = Promise.withResolvers<void>();
    const entry: Entry = {
      key,
      server,
      version: connection.version,
      client,
      ready: Promise.resolve(),
      controller: new AbortController(),
      references: 0,
      connected: false,
      retired: false,
      done: complete.promise,
      finish: complete.resolve,
    };
    this.entries.set(key, entry);
    this.all.add(entry);
    client.onclose = () => this.retire(entry);
    const c = connection.settings;
    const transport =
      c.transport === 'stdio'
        ? new StdioClientTransport({
            command: c.command,
            args: c.args,
            env: connection.env,
            cwd: c.cwd,
            stderr: 'pipe',
          })
        : new StreamableHTTPClientTransport(new URL(c.url), {
            requestInit: {
              headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
              redirect: 'error',
            },
          });
    entry.ready = client
      .connect(transport, { timeout: 15000, signal: entry.controller.signal })
      .then(() => {
        entry.connected = true;
      })
      .catch(() => {
        throw new Fault(
          'mcp_connection_failed',
          'Could not initialize the selected MCP server. Check its owner-side configuration and credential references.',
          503,
        );
      });
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    void entry.ready.catch(() => this.retire(entry));
    return entry;
  }
  async use<T>(
    server: string,
    scope: Scope,
    signal: AbortSignal,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    checkAbort(signal);
    if (this.closing) throw new Fault('shutting_down', 'MCP connections are shutting down.', 503);
    if (scope.owner !== this.config.owner)
      throw new Fault('invalid_context', 'MCP connection owner does not match its worker.', 403);
    let connection: ReturnType<typeof connectionSettings>;
    try {
      connection = connectionSettings(this.config, server);
    } catch (error) {
      for (const entry of this.all) if (entry.server === server) this.retire(entry);
      throw error;
    }
    for (const entry of this.all)
      if (entry.server === server && entry.version !== connection.version) this.retire(entry);
    const key = sha(
      canonical({ server, owner: scope.owner, sessionId: scope.sessionId, digest: scope.digest }),
    );
    const entry = this.entries.get(key) ?? this.create(key, server, connection);
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.references++;
    clearTimeout(entry.idle);
    try {
      await waitForConnection(entry.ready, signal);
      checkAbort(signal);
      if (entry.retired)
        throw new Fault(
          'mcp_connection_retired',
          'MCP connection changed before execution; retry after checking the configured server.',
          503,
        );
      return await operation(entry.client);
    } finally {
      entry.references--;
      if (entry.retired || this.closing || !entry.connected) this.retire(entry);
      else if (entry.references === 0) {
        entry.idle = setTimeout(() => this.retire(entry), this.idleMs);
        entry.idle.unref();
        const idle = [...this.entries.values()].filter((e) => e.references === 0);
        for (const old of idle.slice(0, Math.max(0, idle.length - this.maxIdle))) this.retire(old);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const entries = [...this.all];
    for (const entry of entries) this.retire(entry);
    await Promise.all(entries.map((entry) => entry.done));
  }
}

export function toolDescriptor(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? {},
    ...(tool.execution ? { execution: tool.execution } : {}),
  };
}
export const descriptorDigest = (tool: Tool) => sha(canonical(toolDescriptor(tool)));
export async function findMcpTool(
  client: Client,
  name: string,
  signal: AbortSignal,
): Promise<Tool> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    checkAbort(signal);
    const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15000 });
    const matching = result.tools.filter((tool) => tool.name === name);
    if (matching.length > 1)
      throw new Fault('mcp_ambiguous_tool', 'MCP server returned duplicate tool names.', 502);
    if (matching[0]) return matching[0];
    if (!result.nextCursor)
      throw new Fault(
        'mcp_tool_not_found',
        'The selected tool is not listed by this MCP server.',
        404,
      );
    if (seen.has(result.nextCursor))
      throw new Fault('mcp_invalid_catalog', 'MCP tool pagination did not advance.', 502);
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Fault('mcp_catalog_limit', 'MCP tool discovery exceeded its bounded page limit.', 502);
}
