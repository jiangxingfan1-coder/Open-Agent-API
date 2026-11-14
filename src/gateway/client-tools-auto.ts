/**
 * Submission of a request that declares caller tools (docs/harness.md, "auto").
 *
 * The parsers prepare the bridge fields and leave the mode open (`default`, or an explicit `auto`).
 * Here, with the agent known, it is settled:
 *
 * - `auto`: try `bridge`; when the agent cannot take the tools over (it runs its own tool loop, no
 *   worker declares client-tools-v1 for it, a tool name collides with one of its own, the tools are
 *   not plain functions, the caller forces a tool choice) go back to what the entry did before:
 *   OpenAI's default endpoints refuse with a message that names the way out, every other entry
 *   continues as `managed` (the agent uses its own tools, `X-OAA-Client-Tools: ignored`).
 * - gateway configuration `clientTools.default` replaces `auto` for requests that chose no mode.
 * - an explicit `managed`, `bridge` or `reject` is never overridden.
 */
import type { Principal, Run } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import { CLIENT_TOOLS_MANAGED_NOTE, type ClientToolsMode } from '../kernel/harness.js';
import type { Invocation } from '../kernel/invocation.js';
import { CompatFault } from './compat-errors.js';
import { flattenClientResults } from './client-tools.js';

type Submitter = {
  submit(principal: Principal, invocation: Invocation, idem?: string, providerKey?: string): Run;
};

/** Submit failures that mean "this agent cannot bridge these tools" (all raised before a run exists). */
const CANNOT_BRIDGE = new Set([
  'client_tools_bridge_unsupported',
  'invalid_client_tool',
  'client_tool_conflict',
  'client_tools_too_many',
]);

const withMode = (invocation: Invocation, mode: string, extra: Record<string, string> = {}) => ({
  ...invocation,
  metadata: { ...invocation.metadata, 'oaa.client_tools': mode, ...extra },
});

/** The request as the `managed` mode would have parsed it: no bridge fields, the fixed note appended. */
function managed(invocation: Invocation): Invocation {
  const { client_tools: _tools, client_results: _results, ...rest } = invocation;
  const count = invocation.metadata['oaa.client_tools_declared'] ?? '1';
  return {
    ...rest,
    input: `${invocation.input}\n\n[Harness note] ${CLIENT_TOOLS_MANAGED_NOTE}`,
    metadata: {
      ...invocation.metadata,
      'oaa.client_tools': 'managed',
      'oaa.client_tools_ignored': count,
    },
  };
}

const refusal = (cause: string) =>
  new CompatFault(
    'unsupported_parameter',
    `\`tools\` cannot be handed to this agent: ${cause} ` +
      'Use the Base URL <origin>/v1/compat, X-OAA-Compat: true or X-OAA-Client-Tools: managed to let the agent finish the task with its own tools instead (the response then carries X-OAA-Client-Tools: ignored).',
    400,
    'tools',
  );

/** Submit; returns the run. The mode that was actually used is in `run.metadata["oaa.client_tools"]`. */
export function submitClientTools(
  kernel: Submitter,
  principal: Principal,
  invocation: Invocation,
  idem: string | undefined,
  providerKey: string | undefined,
  configured: ClientToolsMode,
): Run {
  const plain = flattenClientResults(invocation);
  const submit = (inv: Invocation) => kernel.submit(principal, inv, idem, providerKey);
  const meta = invocation.metadata;
  const requested = meta['oaa.client_tools'];
  if (requested !== 'default' && requested !== 'auto') {
    return submit(plain);
  }
  const effective: ClientToolsMode = requested === 'auto' ? 'auto' : configured;
  if (effective === 'managed') return submit(managed(plain));
  if (effective === 'reject')
    throw new Fault(
      'client_tools_unsupported',
      'This gateway does not accept caller-defined tools (clientTools.default is reject). Remove tools, or send X-OAA-Client-Tools: managed or bridge.',
    );
  const cause = meta['oaa.client_tools_unbridgeable']
    ? `${meta['oaa.client_tools_unbridgeable']}`
    : meta['oaa.tool_choice_forced']
      ? 'a forced tool_choice cannot be honoured: the agent decides which tool to call.'
      : undefined;
  if (effective === 'bridge') {
    if (cause) throw new Fault('client_tools_unsupported', cause);
    return submit(withMode(plain, 'bridge'));
  }
  const fallback = (why: string) =>
    meta['oaa.client_tools_fallback'] === 'reject' ? refusal(why) : managed(plain);
  if (cause) {
    const next = fallback(cause);
    if (next instanceof CompatFault) throw next;
    return submit(next);
  }
  try {
    return submit(withMode(plain, 'bridge'));
  } catch (error) {
    if (!(error instanceof Fault) || !CANNOT_BRIDGE.has(error.code)) throw error;
    const next = fallback(error.message);
    if (next instanceof CompatFault) throw next;
    return submit(next);
  }
}

/** `X-OAA-Client-Tools` of the response: `bridge` when the tools were handed over, `ignored` when not. */
export function clientToolsHeader(run: Run): 'bridge' | 'ignored' | undefined {
  if (run.metadata['oaa.client_tools_ignored']) return 'ignored';
  return run.metadata['oaa.client_tools'] === 'bridge' && run.metadata['oaa.client_tools_declared']
    ? 'bridge'
    : undefined;
}
