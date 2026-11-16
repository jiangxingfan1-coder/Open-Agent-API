import { z } from 'zod';
import type { AgentDefinition, Principal } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import type { Catalog } from './catalog.js';
import { textPrefix } from '../store/inspection.js';
import { Fault, canonical, sha } from '../core/util.js';

export const directoryQuery = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const definitionQuery = z.object({
  agent: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/),
  agent_version: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const inspectionQuery = definitionQuery
  .extend({
    section: z.enum(['overview', 'routes', 'tools', 'skills']).default('overview'),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const metadataUri = (agent: string, version: string) =>
  `oaa://agents/${encodeURIComponent(agent)}/versions/${version}`;
const preview = (value: string, bytes: number) => {
  const text = textPrefix(value, bytes);
  return { text, truncated: text !== value };
};
export function page<T>(
  rows: T[],
  offset: number,
  total: number,
  metadata: Record<string, unknown>,
) {
  const data: T[] = [];
  const result = () => ({
    ...metadata,
    data,
    total,
    offset,
    next_offset: offset + data.length < total ? offset + data.length : null,
  });
  for (const row of rows) {
    data.push(row);
    if (Buffer.byteLength(JSON.stringify(result())) <= 20000) continue;
    data.pop();
    if (!data.length)
      throw new Fault(
        'metadata_item_too_large',
        'Use the version-pinned metadata resource for this item.',
        413,
      );
    break;
  }
  return result();
}
export function listAgents(
  store: Store,
  catalog: Catalog,
  principal: Principal,
  query: z.infer<typeof directoryQuery>,
) {
  const index = store.agentIndex(principal.owner, principal.agents);
  const revision = sha(
    canonical({ owner: principal.owner, grants: [...new Set(principal.agents)].sort(), index }),
  );
  if (query.revision && query.revision !== revision)
    throw new Fault(
      'catalog_changed',
      'The authorized publication list changed. Restart from offset 0 without the old revision.',
      409,
    );
  const catalogCursor = catalog.publicationCursor(principal, index);
  const rows = store.agentSummaryRows(
    principal.owner,
    index.slice(query.offset, query.offset + query.limit).map((entry) => entry.digest),
  );
  const summaries = rows.map((row) => {
    const description = textPrefix(String(row.description), 600),
      engine = textPrefix(String(row.engine), 400);
    return {
      id: String(row.id),
      version: String(row.digest),
      engine,
      engine_truncated: Buffer.byteLength(engine) < Number(row.engine_bytes),
      description,
      description_truncated: Buffer.byteLength(description) < Number(row.description_bytes),
      tools_count: Number(row.tools),
      skills_count: Number(row.skills),
      routes_count: Number(row.routes) || 1,
      toolkit_source: row.engine === 'kernel' ? 'bundle' : 'native_host',
      readiness: 'not_evaluated',
    };
  });
  return page(summaries, query.offset, index.length, { revision, catalog_cursor: catalogCursor });
}
export function publicMetadata(agent: AgentDefinition, digest: string) {
  return {
    id: agent.id,
    version: digest,
    description: agent.description,
    engine: agent.engine,
    ...(agent.modelPolicy
      ? {
          model_policy: agent.modelPolicy,
          models_endpoint: `/v1/agents/models?agent=${encodeURIComponent(agent.id)}`,
        }
      : {}),
    ...(agent.access ? { access: agent.access } : {}),
    ...(agent.orchestration ? { orchestration: agent.orchestration } : {}),
    toolkit_source: agent.engine === 'kernel' ? 'bundle' : 'native_host',
    routes: agent.routes.length
      ? agent.routes
      : [{ id: 'default', provider: agent.provider, model: agent.model, priority: 0 }],
    tools: agent.tools.map((tool) => ({
      name: tool.name,
      required: tool.required === true,
      ...tool.capability,
    })),
    skills: agent.skills,
  };
}
export function inspectAgent(
  agent: AgentDefinition,
  digest: string,
  query: z.infer<typeof inspectionQuery>,
  /** Conversion profile of the engine as configured on this gateway (overview section only). */
  conversion?: Record<string, unknown>,
) {
  if (query.offset > 0 && !query.agent_version)
    throw new Fault(
      'agent_version_required',
      'Pass the returned agent_version for subsequent detail pages.',
    );
  const definition = publicMetadata(agent, digest);
  let rows: unknown[];
  let total = 1;
  const selected = <T>(items: T[]) => {
    total = items.length;
    return items.slice(query.offset, query.offset + query.limit);
  };
  if (query.section === 'overview') {
    const description = preview(agent.description, 4000),
      engine = preview(agent.engine, 400);
    rows = selected([
      {
        description: description.text,
        description_truncated: description.truncated,
        engine: engine.text,
        engine_truncated: engine.truncated,
        toolkit_source: definition.toolkit_source,
        tools_count: agent.tools.length,
        skills_count: agent.skills.length,
        routes_count: definition.routes.length,
        readiness: 'not_evaluated',
        ...(conversion ? { conversion } : {}),
      },
    ]);
  } else if (query.section === 'routes') rows = selected(definition.routes);
  else if (query.section === 'skills')
    rows = selected(definition.skills).map((skill) => {
      const description = preview(skill.description, 1200);
      return {
        name: skill.name,
        description: description.text,
        description_truncated: description.truncated,
      };
    });
  else
    rows = selected(definition.tools).map((tool) => {
      const description = preview(tool.description, 1200);
      return {
        name: tool.name,
        id: tool.id,
        version: tool.version,
        description: description.text,
        description_truncated: description.truncated,
        placement: tool.placement,
        node_id: tool.nodeId ?? null,
        effect: tool.effect,
        required: tool.required,
        requires_approval: tool.requiresApproval,
        result_export: tool.resultExport,
        schema_bytes: Buffer.byteLength(JSON.stringify(tool.inputSchema)),
        schema_sha256: sha(canonical(tool.inputSchema)),
      };
    });
  return page(rows, query.offset, total, {
    agent: agent.id,
    agent_version: digest,
    section: query.section,
    metadata_uri: metadataUri(agent.id, digest),
    metadata_url: `/v1/catalog/agent/content?${new URLSearchParams({ agent: agent.id, agent_version: digest })}`,
  });
}
