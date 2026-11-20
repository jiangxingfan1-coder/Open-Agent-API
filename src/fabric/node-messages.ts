/**
 * 网关一侧对节点上行消息的结构校验（线协议见 docs/protocol.md「Node wire
 * protocol」）。节点持有有效凭据，但有 bug 或被攻破时发来的结构错误数据不能在内核深处以
 * TypeError 暴露，也不能写进检查点。
 *
 * 兼容性：既有字段不改名、不删除、不改含义；旧版节点合法的消息（可选字段缺失）照常接受；
 * 对象一律 passthrough，新版节点多带的字段原样保留、不当错误。
 */
import { z } from 'zod';
import type { Work, WorkEvent } from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';

const usageSchema = z
  .object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    total_tokens: z.number().nonnegative(),
  })
  .passthrough();
const artifactSchema = z
  .object({
    name: z.string().max(1024),
    content: z.string(),
    sha256: z.string().max(128),
    localPath: z.never().optional(),
    transferIndex: z.number().int().min(0).max(99).optional(),
  })
  .passthrough();
const artifactsSchema = z.array(artifactSchema).max(1000).optional();
/**
 * `usage` 缺失或不合规（例如某个原生引擎没报某一项，序列化后成了 null）都按 null（未知用量）
 * 处理：与「节点没报用量」同义，不让运行因此失败，也不把 NaN 记进用量。
 */
const usageField = usageSchema.nullable().catch(null);

const modelResultSchema = z
  .object({
    text: z.string(),
    calls: z
      .array(
        z
          .object({
            id: z.string().max(512),
            name: z.string().max(512),
            arguments: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      )
      .max(4096),
    usage: usageField,
    finish: z.enum(['stop', 'tool_calls', 'length']).optional(),
    providerItems: z.array(z.unknown()).optional(),
    providerState: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
// 工具返回 undefined 时 JSON 里没有 value 字段，所以 value 可以缺失。
const toolResultSchema = z
  .object({ value: z.unknown().optional(), artifacts: artifactsSchema })
  .passthrough();
const nativeResultSchema = z
  .object({
    text: z.string(),
    nativeState: z.record(z.string(), z.unknown()),
    usage: usageField,
    artifacts: artifactsSchema,
  })
  .passthrough();

/** 按请求的种类校验 `result`；install 的结果网关不读，只要求是对象或缺失。 */
export function workResultSchema(kind: 'install' | Work['kind']): z.ZodType<unknown> {
  if (kind === 'model') return modelResultSchema;
  if (kind === 'tool') return toolResultSchema;
  if (kind === 'native') return nativeResultSchema;
  return z.record(z.string(), z.unknown()).optional();
}

const ref = { id: z.string().min(1).max(200), leaseId: z.string().min(1).max(200) };
export const ARTIFACT_CHUNK_BYTES = 128 * 1024;
export const NODE_HANDSHAKE_MS = 5_000;
const chunkSchema = z
  .object({
    type: z.literal('artifact_chunk'),
    ...ref,
    index: z.number().int().min(0).max(99),
    offset: z.number().int().nonnegative(),
    bytes: z.number().int().positive().max(LIMITS.maxArtifactExportBytes),
    name: z.string().min(1).max(240),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(ARTIFACT_CHUNK_BYTES / 3)),
  })
  .strict();
export type ArtifactChunk = z.infer<typeof chunkSchema>;
const eventSchema = z
  .object({
    type: z.literal('event'),
    ...ref,
    actionId: z.string().max(200).optional(),
    event: z
      .object({
        type: z.enum(['text', 'progress', 'approval', 'client_tool']),
        data: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();
// 错误码只接受 snake_case 的短标识；不合规的按 worker_failed 处理，说明截断到 4000 字符。
const errorSchema = z
  .object({
    code: z.unknown().optional(),
    message: z.unknown().optional(),
    uncertain: z.unknown().optional(),
  })
  .passthrough();
const resultSchema = z
  .object({
    type: z.literal('result'),
    ...ref,
    result: z.unknown().optional(),
    error: errorSchema.optional(),
  })
  .passthrough();

export type NodeMessage =
  | ArtifactChunk
  | { type: 'heartbeat' }
  | { type: 'advertisement'; advertisement: unknown; execution: unknown }
  | { type: 'event'; id: string; leaseId: string; actionId?: string; event: WorkEvent }
  | {
      type: 'result';
      id: string;
      leaseId: string;
      result?: unknown;
      error?: { code: string; message: string; uncertain: boolean };
    }
  | { type: 'unknown'; name: string };

export class NodeProtocolError extends Error {}

/**
 * 解析一条上行消息。JSON 无效、超大、已知类型的字段不合规时抛 NodeProtocolError（调用方以
 * 1008 关闭连接）；不认识的类型返回 `unknown`（向前兼容：调用方记录后忽略）。
 */
export function parseNodeMessage(raw: string): NodeMessage {
  if (Buffer.byteLength(raw) > LIMITS.nodeMessageBytes)
    throw new NodeProtocolError('message exceeds nodeMessageBytes');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new NodeProtocolError('message is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NodeProtocolError('message is not an object');
  const type = (value as { type?: unknown }).type;
  if (type === 'heartbeat') return { type };
  if (type === 'artifact_chunk') {
    const parsed = chunkSchema.safeParse(value);
    if (!parsed.success) throw new NodeProtocolError('invalid artifact chunk');
    return parsed.data;
  }
  if (type === 'advertisement') {
    const v = value as { advertisement?: unknown; execution?: unknown };
    return { type, advertisement: v.advertisement, execution: v.execution };
  }
  if (type === 'event') {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) throw new NodeProtocolError(`invalid event: ${issue(parsed.error)}`);
    const { id, leaseId, actionId, event } = parsed.data;
    return { type, id, leaseId, ...(actionId ? { actionId } : {}), event: event as WorkEvent };
  }
  if (type === 'result') {
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success) throw new NodeProtocolError(`invalid result: ${issue(parsed.error)}`);
    const { id, leaseId, result, error } = parsed.data;
    if (!error) return { type, id, leaseId, result };
    const code =
      typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'worker_failed';
    const message =
      typeof error.message === 'string' ? error.message.slice(0, 4000) : 'Worker failed.';
    return { type, id, leaseId, error: { code, message, uncertain: error.uncertain === true } };
  }
  return { type: 'unknown', name: typeof type === 'string' ? type.slice(0, 64) : typeof type };
}

/** 校验执行结果；不合规时抛 NodeProtocolError。 */
export function checkWorkResult(kind: 'install' | Work['kind'], result: unknown): unknown {
  const parsed = workResultSchema(kind).safeParse(result);
  if (!parsed.success)
    throw new NodeProtocolError(`invalid ${kind} result: ${issue(parsed.error)}`);
  return parsed.data;
}

function issue(error: z.ZodError): string {
  const first = error.issues[0];
  return first ? `${first.path.join('.') || '(root)'}: ${first.message}`.slice(0, 200) : 'invalid';
}
