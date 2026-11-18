import { LEGACY_SUBJECT, type Run } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import { Fault } from '../core/util.js';
import { projects } from '../store/projects.js';
import { memoryFts } from '../store/project-fts.js';
import { projectPrincipal } from './project-memory.js';

/**
 * 内建的跨会话记忆工具（`memory_read` / `memory_write` / `memory_search`）。
 * 记忆按 owner 和调用方身份隔离；不指定命名空间时用智能体自己的 id（`memory_search` 未指定命名空间时跨自身可读命名空间检索）。
 * 这里只负责读写并返回给模型的结果；步骤记录和检查点由内核处理。
 */
export function runMemoryTool(
  store: Store,
  run: Run,
  name: 'memory_read' | 'memory_write' | 'memory_search',
  args: Record<string, unknown>,
): unknown {
  if (name === 'memory_search') return search();
  async function search() {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query)
      throw new Fault('invalid_tool_arguments', 'memory_search requires a non-empty query.');
    const rawLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 20;
    const limit = Math.max(1, Math.min(50, Math.trunc(rawLimit)));
    const explicitNs =
      typeof args.namespace === 'string' && args.namespace.trim()
        ? args.namespace.trim()
        : undefined;
    if (args.scope === 'project') {
      if (!run.checkpoint.project)
        throw new Fault('scope_denied', 'No shared project was selected for this task.', 403);
      await projects(store).warmSearch(projectPrincipal(run), run.checkpoint.project.id);
      const hits = projects(store).search(projectPrincipal(run), run.checkpoint.project.id, query, {
        namespace: explicitNs,
        limit,
      });
      return {
        scope: 'project',
        project: run.checkpoint.project.id,
        namespace: explicitNs ?? null,
        count: hits.length,
        entries: hits.map((h) => ({
          namespace: h.namespace,
          key: h.key,
          value: h.value,
          score: h.score,
          updated_at: h.updatedAt,
        })),
      };
    }
    const fts = memoryFts(store);
    await fts.warm('private', run.owner, run.subject ?? LEGACY_SUBJECT);
    const hits = fts.searchPrivate(run.owner, run.subject ?? LEGACY_SUBJECT, query, {
      namespace: explicitNs,
      limit,
    });
    return {
      scope: 'private',
      namespace: explicitNs ?? null,
      count: hits.length,
      entries: hits.map((h) => ({
        namespace: h.namespace,
        key: h.key,
        value: h.value,
        score: h.score,
        updated_at: h.updatedAt,
      })),
    };
  }
  if (args.scope === 'project') {
    if (!run.checkpoint.project)
      throw new Fault('scope_denied', 'No shared project was selected for this task.', 403);
    const data = projects(store),
      p = projectPrincipal(run),
      id = run.checkpoint.project.id;
    const namespace = typeof args.namespace === 'string' ? args.namespace : 'shared';
    if (name === 'memory_write') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) throw new Fault('invalid_tool_arguments', 'memory_write requires a non-empty key.');
      return { ok: true, entry: data.put(p, id, namespace, key, args.value) };
    }
    if (typeof args.key === 'string') {
      const entry = data.get(p, id, namespace, args.key);
      return { found: !!entry, namespace, key: args.key, value: entry?.value ?? null };
    }
    const entries = data
      .entries(p, id, namespace, 500)
      .filter((e) => typeof args.prefix !== 'string' || e.key.startsWith(args.prefix));
    return { namespace, entries: entries.slice(0, 100) };
  }
  const namespace =
    typeof args.namespace === 'string' && args.namespace.trim()
      ? args.namespace.trim()
      : run.agentId;
  let value: unknown;
  if (name === 'memory_read') {
    if (typeof args.key === 'string' && args.key.trim()) {
      const k = args.key.trim();
      const record = store.getMemory(run.owner, run.subject ?? LEGACY_SUBJECT, namespace, k);
      value = {
        found: !!record,
        namespace,
        key: k,
        value: record?.value ?? null,
        updated_at: record?.updatedAt ?? null,
      };
    } else {
      const prefix = typeof args.prefix === 'string' ? args.prefix : undefined;
      const items = store.listMemories(
        run.owner,
        run.subject ?? LEGACY_SUBJECT,
        namespace,
        prefix,
        100,
      );
      value = {
        namespace,
        count: items.length,
        entries: items.map((m) => ({
          key: m.key,
          value: m.value,
          updated_at: m.updatedAt,
        })),
      };
    }
  } else {
    const keyName = String(args.key ?? '').trim();
    if (!keyName)
      throw new Fault('invalid_tool_arguments', 'memory_write requires a non-empty key.');
    const record = store.putMemory(
      run.owner,
      run.subject ?? LEGACY_SUBJECT,
      namespace,
      keyName,
      args.value,
      run.id,
    );
    value = {
      ok: true,
      namespace,
      key: record.key,
      updated_at: record.updatedAt,
    };
  }
  return value;
}
