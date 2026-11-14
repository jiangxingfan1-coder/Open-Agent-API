/**
 * OpenAI 两个入口（Chat Completions、Responses）的内容块处理，与 Claude、Gemini 入口同一规则：
 * 文本照常；引用已上传文件的块走附件通道；工具调用与工具结果用标注文本；内联图片、音频与其它不认识的块明确拒绝（400 `unsupported_content`），
 * 不把 base64 或原始 JSON 塞进提示词。
 */
import { CompatFault } from './compat-errors.js';

type Part = Record<string, unknown>;

const TEXT_TYPES = new Set(['text', 'input_text', 'output_text']);

export function unsupportedContent(param: string, what: string): CompatFault {
  return new CompatFault(
    'unsupported_content',
    `${param}: ${what} This endpoint does not accept inline images or audio; the agent receives text and files only. Upload the file with POST /v1/files and reference it as {"type":"input_file","file_id":"…"} (Responses) or {"type":"file","file":{"file_id":"…"}} (Chat).`,
    400,
    param,
  );
}

const describe = (p: unknown) =>
  p && typeof p === 'object'
    ? `content parts of type "${String((p as Part).type)}" are not supported.`
    : `content parts of JSON type "${p === null ? 'null' : typeof p}" are not supported.`;

/** 一个内容块渲染成文本；文件引用记入 `files`；其余拒绝。 */
export function renderOpenAIPart(p: unknown, param: string, files: string[]): string {
  if (typeof p === 'string') return p;
  if (!p || typeof p !== 'object') throw unsupportedContent(param, describe(p));
  const part = p as Part;
  if (TEXT_TYPES.has(String(part.type)) && typeof part.text === 'string') return part.text;
  if (part.type === 'input_file' && typeof part.file_id === 'string') {
    files.push(part.file_id);
    return `[Attached file ${part.file_id}]`;
  }
  const file = part.file as Part | undefined;
  if (part.type === 'file' && typeof file?.file_id === 'string') {
    files.push(file.file_id);
    return `[Attached file ${file.file_id}]`;
  }
  throw unsupportedContent(param, describe(p));
}

/**
 * 严格 Responses 端点只认 `message` 输入项（`type` 可省略）：`function_call`、`function_call_output`、
 * `reasoning`、`item_reference` 等带有工具或服务端状态，改走兼容端点；先于 zod 校验，错误里点明项的位置。
 */
export function rejectNonMessageItems(body: unknown, compat: string): void {
  const input = (body as Part | null)?.input;
  if (!Array.isArray(input)) return;
  input.forEach((item, i) => {
    const type = (item as Part | null)?.type;
    if (typeof type === 'string' && type !== 'message')
      throw new CompatFault(
        'unsupported_content',
        `input.${i}: input items of type "${type}" are not supported on this endpoint. Tool calls and their results are accepted on ${compat} (Base URL <origin>/v1/compat, or X-OAA-Compat: true).`,
        400,
        `input.${i}`,
      );
  });
}

/** `function_call_output.output`：字符串原样；内容块数组逐块渲染；其它结构作为工具结果的 JSON。 */
export function renderToolOutput(output: unknown, param: string, files: string[]): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output))
    return output.map((p, k) => renderOpenAIPart(p, `${param}.${k}`, files)).join('\n');
  return JSON.stringify(output ?? '');
}

/**
 * 严格端点在 zod 校验前先查内容块：判别联合认不出的块（图片、音频等）报 `unsupported_content`，
 * 而不是泛泛的 `invalid_request`。只查块的 `type`，字段是否齐全仍交给 zod。
 */
export function rejectUnsupportedParts(
  body: unknown,
  field: 'messages' | 'input',
  allowed: ReadonlySet<string>,
): void {
  const list = (body as Part | null)?.[field];
  if (!Array.isArray(list)) return;
  list.forEach((m, i) => {
    const content = (m as Part | null)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((p, j) => {
      if (p && typeof p === 'object' && typeof (p as Part).type === 'string') {
        if (!allowed.has((p as Part).type as string))
          throw unsupportedContent(`${field}.${i}.content.${j}`, describe(p));
      }
    });
  });
}
