import { z } from 'zod';
import { toolChoicePolicySchema } from '../core/tool-choice.js';

/** Structured output the caller asked for; checked when the run finishes (kernel/output-contract.ts). */
export const outputContractSchema = z
  .object({
    kind: z.enum(['json_object', 'json_any', 'json_schema']),
    schema: z.record(z.string(), z.unknown()).optional(),
    name: z.string().max(64).optional(),
    strict: z.boolean().optional(),
    format: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
/**
 * One image of a request, in the normalized form every entry produces: inline base64 `data`
 * (with the declared media type), an `https` `url`, or a stored `file_id`. `param` names the
 * content part it came from (for `error.param`); `mime` is set by the gateway after sniffing.
 */
export const imageInputSchema = z.union([
  z
    .object({
      data: z.string().max(24 * 1024 * 1024),
      media_type: z.string().max(120).optional(),
      param: z.string().max(200).optional(),
    })
    .strict(),
  z.object({ url: z.string().min(1).max(8192), param: z.string().max(200).optional() }).strict(),
  z
    .object({
      file_id: z.string().min(1).max(120),
      mime: z.string().max(120).optional(),
      param: z.string().max(200).optional(),
    })
    .strict(),
]);
export type ImageInput = z.infer<typeof imageInputSchema>;

export const invocationSchema = z
  .object({
    protocol: z.literal('oaa/1').default('oaa/1'),
    agent: z.string().min(1).max(120),
    model: z.string().min(1).max(200).default('auto'),
    input: z.string().min(1).max(200_000),
    file_ids: z.array(z.string()).max(20).default([]),
    /** Image inputs (docs/images.md); `data` is stored as an input file before submission. */
    images: z.array(imageInputSchema).max(20).optional(),
    previous_response_id: z.string().optional(),
    agent_version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    background: z.boolean().default(false),
    stream: z.boolean().default(false),
    metadata: z.record(z.string().max(64), z.string().max(512)).default({}),
    /** 智能体交接：允许续接到另一个智能体或另一条模型线路。等价写法：metadata["oaa.handoff"]="true"。 */
    handoff: z.boolean().optional(),
    /** 桥接模式下调用方声明的工具（docs/harness.md）；名字、冲突与 schema 在 submit 时检查。 */
    client_tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            description: z.string().max(4000).optional(),
            parameters: z.record(z.string(), z.unknown()),
          })
          .strict()
          .refine(
            (t) => JSON.stringify(t.parameters).length <= 16_384,
            'Tool schema exceeds 16 KiB.',
          ),
      )
      .max(64)
      .refine((t) => JSON.stringify(t).length <= 262_144, 'Caller tools exceed 256 KiB in total.')
      .optional(),
    /** 调用方回传的工具结果：`call_id` 是此前返回的 tool_calls 的 ID。 */
    client_results: z
      .array(
        z
          .object({ call_id: z.string().min(1).max(120), output: z.string().max(1_048_576) })
          .strict(),
      )
      .max(64)
      .optional(),
    output_contract: outputContractSchema.optional(),
    tool_choice: toolChoicePolicySchema.optional(),
  })
  .strict();
export type Invocation = z.infer<typeof invocationSchema>;

export const previewSchema = z
  .object({
    agent: z.string().min(1).max(120),
    model: z.string().min(1).max(200).default('auto'),
    file_ids: z.array(z.string()).max(20).default([]),
    previous_response_id: z.string().optional(),
    agent_version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    handoff: z.boolean().optional(),
  })
  .strict();
export type PreviewRequest = z.infer<typeof previewSchema>;

/**
 * 这次运行实际的输出长度上限：智能体自身的 `limits.maxOutputTokens` 与调用方请求的上限
 * （兼容入口写在 `metadata["oaa.max_output_tokens"]`，旧的 compat 端点写在
 * `metadata["oaa.compat_max_tokens"]`）取较小者。请求值无效时忽略；调用方只能调低，不能调高。
 */
export function outputTokenCap(metadata: Record<string, string>, agentMax: number): number {
  let cap = agentMax;
  for (const key of ['oaa.max_output_tokens', 'oaa.compat_max_tokens']) {
    const raw = metadata[key];
    if (raw === undefined || !/^[1-9]\d{0,8}$/.test(raw)) continue;
    cap = Math.min(cap, Number(raw));
  }
  return cap;
}
