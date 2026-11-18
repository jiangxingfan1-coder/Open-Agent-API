import type { TraceContext, TraceView } from '../core/contracts.js';
import { toTraceView } from '../core/trace-context.js';
import type { Store } from '../store/store.js';
import type { Timeline } from './timeline.js';

/** Read the persisted W3C Trace Context of a run (`runs.payload.trace`), or `undefined`. */
export function runTraceOf(store: Store, runId: string): TraceView | undefined {
  const row = store.db
    .prepare("SELECT json_extract(payload,'$.trace') AS trace FROM runs WHERE id=?")
    .get(runId);
  if (!row || typeof row.trace !== 'string') return undefined;
  try {
    const parsed = JSON.parse(row.trace) as TraceContext;
    if (!parsed || typeof parsed.traceId !== 'string' || typeof parsed.spanId !== 'string')
      return undefined;
    return toTraceView(parsed);
  } catch {
    return undefined;
  }
}

/** Attach top-level and sub-agent child run `trace` views onto a built timeline when present. */
export function attachTimelineTraces(store: Store, runId: string, timeline: Timeline): Timeline {
  const rootTrace = runTraceOf(store, runId);
  let hasChildTrace = false;
  const spans = timeline.spans.map((span) => {
    if (span.kind !== 'subagent' || typeof span.ref.child_run_id !== 'string') return span;
    const childTrace = runTraceOf(store, span.ref.child_run_id);
    if (!childTrace) return span;
    hasChildTrace = true;
    return { ...span, trace: childTrace };
  });
  if (!rootTrace && !hasChildTrace) return timeline;
  return {
    ...timeline,
    ...(rootTrace ? { trace: rootTrace } : {}),
    ...(hasChildTrace ? { spans } : {}),
  };
}
