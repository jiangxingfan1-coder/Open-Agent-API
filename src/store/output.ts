import type { OutputMessage, RunEvent } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { OUTPUT_EVENT_TYPES, type RunEventType } from '../core/events.js';

/** 写入的事件只接受事件目录里登记的类型；读出的 RunEvent.type 仍是 string。 */
export type EventInput = { type: RunEventType; data: RunEvent['data'] };
export const outputEventTypes = OUTPUT_EVENT_TYPES;
export const isOutputEvent = (type: string) =>
  (outputEventTypes as readonly string[]).includes(type);

// The durable stream is the source of truth for text, not a second mutable snapshot.
export function projectOutput(messages: OutputMessage[], event: EventInput): OutputMessage[] {
  if (!isOutputEvent(event.type)) return messages;
  const invalid = () => new Fault('invalid_output_event', 'Invalid output event transition.', 500);
  const index = event.data.output_index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) throw invalid();
  const item = event.data.item as Record<string, unknown> | undefined;
  if (event.type === 'response.output_item.added') {
    if (
      index !== messages.length ||
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      messages.some((m) => m.id === item.id) ||
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      item.status !== 'in_progress' ||
      !Array.isArray(item.content) ||
      item.content.length !== 0
    )
      throw invalid();
    return [...messages, { id: item.id, text: '', status: 'in_progress' }];
  }
  const message = messages[index];
  if (!message || (message.status && message.status !== 'in_progress')) throw invalid();
  let next: OutputMessage;
  if (event.type === 'response.output_text.delta') {
    if (
      event.data.item_id !== message.id ||
      event.data.content_index !== 0 ||
      typeof event.data.delta !== 'string'
    )
      throw invalid();
    next = { ...message, text: message.text + event.data.delta, status: 'in_progress' };
  } else {
    const content = item?.content as { type?: unknown; text?: unknown }[] | undefined;
    if (
      item?.id !== message.id ||
      item?.type !== 'message' ||
      item?.role !== 'assistant' ||
      !['completed', 'incomplete'].includes(String(item?.status)) ||
      !Array.isArray(content) ||
      content.length !== 1 ||
      content[0]?.type !== 'output_text' ||
      content[0]?.text !== message.text
    )
      throw invalid();
    next = { ...message, status: item!.status as 'completed' | 'incomplete' };
  }
  return messages.map((m, i) => (i === index ? next : m));
}

export function finishOutput(
  message: OutputMessage,
  index: number,
  status: 'completed' | 'incomplete',
): EventInput[] {
  const part = { type: 'output_text', text: message.text, annotations: [], logprobs: [] };
  return [
    {
      type: 'response.output_text.done',
      data: {
        item_id: message.id,
        output_index: index,
        content_index: 0,
        text: message.text,
        logprobs: [],
      },
    },
    {
      type: 'response.content_part.done',
      data: { item_id: message.id, output_index: index, content_index: 0, part },
    },
    {
      type: 'response.output_item.done',
      data: {
        output_index: index,
        item: { id: message.id, type: 'message', role: 'assistant', status, content: [part] },
      },
    },
  ];
}
