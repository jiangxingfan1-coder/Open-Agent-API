/**
 * Stream progress on the wire (docs/progress.md): which requests get it, and the frames that carry a
 * progress line in each protocol's own "thinking / reasoning" shape. The lines themselves come from
 * the pure `summarize` (progress.ts). Progress never reaches the answer text, the stored output or
 * the usage counts: it exists only in the frames of one stream.
 */
import type { FastifyRequest } from 'fastify';
import type { Run, RunEvent } from '../core/contracts.js';
import { requestLocale, type Locale } from '../core/locale.js';
import type { Store } from '../store/store.js';
import { INITIAL_PROGRESS, PROGRESS_MODES, summarize, type ProgressMode } from './progress.js';

export type ProgressDialect = 'chat' | 'responses' | 'claude' | 'gemini';
export type ProgressDefaults = Record<ProgressDialect, ProgressMode>;

/** Built-in defaults (the gateway configuration `streamProgress` overrides them). */
export const PROGRESS_DEFAULTS: ProgressDefaults = {
  chat: 'off',
  responses: 'reasoning',
  claude: 'off',
  gemini: 'reasoning',
};

/** The configured defaults, remembered per store so a reconnecting stream uses the same ones. */
const configured = new WeakMap<Store, ProgressDefaults>();
export function rememberProgressDefaults(store: Store, defaults: ProgressDefaults): void {
  configured.set(store, defaults);
}

const parseMode = (raw: unknown): ProgressMode | undefined => {
  const value = String(Array.isArray(raw) ? raw[0] : (raw ?? ''))
    .trim()
    .toLowerCase();
  return (PROGRESS_MODES as readonly string[]).includes(value)
    ? (value as ProgressMode)
    : undefined;
};

/**
 * The progress choice of one stream: `X-OAA-Progress` header, else `metadata["oaa.progress"]` of the
 * run, else the configured default of the protocol. Unknown values count as not given.
 */
export function progressFor(
  store: Store,
  req: FastifyRequest,
  run: Run | undefined,
  dialect: string,
): Locale | undefined {
  if (!['chat', 'responses', 'claude', 'gemini'].includes(dialect)) return undefined;
  const defaults = configured.get(store) ?? PROGRESS_DEFAULTS;
  const mode =
    parseMode(req.headers['x-oaa-progress']) ??
    parseMode(run?.metadata['oaa.progress']) ??
    defaults[dialect as ProgressDialect];
  return mode === 'reasoning' ? requestLocale(req.headers['accept-language']) : undefined;
}

/** Turns run events into progress text (one line each, newline terminated) for one stream. */
export class ProgressLines {
  private state = INITIAL_PROGRESS;
  constructor(private readonly locale: Locale) {}
  next(e: RunEvent): string | undefined {
    const result = summarize(e, this.state, this.locale);
    this.state = result.state;
    return result.line ? `${result.line}\n` : undefined;
  }
}

/** Chat Completions: the de facto `delta.reasoning_content` field (DeepSeek, vLLM, many gateways). */
export const chatReasoningFrame = (base: Record<string, unknown>, text: string) =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] })}\n\n`;

/** Gemini: a part marked `thought: true` (SDK `.text` getters skip such parts). */
export const geminiThoughtJson = (runId: string, modelVersion: string, text: string) =>
  JSON.stringify({
    responseId: runId,
    modelVersion,
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text, thought: true }] } }],
  });

/** Wire-only Responses frames (not run events, so not in core/events.ts). */
const SUMMARY = ['response', 'reasoning_summary_'].join('.');

/** Signature of gateway progress thinking blocks; a block echoed back is dropped on input. */
export const PROGRESS_SIGNATURE = 'oaa-progress-v1';

const claudeFrame = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Claude Messages: a `thinking` block at index 0, opened on the first line, closed before the text. */
export class ClaudeThinking {
  open = false;
  /** Index of the next content block. */
  next = 0;
  line(text: string): string[] {
    const frames: string[] = [];
    if (!this.open) {
      frames.push(
        claudeFrame('content_block_start', {
          index: this.next,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
      );
      this.open = true;
    }
    frames.push(
      claudeFrame('content_block_delta', {
        index: this.next,
        delta: { type: 'thinking_delta', thinking: text },
      }),
    );
    return frames;
  }
  close(): string[] {
    if (!this.open) return [];
    this.open = false;
    const index = this.next++;
    return [
      claudeFrame('content_block_delta', {
        index,
        delta: { type: 'signature_delta', signature: PROGRESS_SIGNATURE },
      }),
      claudeFrame('content_block_stop', { index }),
    ];
  }
}

/**
 * Responses: one `reasoning` output item at output_index 0 whose summary text grows line by line.
 * It is opened before any answer item; afterwards every forwarded frame's `output_index` moves up
 * by one and response snapshots list the item first, so SDK accumulators see consistent positions.
 */
export class ResponsesReasoning {
  private text = '';
  private state: 'none' | 'open' | 'done' = 'none';
  constructor(private readonly runId: string) {}
  get id() {
    return `rs_${this.runId}`;
  }
  get active() {
    return this.state !== 'none';
  }
  get closed() {
    return this.state === 'done';
  }
  /** The item as it appears in response snapshots. */
  item(): Record<string, unknown> {
    return {
      id: this.id,
      type: 'reasoning',
      summary: this.text ? [{ type: 'summary_text', text: this.text }] : [],
      status: this.state === 'done' ? 'completed' : 'in_progress',
    };
  }
  line(text: string, emit: (type: string, data: Record<string, unknown>) => void): void {
    const ref = { item_id: this.id, output_index: 0, summary_index: 0 };
    if (this.state === 'none') {
      this.state = 'open';
      emit('response.output_item.added', {
        output_index: 0,
        item: { id: this.id, type: 'reasoning', summary: [], status: 'in_progress' },
      });
      emit(`${SUMMARY}part.added`, {
        ...ref,
        part: { type: 'summary_text', text: '' },
      });
    }
    this.text += text;
    emit(`${SUMMARY}text.delta`, { ...ref, delta: text });
  }
  close(emit: (type: string, data: Record<string, unknown>) => void): void {
    if (this.state !== 'open') return;
    const ref = { item_id: this.id, output_index: 0, summary_index: 0 };
    emit(`${SUMMARY}text.done`, { ...ref, text: this.text });
    emit(`${SUMMARY}part.done`, {
      ...ref,
      part: { type: 'summary_text', text: this.text },
    });
    this.state = 'done';
    emit('response.output_item.done', { output_index: 0, item: this.item() });
  }
  /** A forwarded frame's data with positions shifted past the reasoning item. */
  shift(data: Record<string, unknown>): Record<string, unknown> {
    if (this.state === 'none') return data;
    const out: Record<string, unknown> = { ...data };
    if (typeof out.output_index === 'number') out.output_index += 1;
    const response = out.response as { output?: unknown[] } | undefined;
    if (response && Array.isArray(response.output))
      out.response = { ...response, output: [this.item(), ...response.output] };
    return out;
  }
}
