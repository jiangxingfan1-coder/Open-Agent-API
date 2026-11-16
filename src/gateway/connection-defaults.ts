import type { FastifyRequest } from 'fastify';
import type { Store } from '../store/store.js';
import type { Invocation } from '../kernel/invocation.js';
import { resolveModelSelector } from '../kernel/routing.js';
import { authorize } from '../kernel/submission.js';
import { toolBoundarySchema } from '../core/agent-access.js';

/** Connection preferences never grant permission; submission still checks the publication. */
export function applyConnectionDefaults(
  req: FastifyRequest,
  store: Store,
  invocation: Invocation,
): Invocation {
  authorize(req.principal, invocation.agent, 'invoke');
  const connection = req.principal.connection;
  const metadata = { ...invocation.metadata };
  if (connection?.reasoningOnly) metadata['oaa.tools_disabled'] = 'true';
  const body = req.body as
    { model?: unknown; agent?: unknown; metadata?: Record<string, unknown> } | undefined;
  const pathSelector = String((req.params as { '*': string } | undefined)?.['*'] ?? '').replace(
    /:(?:generateContent|streamGenerateContent)$/,
    '',
  );
  const explicit =
    invocation.model !== 'auto' ||
    metadata['oaa.model'] !== undefined ||
    req.headers['x-oaa-model'] !== undefined ||
    req.headers['x-model'] !== undefined ||
    req.headers['x-target-model'] !== undefined ||
    req.headers['x-oaa-strategy'] !== undefined ||
    req.headers['x-routing-strategy'] !== undefined ||
    body?.metadata?.['oaa.routing_strategy'] !== undefined ||
    (typeof body?.model === 'string' && (body.agent !== undefined || /[@:]/.test(body.model))) ||
    /[@:]/.test(pathSelector);
  let model = invocation.model;
  const selected =
    connection?.models && Object.hasOwn(connection.models, invocation.agent)
      ? connection.models[invocation.agent]
      : undefined;
  if (!explicit && selected) {
    const target = resolveModelSelector(`${invocation.agent}@${selected}`);
    model = target.model;
    if (target.strategy) metadata['oaa.routing_strategy'] = target.strategy;
  }
  const access = store.bundle(req.principal.owner, invocation.agent, invocation.agent_version).agent
    .access;
  const requested = metadata['oaa.client_tools'];
  const rawBoundary = req.headers['x-oaa-tool-boundary'] ?? metadata['oaa.tool_boundary'];
  const mode =
    rawBoundary !== undefined
      ? toolBoundarySchema.parse(rawBoundary)
      : requested === 'managed'
        ? 'managed'
        : requested === 'bridge'
          ? 'hybrid'
          : requested === undefined || requested === 'default'
            ? (connection?.toolMode ?? access?.defaultMode)
            : undefined;
  if (mode) {
    metadata['oaa.tool_boundary'] = mode;
    // Let submitClientTools apply the managed-note or bridge validation itself.
    if (requested !== undefined && requested !== 'managed')
      metadata['oaa.client_tools'] = 'default';
    metadata['oaa.connection_tools'] = mode === 'managed' ? 'managed' : 'bridge';
  }
  return { ...invocation, model, metadata };
}
