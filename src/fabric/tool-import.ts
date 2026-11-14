import path from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { JsonSchemas } from '../core/schemas.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { capabilitySchema, bindingSchema } from '../core/contracts.js';
import {
  gatewaySchema,
  workerSchema,
  workerToolSchema,
  type WorkerConfig,
} from '../config/config.js';
import {
  McpConnections,
  findMcpTool,
  toolDescriptor,
  descriptorDigest,
} from './mcp-connections.js';
import { assertPublishableMetadata } from '../lang/bundle.js';
import { Fault, canonical, checkAbort, id, readBounded, sha, writePrivate } from '../core/util.js';
import { textPrefix } from '../store/inspection.js';

async function selectedJson(file: string): Promise<unknown> {
  const absolute = path.resolve(file);
  return JSON.parse(
    (await readBounded(path.dirname(absolute), path.basename(absolute), 1_000_000)).toString(
      'utf8',
    ),
  );
}
export async function selectedWorker(file: string): Promise<WorkerConfig> {
  const raw = await selectedJson(file);
  if (raw && typeof raw === 'object' && 'nodeId' in raw) return workerSchema.parse(raw);
  const gateway = gatewaySchema.parse(raw);
  if (!gateway.localWorker)
    throw new Fault(
      'worker_required',
      'Select a worker config or a gateway config with a localWorker.',
    );
  return gateway.localWorker;
}
export async function withToolConfigs(
  config: WorkerConfig,
  files: string[],
): Promise<WorkerConfig> {
  const next = workerSchema.parse(config);
  for (const file of files) {
    const tool = workerToolSchema.parse(await selectedJson(file));
    if (
      next.tools.some(
        (existing) =>
          existing.reference === tool.reference ||
          (existing.capability.id === tool.capability.id &&
            existing.capability.version === tool.capability.version),
      )
    )
      throw new Fault(
        'tool_conflict',
        'A selected tool configuration duplicates an existing reference or capability.',
      );
    if (tool.capability.nodeId && tool.capability.nodeId !== next.nodeId)
      throw new Fault('host_binding', 'The selected tool belongs to a different worker node.');
    if (tool.handler.kind === 'mcp' && !next.mcp[tool.handler.server])
      throw new Fault(
        'mcp_unconfigured',
        'The selected tool references an MCP server absent from this worker.',
      );
    next.tools.push(tool);
  }
  return next;
}
export async function inspectMcp(
  config: WorkerConfig,
  server: string,
  options: { tool?: string; cursor?: string; signal?: AbortSignal } = {},
) {
  const pool = new McpConnections(config);
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    return await pool.use(
      server,
      { owner: config.owner, sessionId: id('inspection'), digest: 'inspection' },
      signal,
      async (client) => {
        if (options.tool) {
          const tool = await findMcpTool(client, options.tool, signal);
          const descriptor = toolDescriptor(tool);
          assertPublishableMetadata(descriptor);
          return {
            server,
            node: config.nodeId,
            descriptor,
            descriptor_sha256: descriptorDigest(tool),
            tool_calls: 0,
            annotations_are_permissions: false,
          };
        }
        const page = await client.listTools(options.cursor ? { cursor: options.cursor } : {}, {
          timeout: 15000,
          signal,
        });
        if (page.tools.length > 200)
          throw new Fault(
            'mcp_catalog_limit',
            'One MCP catalog page exceeds 200 tools. Configure server-side pagination.',
          );
        return {
          server,
          node: config.nodeId,
          tool_calls: 0,
          next_cursor: page.nextCursor ?? null,
          tools: page.tools.map((tool) => {
            let publishable = true;
            try {
              assertPublishableMetadata(toolDescriptor(tool));
            } catch {
              publishable = false;
            }
            return {
              name: publishable ? tool.name : '[unpublishable-tool]',
              description: publishable
                ? textPrefix(tool.description ?? '', 500)
                : '[metadata omitted: potential credential or excessive depth]',
              descriptor_sha256: publishable ? descriptorDigest(tool) : null,
              publishable,
              task_mode_supported: tool.execution?.taskSupport !== 'required',
              annotation_hints: publishable ? (tool.annotations ?? {}) : {},
            };
          }),
        };
      },
    );
  } finally {
    await pool.close();
  }
}
export const preparationSchema = z
  .object({
    server: z.string().min(1),
    tool: z.string().min(1),
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
      .optional(),
    capability: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/),
    version: z.string().min(1).max(128).optional(),
    effect: z.enum(['read', 'idempotent-write', 'write', 'unknown']).default('unknown'),
    approval: z.enum(['always', 'none']).default('always'),
    exportResult: z.boolean().default(false),
    optional: z.boolean().default(false),
    out: z.string().min(1),
  })
  .strict();
export function preparedTool(
  config: WorkerConfig,
  tool: Tool,
  raw: z.input<typeof preparationSchema>,
) {
  const options = preparationSchema.parse(raw);
  if (tool.execution?.taskSupport === 'required')
    throw new Fault(
      'mcp_task_mode_unsupported',
      'This tool requires MCP task-augmented execution, which the current worker does not implement. Use an explicit host adapter.',
    );
  assertPublishableMetadata(toolDescriptor(tool));
  if (Buffer.byteLength(canonical(toolDescriptor(tool))) > 200_000)
    throw new Fault('mcp_descriptor_too_large', 'Selected tool metadata exceeds 200 KiB.');
  const inputSchema = {
    ...tool.inputSchema,
    $schema: tool.inputSchema.$schema ?? 'https://json-schema.org/draft/2020-12/schema',
  };
  new JsonSchemas().compile(inputSchema);
  const digest = descriptorDigest(tool);
  let alias = tool.name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(alias)) alias = `tool_${alias}`;
  if (alias.length > 64) alias = alias.slice(0, 52) + '_' + sha(tool.name).slice(0, 10);
  const reference = `mcp_${sha(canonical([options.server, tool.name])).slice(0, 24)}`;
  const policy = {
    node: config.nodeId,
    capability: options.capability,
    descriptor: digest,
    effect: options.effect,
    approval: options.approval,
    exportResult: options.exportResult,
  };
  const capability = capabilitySchema.parse({
    id: options.capability,
    version: options.version ?? `mcp:${sha(canonical(policy))}`,
    description: tool.description?.slice(0, 4000) || `Selected MCP tool: ${tool.name}`,
    placement: 'host-bound',
    nodeId: config.nodeId,
    inputSchema,
    effect: options.effect,
    requiresApproval: options.approval === 'always',
    resultExport: options.exportResult,
  });
  const binding = bindingSchema.parse({
    name: options.name ?? alias,
    required: !options.optional,
    capability,
    handler: { kind: 'node', reference },
  });
  const workerTool = workerToolSchema.parse({
    reference,
    capability,
    handler: { kind: 'mcp', server: options.server, tool: tool.name, descriptorSha256: digest },
  });
  return {
    binding,
    workerTool,
    review: {
      descriptor_sha256: digest,
      annotations_are_permissions: false,
      declared_policy: policy,
      ready_for_result_export: options.exportResult,
      live_worker_configuration_changed: false,
      tool_calls: 0,
      description_truncated: (tool.description?.length ?? 0) > 4000,
    },
  };
}
export async function prepareMcp(
  config: WorkerConfig,
  raw: z.input<typeof preparationSchema>,
  abort?: AbortSignal,
) {
  const options = preparationSchema.parse(raw);
  const root = path.resolve(options.out);
  try {
    await lstat(root);
    throw new Fault(
      'output_exists',
      'Preparation output already exists. Choose a new directory; no MCP server was started.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pool = new McpConnections(config);
  let prepared: ReturnType<typeof preparedTool>;
  try {
    const deadline = AbortSignal.timeout(30_000);
    const signal = abort ? AbortSignal.any([abort, deadline]) : deadline;
    prepared = await pool.use(
      options.server,
      { owner: config.owner, sessionId: id('preparation'), digest: 'preparation' },
      signal,
      async (client) =>
        preparedTool(config, await findMcpTool(client, options.tool, signal), options),
    );
  } finally {
    await pool.close();
  }
  if (abort) checkAbort(abort);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const outputs = {
    'binding.json': prepared.binding,
    'worker-tool.json': prepared.workerTool,
    'review.json': prepared.review,
  };
  for (const [name, value] of Object.entries(outputs))
    await writePrivate(root, name, JSON.stringify(value, null, 2) + '\n', true);
  return {
    directory: root,
    binding: path.join(root, 'binding.json'),
    worker_tool: path.join(root, 'worker-tool.json'),
    review: path.join(root, 'review.json'),
    ...prepared.review,
  };
}
