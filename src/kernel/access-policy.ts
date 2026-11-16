import type { AgentDefinition, Principal } from '../core/contracts.js';
import { executionFor, requiredExecution } from '../core/contracts.js';
import { toolBoundarySchema, permitsToolBoundary } from '../core/agent-access.js';
import { Fault } from '../core/util.js';

export function checkAccessPolicy(
  agent: AgentDefinition,
  principal: Principal,
  metadata: Record<string, string>,
): void {
  const raw = metadata['oaa.tool_boundary'];
  const boundary =
    raw === undefined
      ? metadata['oaa.client_tools'] === 'bridge'
        ? 'hybrid'
        : 'managed'
      : toolBoundarySchema.parse(raw);
  const access = agent.access;
  if (
    principal.connection?.allowedModes &&
    !permitsToolBoundary(principal.connection.allowedModes, boundary)
  )
    throw new Fault(
      'scope_denied',
      'This key does not grant the requested tool execution location.',
      403,
    );
  if (access && !access.modes.includes(boundary))
    throw new Fault('scope_denied', 'The publication does not allow this tool boundary.', 403);
  if (boundary === 'client' && agent.engine !== 'kernel')
    throw new Fault(
      'client_tools_bridge_unsupported',
      'This external agent cannot yet guarantee client-only tool execution. Choose an explicitly allowed mode; no fallback was made.',
    );
  if (
    access?.trust === 'private' &&
    (principal.accountId ||
      principal.externalCaller ||
      executionFor(principal, agent.id) !== 'host')
  )
    throw new Fault(
      'isolation_required',
      'This publication is restricted to trusted private host keys.',
      403,
    );
  if (
    access?.trust === 'isolated' &&
    requiredExecution(agent) === 'host' &&
    executionFor(principal, agent.id) !== 'sandbox'
  )
    throw new Fault(
      'isolation_required',
      'This publication requires a verified sandbox executor and a sandbox-level key.',
      403,
    );
}
