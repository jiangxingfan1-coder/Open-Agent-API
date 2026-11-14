import type { Usage } from '../core/contracts.js';

/*
 * Provider wire shapes as the stream decoders in models.ts read them. Only "is a JSON object" is
 * checked up front (modelObject); each field the decoders rely on is checked where it is read.
 */
export type Wire = Record<string, unknown>;

export type ResponsesEvent = Wire & { response?: { error?: { message?: unknown } }; error?: Wire };
export type ResponsesFinal = { output?: unknown; usage?: Usage; status?: unknown };

type ChatToolDelta = {
  index?: unknown;
  id?: string;
  function?: { name?: string; arguments?: string };
};
export type ChatChoice = {
  delta?: { content?: unknown; tool_calls?: ChatToolDelta[] };
  finish_reason?: string | null;
};
export type ChatChunk = Wire & {
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  choices?: unknown;
};

export type AnthropicEvent = Wire & {
  type?: string;
  index: number;
  message?: { usage?: Wire };
  content_block?: { type: string; id: string; name: string; text?: string; input?: unknown };
  usage?: Wire;
  error?: Wire;
};
export type AnthropicBlock = Wire & {
  text?: string;
  thinking?: string;
  signature?: string;
  citations?: unknown[];
};
export type AnthropicDelta = Wire & {
  text: string;
  partial_json: string;
  thinking: string;
  stop_reason?: string | null;
};

export type GeminiChunk = Wire & { error?: Wire; promptFeedback?: Wire; usageMetadata?: Wire };
export type GeminiCall = { name: string; id?: string; args?: Record<string, unknown> };
