import { z } from 'zod';

export const toolChoicePolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.enum(['auto', 'none', 'required']) }).strict(),
  z.object({ mode: z.literal('tool'), name: z.string().min(1).max(64) }).strict(),
]);

export type ToolChoicePolicy =
  { mode: 'auto' | 'none' | 'required' } | { mode: 'tool'; name: string };

/** Whether the caller requires at least one caller tool call in this turn. */
export function isForcedToolChoice(
  policy: ToolChoicePolicy | undefined,
): policy is { mode: 'required' } | { mode: 'tool'; name: string } {
  return policy?.mode === 'required' || policy?.mode === 'tool';
}

/** Validates that a forced tool choice can be satisfied by the declared caller tools. */
export function validateToolChoiceTarget(
  policy: ToolChoicePolicy | undefined,
  declaredToolNames: readonly string[],
): string | undefined {
  if (!isForcedToolChoice(policy)) return undefined;
  if (declaredToolNames.length === 0) {
    return 'A forced tool_choice requires a non-empty tools list.';
  }
  if (policy.mode === 'tool' && !declaredToolNames.includes(policy.name)) {
    return `Tool '${policy.name}' specified in tool_choice is not present in tools.`;
  }
  return undefined;
}

/** Whether the observed caller tool invocations satisfy `policy`. */
export function satisfiesToolChoice(
  policy: ToolChoicePolicy | undefined,
  calledToolNames: readonly string[],
): boolean {
  if (!policy || policy.mode === 'auto') return true;
  if (policy.mode === 'tool') return calledToolNames.includes(policy.name);
  if (policy.mode === 'none') return calledToolNames.length === 0;
  return calledToolNames.length > 0;
}

/** Compact canonical serialization of a `ToolChoicePolicy`. */
export function serializeToolChoicePolicy(policy: ToolChoicePolicy): string {
  return policy.mode === 'tool' ? `tool:${policy.name}` : policy.mode;
}

/** Parses a `ToolChoicePolicy` serialized by `serializeToolChoicePolicy` or JSON. */
export function deserializeToolChoicePolicy(raw: string | undefined): ToolChoicePolicy | undefined {
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'none' || raw === 'required') return { mode: raw };
  if (raw.startsWith('tool:')) {
    const name = raw.slice(5);
    return name ? toolChoicePolicySchema.parse({ mode: 'tool', name }) : undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  return toolChoicePolicySchema.parse(parsed);
}

export const TOOL_CHOICE_REPAIR_MARKER = '[Tool choice repair]';

/** Explicit prompt constraint injected for external bridged agents under a forced `tool_choice`. */
export function callerToolChoiceInstruction(
  policy: ToolChoicePolicy | undefined,
  toolNames: readonly string[],
): string {
  if (!isForcedToolChoice(policy)) return '';
  if (policy.mode === 'tool') {
    return `\n\n[Caller Tool Requirement: The caller set a mandatory tool_choice. Before completing your response, you MUST invoke the caller tool "${policy.name}" via MCP.]`;
  }
  const list = toolNames.length ? ` (${toolNames.join(', ')})` : '';
  return `\n\n[Caller Tool Requirement: The caller set a mandatory tool_choice. Before completing your response, you MUST invoke at least one caller tool${list} via MCP.]`;
}

/** Lightweight single-round correction prompt when an external bridged agent skipped a forced tool call. */
export function callerToolChoiceRepairPrompt(
  policy: ToolChoicePolicy,
  toolNames: readonly string[],
): string {
  if (policy.mode === 'tool') {
    return (
      `${TOOL_CHOICE_REPAIR_MARKER} Your previous turn ended without calling the mandatory caller tool "${policy.name}". ` +
      `Invoke "${policy.name}" via MCP now, then provide your final answer.`
    );
  }
  const list = toolNames.length ? ` (${toolNames.join(', ')})` : '';
  return (
    `${TOOL_CHOICE_REPAIR_MARKER} Your previous turn ended without calling any caller tool${list}, ` +
    `which is required by tool_choice. Invoke an appropriate caller tool via MCP now, then provide your final answer.`
  );
}
