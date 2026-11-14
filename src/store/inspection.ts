import { z } from 'zod';
import { terminal, type OutputMessage, type RunStatus } from '../core/contracts.js';
import { Fault } from '../core/util.js';

const cursorSchema = z
  .object({
    run: z.string(),
    index: z.number().int().nonnegative().max(100000),
    offset: z.number().int().nonnegative().max(1000000),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decodeCursor(value: string, runId: string): Cursor {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Noncanonical cursor');
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (cursor.run !== runId) throw new Error('Wrong response');
    return cursor;
  } catch {
    throw new Fault('invalid_cursor', 'Output cursor is invalid or belongs to another response.');
  }
}
const high = (value: number) => value >= 0xd800 && value <= 0xdbff;
const low = (value: number) => value >= 0xdc00 && value <= 0xdfff;

// Bound the serialized JSON string, including escapes, rather than assuming characters are bytes.
export function textPrefix(text: string, bytes: number): string {
  const ends = [0];
  let offset = 0;
  for (const point of text.slice(0, bytes + 1)) {
    offset += point.length;
    if (offset > bytes) break;
    ends.push(offset);
  }
  let left = 0,
    right = ends.length - 1;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, ends[middle]))) <= bytes) left = middle;
    else right = middle - 1;
  }
  return text.slice(0, ends[left]);
}
export function outputPage(
  run: { id: string; status: RunStatus; output: OutputMessage[] },
  cursor?: string,
  maxBytes = 8000,
) {
  const at = cursor ? decodeCursor(cursor, run.id) : { run: run.id, index: 0, offset: 0 };
  if (at.index > run.output.length)
    throw new Fault('invalid_cursor', 'Output item does not exist.');
  const item = run.output[at.index];
  if (
    at.offset > (item?.text.length ?? 0) ||
    (item && low(item.text.charCodeAt(at.offset)) && high(item.text.charCodeAt(at.offset - 1)))
  )
    throw new Fault('invalid_cursor', 'Output cursor does not point to a valid text boundary.');
  const closed =
    !!item &&
    (terminal(run.status) ||
      (item.status ? item.status !== 'in_progress' : at.index < run.output.length - 1));
  let remaining = item?.text.slice(at.offset) ?? '';
  if (!closed && high(remaining.charCodeAt(remaining.length - 1)))
    remaining = remaining.slice(0, -1);
  const text = textPrefix(remaining, maxBytes);
  let next = { ...at, offset: at.offset + text.length };
  if (item && closed && next.offset === item.text.length)
    next = { ...at, index: at.index + 1, offset: 0 };
  const done = terminal(run.status) && next.index >= run.output.length;
  return {
    response_id: run.id,
    status: run.status,
    output_index: at.index,
    item_id: item?.id ?? null,
    item_status:
      item?.status ??
      (item
        ? closed
          ? terminal(run.status) && run.status !== 'completed'
            ? 'incomplete'
            : 'completed'
          : 'in_progress'
        : null),
    text,
    next_cursor: done ? null : encodeCursor(next),
    tail_cursor: encodeCursor(next),
    waiting_for_output:
      !done &&
      (next.index >= run.output.length ||
        (next.index === at.index && text.length === remaining.length)),
    done,
  };
}

// 兼容入口把多条消息拼成 `[role]\n文本` 段、段间空一行（gateway/protocol.ts、claude.ts、uap.ts）。
const ROLE_MARK = /(?:^|\n\n)\[([a-z]+(?:[ :][^\]\n]*)?)\]\n/g;
const FORMAT_NOTE = /\n\n\[Response Format Requirement:/;

/**
 * 给人看的任务输入预览：带角色标记的输入取最后一条用户消息的文本（不带标记、不含系统提示），
 * 没有用户消息或不是这种格式时取整段开头。只用于摘要，交给智能体的输入不变；旧摘要读取时同样处理。
 */
export function inputPreview(input: string, max = 200): string {
  const marks = /^\[[a-z]+(?:[ :][^\]\n]*)?\]\n/.test(input) ? [...input.matchAll(ROLE_MARK)] : [];
  let last: string | undefined;
  marks.forEach((m, i) => {
    if (m[1] !== 'user') return;
    const text = input.slice(m.index + m[0].length, marks[i + 1]?.index ?? input.length);
    last = text.split(FORMAT_NOTE)[0]!.trim() || last;
  });
  return (last ?? input).slice(0, max);
}
