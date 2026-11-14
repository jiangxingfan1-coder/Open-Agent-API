import { LEGACY_SUBJECT, type Run } from '../core/contracts.js';
import type { Store } from '../store/store.js';
import { Fault } from '../core/util.js';

/**
 * 内建的跨会话记忆工具（`memory_read` / `memory_write`）。
 * 记忆按 owner 和调用方身份隔离；不指定命名空间时用智能体自己的 id。
 * 这里只负责读写并返回给模型的结果；步骤记录和检查点由内核处理。
 */
export function runMemoryTool(
  store: Store,
  run: Run,
  name: 'memory_read' | 'memory_write',
  args: Record<string, unknown>,
): unknown {
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
