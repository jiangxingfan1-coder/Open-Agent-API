import { z } from 'zod';
import { modelPolicySchema, modelRouteSchema, isRoutingModeId } from './model-catalog.js';
import { MAX_AGENT_MODELS } from './model-catalog.js';
import { agentAccessSchema, type ConnectionDefaults, type ToolBoundary } from './agent-access.js';
import { orchestrationSchema, type OrchestrationState, type ModelMark } from './orchestration.js';
export type { ModelMark } from './orchestration.js';

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/);
const jsonObject = z.record(z.string(), z.unknown());
/** A host name, optionally `*.`-prefixed for its subdomains (no scheme, port or path). */
export const domainPattern = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i,
  );
export const effectSchema = z.enum(['read', 'idempotent-write', 'write', 'unknown']);
export type Effect = z.infer<typeof effectSchema>;
export const capabilitySchema = z
  .object({
    id: key,
    version: z.string().min(1).max(128),
    description: z.string().max(4000),
    placement: z.enum(['portable', 'host-bound']),
    nodeId: key.optional(),
    effect: effectSchema.default('unknown'),
    inputSchema: jsonObject,
    requiresApproval: z.boolean().default(false),
    timeoutMs: z.number().int().min(10).max(1_800_000).default(60_000),
    cacheTtlMs: z.number().int().min(0).max(3_600_000).default(0),
    resourceKey: z.string().max(200).optional(),
    resultExport: z.boolean().default(true),
    /**
     * Domains a sandboxed script may reach (docs/sandbox-design.md). Effective only within the
     * worker owner's `sandbox.allowDomains`; ignored for host execution.
     */
    network: z
      .object({ allowedDomains: z.array(domainPattern).max(50) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((x) => x.placement !== 'host-bound' || !!x.nodeId, 'host-bound capabilities need nodeId');
export type CapabilityManifest = z.infer<typeof capabilitySchema>;
export const builtinToolNames = [
  'read_file',
  'write_file',
  'list_files',
  'read_skill',
  'memory_read',
  'memory_write',
] as const;
export type BuiltinToolName = (typeof builtinToolNames)[number];
export const bindingSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    capability: capabilitySchema,
    required: z.boolean().optional(),
    handler: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('builtin'),
          name: z.enum(builtinToolNames),
        })
        .strict(),
      z
        .object({
          kind: z.literal('script'),
          path: z.string(),
          runtime: z.enum(['node', 'python3']),
        })
        .strict(),
      z.object({ kind: z.literal('node'), reference: key }).strict(),
    ]),
  })
  .strict();
export type ToolBinding = z.infer<typeof bindingSchema>;
export const workflowSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    description: z.string().max(4000).default(''),
    inputSchema: jsonObject.default({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    steps: z.array(jsonObject).min(1).max(32),
    output: z.unknown().optional(),
    outputSchema: jsonObject.optional(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export const delegateSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    agent: key,
    model: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).default(''),
    timeoutMs: z.number().int().min(100).max(1_800_000).default(120_000),
    forwardFiles: z.boolean().default(false),
  })
  .strict();
export type DelegateBinding = z.infer<typeof delegateSchema>;
export const agentSchema = z
  .object({
    id: key,
    description: z.string().max(4000),
    instructions: z.string().max(100_000),
    engine: z
      .string()
      .regex(/^(kernel|codex|claude|antigravity|dsh|adapter\/[a-z0-9_-]+)$/)
      .default('kernel'),
    provider: key.default('default'),
    model: z.string().min(1).max(200),
    modelPolicy: modelPolicySchema.optional(),
    access: agentAccessSchema.optional(),
    orchestration: orchestrationSchema.optional(),
    tools: z.array(bindingSchema).max(100).default([]),
    skills: z
      .array(z.object({ name: key, description: z.string().max(4000), path: z.string() }).strict())
      .max(100)
      .default([]),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(100).default(16),
        maxOutputTokens: z.number().int().min(1).max(100_000).default(4096),
        timeoutMs: z.number().int().min(100).max(3_600_000).default(1_800_000),
        toolConcurrency: z.number().int().min(1).max(32).default(4),
        maxTotalTokens: z.number().int().min(1).max(10_000_000).default(200_000),
      })
      .default({
        maxTurns: 16,
        maxOutputTokens: 4096,
        timeoutMs: 1_800_000,
        toolConcurrency: 4,
        maxTotalTokens: 200_000,
      }),
    outputSchema: jsonObject.optional(),
    allowedNodes: z.array(key).min(1).optional(),
    allowGraph: z.boolean().default(true),
    /** 外部智能体运行中的权限请求：`ask`（缺省）转交所有者审批，`auto` 由发布策略直接批准。 */
    approvals: z.enum(['ask', 'auto']).optional(),
    workflows: z.array(workflowSchema).max(32).optional(),
    delegates: z.array(delegateSchema).max(32).optional(),
    routes: z.array(modelRouteSchema).max(MAX_AGENT_MODELS).default([]),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (
      (a.modelPolicy || a.access || a.orchestration) &&
      a.routes.some((route) => isRoutingModeId(route.id))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['routes'],
        message:
          'Route IDs auto, fast, best and eco are reserved for modes in policy-aware publications. Give concrete models distinct route IDs.',
      });
    if (
      a.access?.workspace === 'project' &&
      (a.access.trust !== 'private' || a.engine === 'kernel')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['access', 'workspace'],
        message:
          'Direct project working directories are supported only for trusted private external agents.',
      });
    if (
      a.modelPolicy?.allow &&
      (!a.modelPolicy.allow.includes(a.model) ||
        a.routes.some((r) => !a.modelPolicy!.allow!.includes(r.model)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['modelPolicy', 'allow'],
        message: 'The default and all declared routes must be included in the model allowlist.',
      });
    const callableNames = [
      ...a.tools.map((t) => t.name),
      ...(a.workflows ?? []).map((w) => w.name),
      ...(a.delegates ?? []).map((d) => d.name),
    ];
    if (new Set(callableNames).size !== callableNames.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate tool, workflow, or delegate name.' });
    if (callableNames.includes('execute_graph'))
      ctx.addIssue({ code: 'custom', message: 'execute_graph is reserved.' });
    if (new Set(a.routes.map((r) => r.id)).size !== a.routes.length)
      ctx.addIssue({ code: 'custom', message: 'Model route IDs must be unique.' });
    if (
      a.engine !== 'kernel' &&
      (a.tools.length ||
        a.skills.length ||
        (a.workflows?.length ?? 0) > 0 ||
        (a.delegates?.length ?? 0) > 0)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Native and external adapters use their host toolkits. Portable tool/skill bindings require the kernel engine.',
      });
    if (a.engine === 'kernel' && a.approvals === 'auto')
      ctx.addIssue({
        code: 'custom',
        path: ['approvals'],
        message:
          'approvals = auto applies to external agents only. Kernel tools are approved per tool through capability.requiresApproval.',
      });
  });
export type AgentDefinition = z.infer<typeof agentSchema>;
export const bundleSchema = z
  .object({
    format: z.literal('oaa.bundle.v1'),
    agent: agentSchema,
    files: z
      .array(
        z
          .object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            content: z.string().max(12_000_000),
          })
          .strict(),
      )
      .max(500),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AgentBundle = z.infer<typeof bundleSchema>;
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export const providerStateSchema = z
  .object({
    format: z.literal('oaa.provider-turn.v1'),
    protocol: z.enum(['openai-responses', 'anthropic-messages', 'gemini-generate']),
    target: z.string().regex(/^[a-f0-9]{64}$/),
    prefix: z.string().regex(/^[a-f0-9]{64}$/),
    projection: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(z.record(z.string(), z.unknown())).max(4096),
  })
  .strict();
export type ProviderTurnState = z.infer<typeof providerStateSchema>;
import type { ModelImage, RunImage } from './images.js';
import type { ExecutionCapabilities } from './execution-capabilities.js';
export type { ImageMode, ModelImage, RunImage } from './images.js';
export type ModelMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: ModelImage[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  providerItems?: unknown[];
  providerState?: ProviderTurnState;
};
export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };
export const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
export type ModelResult = {
  text: string;
  calls: ToolCall[];
  usage: Usage | null;
  providerItems?: unknown[];
  providerState?: ProviderTurnState;
  finish: 'stop' | 'tool_calls' | 'length';
};
export type FilePayload = {
  id: string;
  name: string;
  content: string;
  sha256: string;
  allowedNodes?: string[];
  workspacePath?: string;
};
export type ArtifactPayload = { name: string; content: string; sha256: string };
export type ToolResult = { value: unknown; artifacts?: ArtifactPayload[] };
export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'incomplete';
export const terminal = (s: RunStatus) =>
  ['completed', 'failed', 'cancelled', 'interrupted', 'incomplete'].includes(s);
/**
 * Model-turn boundaries kept in the durable checkpoint (not in the event log), so timelines can be
 * derived without adding events to compatibility streams. Times are epoch milliseconds.
 */
export type Checkpoint = {
  orchestration?: OrchestrationState;
  modelPool?: AgentDefinition['routes'];
  messages: ModelMessage[];
  /** Stable system prefix once a provider returns a bound native turn. */
  modelInstructions?: string;
  marks?: ModelMark[];
  turn: number;
  phase: 'model' | 'tools' | 'done';
  pending?: ToolCall[];
  nativeState?: Record<string, unknown>;
  approvalAuthority?: 'auto' | 'caller' | 'owner' | 'native';
  toolGrants?: ToolBoundary[];
  externalCaller?: boolean;
  /** 交接说明：本轮由另一个智能体交接而来、且本智能体是外部智能体时，放在输入前面。 */
  handoffBrief?: string;
  continuationBrief?: string;
  offeredTools?: string[];
  deadlineAt?: number;
  suspension?: { kind: 'approval' | 'scheduling'; approvalIds: string[] };
  grantedAgents?: string[];
  delegationDepth?: number;
  keyId?: string;
  /** Highest execution level the submitting key allowed; delegated sub-runs inherit it. */
  execution?: ExecutionLevel;
  /** Agents the submitting key may run at `host` despite `execution` (see Principal.hostAgents). */
  hostAgents?: string[];
  /**
   * The run's model calls must use a caller-supplied provider key (never the publisher's). Only
   * this flag is stored; the key itself stays in gateway memory.
   */
  byok?: boolean;
  /**
   * Caller tools bridged into this run (docs/harness.md): declared by the caller, offered to the
   * model next to the published tools, executed by the caller. `delivered` counts the output
   * messages already handed to the caller, so a continuation only returns what is new.
   */
  bridge?: { tools: ClientTool[]; delivered: number; boundary?: 'client' | 'hybrid' };
  /** Structured output (docs/structured-output.md): `repairs` correction rounds allowed, `used` spent so far. */
  outputContract?: OutputContract & { repairs: number; used?: number };
};
/** What `response_format` / `text.format` / `responseSchema` / `output_config.format` asks for. */
export type OutputContract = {
  kind: 'json_object' | 'json_any' | 'json_schema';
  schema?: Record<string, unknown>;
  name?: string;
  strict?: boolean;
  /** The caller's own format object, echoed in the Responses `text.format` field. */
  format?: Record<string, unknown>;
};
/** A tool declared by the caller in a bridged compatibility request. */
export type ClientTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};
export type OutputMessage = {
  id: string;
  text: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
};
export type Run = {
  id: string;
  owner: string;
  /** Caller data partition (schema v4). Absent only on payloads read before migration. */
  subject?: string;
  agentId: string;
  digest: string;
  sessionId: string;
  previousId: string | null;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  input: string;
  fileIds: string[];
  /** Image inputs (docs/images.md); stored images are also listed in `fileIds`. */
  images?: RunImage[];
  output: OutputMessage[];
  usage: Usage | null;
  checkpoint: Checkpoint;
  error: { code: string; message: string } | null;
  artifactIds: string[];
  metadata: Record<string, string>;
  route: { id: string; provider: string; model: string; mode: 'auto' | 'explicit' };
};
export type RunEvent = {
  id: number;
  runId: string;
  type: string;
  time: number;
  data: Record<string, unknown>;
};
export type ExecutionStep = {
  id: string;
  runId: string;
  callId: string;
  name: string;
  effect: Effect;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';
  arguments: Record<string, unknown>;
  result?: ToolResult;
  nodeId?: string;
  error?: string;
  /** Epoch ms when a node started this step (set for native executions). */
  startedAt?: number;
  /** 委托步骤：已提交的子运行 ID（提交成功后、开始等待前登记；恢复重放时据此重新挂上子运行）。 */
  childRunId?: string;
};
export const keyQuotaSchema = z
  .object({
    rpm: z.number().int().min(1).max(100_000).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
    maxTotalTokens: z.number().int().min(1).max(1_000_000_000).optional(),
    maxRuns: z.number().int().min(1).max(10_000_000).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();
export type KeyQuota = z.infer<typeof keyQuotaSchema>;
export type Principal = {
  externalCaller?: boolean;
  connection?: ConnectionDefaults;
  owner: string;
  name: string;
  agents: string[];
  scopes: string[];
  keyId?: string;
  quota?: KeyQuota;
  /** Developer-platform account behind this key (account keys only; subject is `acct:<id>`). */
  accountId?: string;
  /**
   * Data partition of this caller (runs, files, memories, idempotency keys). Defaults to the API
   * key ID; a delegated sub-run inherits its parent's subject.
   */
  subject?: string;
  /**
   * `owner` lets a non-admin key (for example a read-only dashboard) see every caller's runs and
   * files for its granted agents. Default `own`: only this key's subject.
   */
  dataScope?: 'own' | 'owner';
  /** Highest execution level this key may start. Absent means `host` (pre-P1 behaviour). */
  execution?: ExecutionLevel;
  /**
   * Agents this key may run at `host` although `execution` is lower: developer-platform listings
   * whose owner explicitly opted in (docs/platform.md). Per agent: never inherited by delegates.
   */
  hostAgents?: string[];
};
/**
 * `workspace`: the kernel's model loop with built-in tools only, confined to the run's session
 * workspace. `sandbox`: additionally portable scripts, run only inside a worker's verified OS
 * sandbox. `host`: native agents, adapters, owner scripts and node-bound host tools, which act
 * with the worker host's authority.
 */
export const executionLevels = ['workspace', 'sandbox', 'host'] as const;
export type ExecutionLevel = (typeof executionLevels)[number];
/** The level a published agent needs, derived from its engine and tool bindings. */
export function requiredExecution(agent: AgentDefinition): ExecutionLevel {
  if (agent.engine !== 'kernel') return 'host';
  return agent.tools.some((t) => t.handler.kind !== 'builtin') ? 'host' : 'workspace';
}
/**
 * Whether a `host` agent can instead run entirely inside a worker's OS sandbox: kernel agents whose
 * non-builtin tools are all portable scripts (S1), and the Claude and Codex CLIs with an isolated
 * HOME and the caller's own key (S2a). Node-bound host tools always need `host` (they exist to
 * reach the owner's resources).
 */
export function sandboxable(agent: AgentDefinition): boolean {
  if (agent.engine === 'claude' || agent.engine === 'codex') return true;
  return agent.engine === 'kernel' && agent.tools.every((t) => t.handler.kind !== 'node');
}
/** What a principal may start. Admin keys are the owner's own management keys. */
export function allowedExecution(p: Principal): ExecutionLevel {
  return p.scopes.includes('admin') ? 'host' : (p.execution ?? 'host');
}
/** The level a principal gets for one agent: `host` for agents it was explicitly opted into. */
export function executionFor(p: Principal, agentId: string): ExecutionLevel {
  return p.hostAgents?.includes(agentId) ? 'host' : allowedExecution(p);
}
/** Whether a run's own work goes into a worker sandbox (sandbox key, agent not opted into host). */
export function runSandboxed(run: { agentId: string; checkpoint: Checkpoint }): boolean {
  return (
    run.checkpoint.execution === 'sandbox' && !run.checkpoint.hostAgents?.includes(run.agentId)
  );
}
export function executionPermits(allowed: ExecutionLevel, required: ExecutionLevel): boolean {
  return executionLevels.indexOf(required) <= executionLevels.indexOf(allowed);
}
/** Partition for rows written before schema v4 whose caller cannot be determined. */
export const LEGACY_SUBJECT = 'legacy';
/** The caller's own data partition: where its new runs, files and memories are written. */
export function principalSubject(p: Principal): string {
  return p.subject ?? p.keyId ?? `owner:${p.owner}`;
}
/** Owner-wide admins (admin scope and every agent) may also address another caller's memories. */
export function isOwnerWide(p: Principal): boolean {
  return p.scopes.includes('admin') && p.agents.includes('*');
}
/**
 * Read filter for caller runs and files: `undefined` means every subject of the owner (admin keys
 * and `dataScope: 'owner'` keys, still limited to their granted agents); otherwise only the
 * caller's own subject.
 */
export function visibleSubject(p: Principal): string | undefined {
  return p.scopes.includes('admin') || p.dataScope === 'owner' ? undefined : principalSubject(p);
}
export type NodeAdvertisement = {
  nodeId: string;
  providers: string[];
  natives: string[];
  capabilities: CapabilityManifest[];
  warm: string[];
  concurrency: number;
  execution?: ExecutionCapabilities;
};
export {
  executionCapabilitiesSchema,
  type ExecutionCapabilities,
} from './execution-capabilities.js';
export type WorkContext = {
  runId: string;
  sessionId: string;
  owner: string;
  digest: string;
  files: FilePayload[];
  /** This turn's stored image inputs (bytes are in `files`); external engines read them here. */
  images?: { fileId: string; mime: string; workspacePath: string }[];
};
export type Work =
  | {
      kind: 'model';
      agent: AgentDefinition;
      messages: ModelMessage[];
      context: WorkContext;
      toolNames?: string[];
      toolBoundary?: 'client';
      /**
       * Output-length cap the caller asked for, below the published `limits.maxOutputTokens`
       * (compatibility `max_tokens` and friends). The worker applies the smaller of the two; it is
       * a separate field because the agent itself must stay identical to the published one.
       * Optional on the wire: a node that does not know it uses the published limit.
       */
      maxOutputTokens?: number;
      /**
       * Caller-supplied provider key (BYOK). Held in gateway memory only, sent to a worker that
       * advertised BYOK for this provider, used for this one call and never persisted.
       */
      credential?: { apiKey: string };
    }
  | {
      kind: 'tool';
      binding: ToolBinding;
      arguments: Record<string, unknown>;
      context: WorkContext;
      /** `sandbox`: a script must run inside the worker's OS sandbox, or not at all. */
      isolation?: 'sandbox';
    }
  | {
      kind: 'native';
      toolsDisabled?: boolean;
      agent: AgentDefinition;
      input: string;
      nativeState?: Record<string, unknown>;
      context: WorkContext;
      /** `sandbox`: run the CLI inside the worker's OS sandbox with an isolated HOME, or not at all. */
      isolation?: 'sandbox';
      /** The caller's provider key for a sandboxed native agent (memory only, never persisted). */
      credential?: { apiKey: string };
      /**
       * Caller tools to project into the agent's own harness as MCP tools (bridge mode, ACP only).
       * Sent only to workers that declared `execution.clientTools` for this engine.
       */
      clientTools?: ClientTool[];
    };
export type WorkResult =
  | ModelResult
  | ToolResult
  | {
      text: string;
      nativeState: Record<string, unknown>;
      usage: Usage | null;
      artifacts?: ArtifactPayload[];
    };
/**
 * `client_tool` (bridge mode): data `{ name, arguments, relay_call_id }`; the answer is
 * `{ output: string }` or `{ error: string }`.
 */
export type WorkEvent = {
  type: 'text' | 'progress' | 'approval' | 'client_tool';
  data: Record<string, unknown>;
};
export type NodeCredential = {
  nodeId: string;
  owner: string;
  token: string;
  capabilities: string[];
  agents: string[];
};
export type NodePolicyState = 'active' | 'draining' | 'revoked';
export const nodePolicySchema = z
  .object({
    nodeId: z.string().min(1).max(120),
    owner: z.string(),
    state: z.enum(['active', 'draining', 'revoked']),
    actor: z.string(),
    reason: z.string().max(1000),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NodePolicy = z.infer<typeof nodePolicySchema>;
