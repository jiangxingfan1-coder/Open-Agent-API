/**
 * Model objects of the three listing protocols. An agent is a "model" to every client; the shape is
 * chosen by the request: `x-goog-api-client` (Google SDKs), `anthropic-version` (Anthropic SDKs),
 * otherwise OpenAI's Model object. Kept free of imports so the protocol files can share it.
 */

export const openaiModel = (a: { id: string }) => ({
  id: a.id,
  object: 'model',
  created: 0,
  owned_by: 'open-agent-api',
});

/** Anthropic ModelInfo: no release date, so `created_at` is the epoch (the field description allows it). */
export const claudeModelInfo = (a: { id: string }): Record<string, unknown> => ({
  type: 'model',
  id: a.id,
  display_name: a.id,
  created_at: '1970-01-01T00:00:00Z',
  capabilities: null,
  deprecated_at: null,
  lifecycle: 'active',
  line: null,
  max_input_tokens: null,
  max_tokens: null,
  retires_at: null,
});
