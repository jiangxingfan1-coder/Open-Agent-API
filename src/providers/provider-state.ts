import {
  providerStateSchema,
  type AgentDefinition,
  type ModelMessage,
  type ProviderTurnState,
  type ToolCall,
} from '../core/contracts.js';
import type { ProviderConfig } from '../config/config.js';
import { Fault, sha } from '../core/util.js';

type Projection = { text: string; calls: ToolCall[] };
const MAX_STATE_BYTES = 2_000_000;
const digest = (value: unknown) => sha(JSON.stringify(value));
const target = (config: ProviderConfig, agent: AgentDefinition) =>
  digest({
    protocol: config.kind,
    endpoint: config.baseUrl.replace(/\/+$/, ''),
    model: agent.model,
    ...(config.kind === 'anthropic-messages'
      ? { version: config.anthropicVersion ?? '2023-06-01' }
      : {}),
  });

/** Local consistency checks, not an attestation of a worker or a provider signature. */
export function validateProviderState(value: unknown, projection: Projection): ProviderTurnState {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Fault('invalid_provider_state', 'Provider turn state is not JSON.', 502);
  }
  if (!serialized)
    throw new Fault('invalid_provider_state', 'Provider turn state is missing.', 502);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new Fault('provider_state_too_large', 'Provider turn state exceeds 2 MiB.', 413);
  const parsed = providerStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.projection !== digest(projection))
    throw new Fault(
      'invalid_provider_state',
      'Provider turn state does not match its normalized result.',
      502,
    );
  return structuredClone(parsed.data);
}

export function captureProviderState(
  config: ProviderConfig,
  agent: AgentDefinition,
  prefix: unknown,
  items: unknown[],
  projection: Projection,
): ProviderTurnState {
  return validateProviderState(
    {
      format: 'oaa.provider-turn.v1',
      protocol: config.kind,
      target: target(config, agent),
      prefix: digest(prefix),
      projection: digest(projection),
      items,
    },
    projection,
  );
}

export function replayProviderState(
  config: ProviderConfig,
  agent: AgentDefinition,
  prefix: unknown,
  message: ModelMessage,
): Record<string, unknown>[] | undefined {
  if (!message.providerState) return undefined;
  const state = validateProviderState(message.providerState, {
    text: message.content,
    calls: message.tool_calls ?? [],
  });
  if (
    message.role !== 'assistant' ||
    state.protocol !== config.kind ||
    state.target !== target(config, agent) ||
    state.prefix !== digest(prefix)
  )
    throw new Fault(
      'provider_state_mismatch',
      'Provider, model, tools, or conversation prefix changed. Restore the original configuration or start a new session.',
      409,
    );
  return state.items;
}

export function checkProviderStateProtocol(config: ProviderConfig, messages: ModelMessage[]): void {
  if (
    messages.some(
      (message) =>
        (message.providerState &&
          (message.role !== 'assistant' || message.providerState.protocol !== config.kind)) ||
        (message.providerItems?.length && config.kind !== 'openai-responses'),
    )
  )
    throw new Fault(
      'provider_state_mismatch',
      'Stored provider content cannot be translated to a different protocol.',
      409,
    );
}
