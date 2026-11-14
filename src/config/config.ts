import { applySecurityProfile } from './security-profile.js';
import { z } from 'zod';
import { readFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  capabilitySchema,
  domainPattern,
  executionLevels,
  keyQuotaSchema,
} from '../core/contracts.js';
import { Fault, writePrivate } from '../core/util.js';
import { whichSync } from '../core/which.js';
import { discoverAcpAgents, discoveredAdapterEntry, nativeEngines } from './agent-presets.js';

const tokenRef = { tokenEnv: z.string().optional(), tokenFile: z.string().optional() };
export const providerSchema = z
  .object({
    kind: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate']),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    apiKeyEnv: z.string().default('OPENAI_API_KEY'),
    /**
     * Accept caller-supplied keys (BYOK) for this provider. The caller's key is then sent to
     * `baseUrl`. Without an `apiKeyEnv` value the provider serves BYOK requests only.
     */
    byok: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(120_000),
    maxTokensField: z
      .enum(['max_tokens', 'max_completion_tokens'])
      .default('max_completion_tokens'),
    anthropicVersion: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof providerSchema>;
const mcpSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string()).default([]),
      envNames: z.array(z.string()).default([]),
      cwd: z.string().optional(),
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      url: z.string().url(),
      tokenEnv: z.string().optional(),
    })
    .strict(),
]);
export const workerToolSchema = z
  .object({
    reference: z.string(),
    capability: capabilitySchema,
    handler: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('read_directory'), root: z.string() }).strict(),
      z
        .object({
          kind: z.literal('mcp'),
          server: z.string(),
          tool: z.string(),
          descriptorSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('script'),
          executable: z.string(),
          args: z.array(z.string()).default([]),
          cwd: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();
export const workerSchema = z
  .object({
    nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    owner: z.string().default('owner'),
    dataDir: z.string(),
    gatewayUrl: z.string().optional(),
    ...tokenRef,
    concurrency: z.number().int().min(1).max(64).default(4),
    providers: z.record(z.string(), providerSchema).default({}),
    native: z
      .partialRecord(
        z.enum(nativeEngines),
        z
          .object({
            executable: z.string(),
            enabled: z.boolean().default(false),
            args: z.array(z.string()).default([]),
            models: z.record(z.string(), z.array(z.string())).optional(),
          })
          .strict(),
      )
      .default({}),
    /**
     * Environment passed to native agents, ACP agents and stdio adapters. `inherit` (default)
     * passes everything except `OAA_*`. `allowlist` passes only basics (PATH, HOME, LANG, ...),
     * `LC_*`, proxy variables (unchanged) and the names listed in `allow`.
     */
    nativeEnv: z
      .object({
        mode: z.enum(['inherit', 'allowlist']).default('inherit'),
        allow: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
          .max(200)
          .default([]),
      })
      .strict()
      .default({ mode: 'inherit', allow: [] }),
    /**
     * OS sandbox for `sandbox`-level callers (docs/sandbox-design.md). `none` (default) keeps the
     * pre-sandbox behaviour and starts nothing. `srt` starts @anthropic-ai/sandbox-runtime, whose
     * network proxies listen on localhost, and advertises the sandbox only after a self-check.
     */
    sandbox: z
      .object({
        backend: z.enum(['none', 'srt']).default('none'),
        /** Upper bound for domains a sandboxed script may reach (publisher list ∩ this). */
        allowDomains: z.array(domainPattern).max(200).default([]),
        cpuSeconds: z.number().int().min(1).max(3600).default(60),
        /** Extra paths sandboxed processes may not read (home, volumes and dataDir always). */
        denyRead: z.array(z.string().min(1)).max(100).default([]),
        /**
         * Native engines allowed to run sandboxed for `sandbox`-level callers, with the provider
         * domains each may reach. Unlisted engines are never sandboxed (they stay `host`-only).
         */
        native: z
          .partialRecord(
            z.enum(['claude', 'codex']),
            z
              .object({
                providerDomains: z.array(domainPattern).min(1).max(20),
                cpuSeconds: z.number().int().min(1).max(86_400).default(1800),
              })
              .strict(),
          )
          .default({}),
        /** Upstream proxy for srt's own outbound connections (unset: srt connects directly). */
        parentProxy: z
          .object({
            http: z.string().url().optional(),
            https: z.string().url().optional(),
            noProxy: z.string().max(2000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ backend: 'none', allowDomains: [], cpuSeconds: 60, denyRead: [], native: {} }),
    scripts: z.array(z.enum(['node', 'python3'])).default([]),
    adapters: z
      .record(
        z.string(),
        z.discriminatedUnion('transport', [
          z
            .object({
              transport: z.literal('stdio'),
              command: z.string(),
              args: z.array(z.string()).default([]),
              enabled: z.boolean().default(false),
              /**
               * `oaa/1`: one request on stdin (then EOF), one final result on stdout.
               * `oaa/1-stream`: NDJSON both ways — streamed deltas, progress and approvals.
               * Absent means `oaa/1`.
               */
              protocol: z.enum(['oaa/1', 'oaa/1-stream']).optional(),
            })
            .strict(),
          z
            .object({
              transport: z.literal('http'),
              url: z.string().url(),
              tokenEnv: z.string().optional(),
              enabled: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              /** A2A (Agent2Agent) JSON-RPC endpoint of a remote agent; HTTPS unless local. */
              transport: z.literal('a2a'),
              url: z.string().url(),
              tokenEnv: z.string().optional(),
              enabled: z.boolean().default(false),
              preset: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
                .optional(),
              /** Stream the reply over SSE (default true); false sends a blocking request. */
              streaming: z.boolean().optional(),
              /** A2A request forms to send: 1.0 (default) or 0.3; replies in either are read. */
              protocolVersion: z.enum(['1.0', '0.3']).optional(),
            })
            .strict(),
          z
            .object({
              /** Agent Client Protocol v1 over stdio (JSON-RPC 2.0, newline-delimited). */
              transport: z.literal('acp'),
              command: z.string().min(1),
              args: z.array(z.string()).max(64).default([]),
              enabled: z.boolean().default(false),
              /** Presentation/preset id (icon and catalog metadata only; grants nothing). */
              preset: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
                .optional(),
            })
            .strict(),
        ]),
      )
      .default({}),
    mcp: z.record(z.string(), mcpSchema).default({}),
    tools: z.array(workerToolSchema).default([]),
  })
  .strict()
  .superRefine((worker, context) => {
    if (new Set(worker.tools.map((tool) => tool.reference)).size !== worker.tools.length)
      context.addIssue({ code: 'custom', message: 'Duplicate worker tool reference.' });
    if (
      new Set(
        worker.tools.map((tool) => JSON.stringify([tool.capability.id, tool.capability.version])),
      ).size !== worker.tools.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate worker capability version.' });
  });
export type WorkerConfig = z.infer<typeof workerSchema>;
/** Developer platform (accounts, account keys, listings, credits). Also used by the console setup. */
export const platformSchema = z
  .object({
    owner: z.string().min(1),
    siteName: z.string().min(1).max(100).default('Open Agent API'),
    registration: z.enum(['closed', 'invite', 'open']).default('closed'),
    signupCredits: z.number().min(0).max(1_000_000_000).default(0),
    maxKeysPerAccount: z.number().int().min(1).max(100).default(10),
    keyQuota: keyQuotaSchema.default({ rpm: 60, maxConcurrentRuns: 2 }),
    /** Account keys never reach `host`. */
    keyExecution: z.enum(['workspace', 'sandbox']).default('workspace'),
    sessionTtlHours: z.number().int().min(1).max(8760).default(720),
  })
  .strict();
const gatewayObject = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8787),
    dataDir: z.string(),
    publicBaseUrl: z.string().url().optional(),
    trustProxy: z.boolean().default(false),
    tls: z.object({ keyFile: z.string(), certFile: z.string() }).optional(),
    allowedOrigins: z.array(z.string()).default([]),
    allowedHosts: z.array(z.string()).default(['127.0.0.1', 'localhost', '[::1]']),
    /**
     * Management-plane hosts. When set, the console is served only on these hosts and admin-scope
     * keys are refused on every other host (for example the public API host). Each entry must
     * also be allowed by `allowedHosts`. Unset: no separation (local desktop default).
     */
    consoleHosts: z.array(z.string().min(1).max(253)).min(1).optional(),
    keys: z
      .array(
        z
          .object({
            name: z.string(),
            owner: z.string(),
            ...tokenRef,
            agents: z.array(z.string()).default(['*']),
            scopes: z
              .array(z.enum(['invoke', 'read', 'files', 'approve', 'admin', 'billing']))
              .default(['invoke', 'read', 'files']),
            quota: keyQuotaSchema.optional(),
            /** `owner`: see every caller's runs/files for the granted agents (default `own`). */
            dataScope: z.enum(['own', 'owner']).optional(),
            /** Highest execution level this key may start (default `host`). */
            execution: z.enum(executionLevels).optional(),
          })
          .strict(),
      )
      .min(1),
    nodeKeys: z
      .array(
        z
          .object({
            nodeId: z.string(),
            owner: z.string(),
            ...tokenRef,
            agents: z.array(z.string()).default(['*']),
            capabilities: z.array(z.string()).default(['*']),
          })
          .strict(),
      )
      .default([]),
    localWorker: workerSchema.optional(),
    maxActiveRuns: z.number().int().min(1).max(64).default(8),
    /**
     * Execution level of keys created through `POST /v1/keys` without an explicit `execution`.
     * `host` keeps the pre-P1 behaviour; public deployments should use `workspace`.
     */
    defaultKeyExecution: z.enum(executionLevels).default('host'),
    /** Optional per-caller cap on unfinished requests (below the owner-wide cap of 32). */
    maxActiveRunsPerSubject: z.number().int().min(1).max(32).optional(),
    /** Optional per-caller cap on stored file bytes (uploads and artifacts). Unset: unlimited. */
    maxStoredBytesPerSubject: z.number().int().min(1).optional(),
    approvalTimeoutMs: z.number().int().min(50).max(86_400_000).default(600_000),
    /**
     * What a request that declares caller tools gets when it does not choose a mode itself
     * (X-OAA-Client-Tools / metadata): `auto` bridges them when the agent can take them over and
     * falls back to the entry's older behaviour otherwise; `managed`, `bridge`, `reject` apply to every request.
     */
    /** Structured output (response_format and friends): how often a wrong answer is sent back for correction. */
    structuredOutput: z
      .object({ maxRepairs: z.number().int().min(0).max(3).default(1) })
      .strict()
      .default({ maxRepairs: 1 }),
    clientTools: z
      .object({ default: z.enum(['auto', 'managed', 'bridge', 'reject']).default('auto') })
      .strict()
      .default({ default: 'auto' }),
    leaseMs: z.number().int().min(100).max(120_000).default(15_000),
    /** Developer platform (accounts, account keys, listings, credits). Unset: nothing changes. */
    platform: platformSchema.optional(),
    /** `public` fills stricter defaults for unset settings (security-profile.ts). */
    security: z
      .object({
        profile: z.enum(['local', 'public']).default('local'),
        /** Time to receive one request (not the response). Unset: no limit. */
        requestTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      })
      .strict()
      .default({ profile: 'local' }),
  })
  .strict()
  .superRefine((gateway, context) => {
    for (const host of gateway.consoleHosts ?? []) {
      const h = host.toLowerCase();
      const allowed = gateway.allowedHosts.some((pattern) => {
        const p = pattern.toLowerCase();
        if (p === '*' || p === h) return true;
        // A wildcard console entry needs the identical wildcard in allowedHosts.
        return (
          !h.startsWith('*.') &&
          p.startsWith('*.') &&
          h.endsWith(p.slice(1)) &&
          h.length > p.length - 1
        );
      });
      if (!allowed)
        context.addIssue({
          code: 'custom',
          path: ['consoleHosts'],
          message: `Console host '${host}' must also be listed in allowedHosts.`,
        });
    }
  });
export const gatewaySchema = z.preprocess(applySecurityProfile, gatewayObject);
export type GatewayConfig = z.infer<typeof gatewaySchema>;
export async function loadConfig(file: string): Promise<GatewayConfig> {
  return gatewaySchema.parse(JSON.parse(await readFile(file, 'utf8')));
}
export async function loadWorkerConfig(file: string): Promise<WorkerConfig> {
  return workerSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}
export function validateEndpoint(url: string, websocket = false): void {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    (!local && u.protocol !== (websocket ? 'wss:' : 'https:')) ||
    ![websocket ? 'ws:' : 'http:', websocket ? 'wss:' : 'https:'].includes(u.protocol)
  ) {
    throw new Fault(
      'insecure_endpoint',
      'Remote endpoints require TLS and must not contain credentials.',
    );
  }
}
export async function initialize(root: string): Promise<string> {
  const data = path.resolve(root);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writePrivate(data, 'admin.token', randomBytes(32).toString('base64url'), true);
  const file = path.join(data, 'config.json');
  const native: Record<string, unknown> = {};
  for (const [engine, command] of Object.entries({
    codex: 'codex',
    claude: 'claude',
    antigravity: 'agy',
    dsh: 'dsh',
  })) {
    // PATHEXT-aware on Windows (`codex` -> `codex.cmd`); the resolved file is recorded.
    const candidate = whichSync(command);
    if (candidate) native[engine] = { executable: candidate, enabled: false, args: [] };
  }
  // ACP agents found on PATH are recorded disabled; nothing is executed or enabled here.
  const adapters = Object.fromEntries(
    (await discoverAcpAgents()).map((found) => [found.preset.id, discoveredAdapterEntry(found)]),
  );
  const config = gatewaySchema.parse({
    dataDir: data,
    keys: [
      {
        name: 'owner',
        owner: 'owner',
        tokenFile: path.join(data, 'admin.token'),
        scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
      },
    ],
    localWorker: {
      nodeId: 'local',
      dataDir: path.join(data, 'worker'),
      providers: { default: { kind: 'openai-responses' } },
      native,
      adapters,
    },
  });
  await writePrivate(data, 'config.json', JSON.stringify(config, null, 2) + '\n', true);
  return file;
}
