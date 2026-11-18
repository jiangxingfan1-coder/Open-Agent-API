import type { ModelMark, RunStatus, TraceView } from '../core/contracts.js';
import { parseGraph } from '../lang/graph.js';

export type TimelineEvent = {
  id: number;
  type: string;
  time: number;
  data: Record<string, unknown>;
};
export type TimelineStep = {
  id: string;
  callId: string;
  name: string;
  status: string;
  startedAt?: number;
};
export type TimelineInput = {
  id: string;
  status: RunStatus;
  createdAt: number;
  engine: string;
  marks: ModelMark[];
  events: TimelineEvent[];
  steps: TimelineStep[];
  graphs?: Map<string, unknown>;
  lastEventId: number;
  now: number;
};
export type SpanKind =
  'queue' | 'model' | 'tool' | 'approval' | 'client_tool' | 'subagent' | 'interrupted' | 'native';
export type SpanStatus =
  'completed' | 'failed' | 'cached' | 'running' | 'waiting' | 'uncertain' | 'cancelled';
export type TimelineSpan = {
  id: string;
  kind: SpanKind;
  label: string | null;
  ref: Record<string, string | number>;
  lane: number;
  start_ms: number;
  end_ms: number | null;
  status: SpanStatus;
  critical: boolean;
  depends_on: string[];
  estimated?: true;
  trace?: TraceView;
};
export type Breakdown = {
  queue: number;
  model: number;
  tools: number;
  approval: number;
  other: number;
};
export type Timeline = {
  id: string;
  status: RunStatus;
  created_at: number;
  ended_at: number | null;
  now: number;
  total_ms: number;
  last_event_id: number;
  spans: TimelineSpan[];
  critical_path_ms: number;
  breakdown_ms: Breakdown;
  truncated: boolean;
  trace?: TraceView;
};

export type InternalSpan = {
  key: number;
  kind: SpanKind;
  label: string | null;
  ref: Record<string, string | number>;
  start: number;
  end: number | null;
  status: SpanStatus;
  main: boolean;
  lane: number;
  deps: Set<InternalSpan>;
  estimated?: boolean;
  unit?: InternalSpan;
};

const category: Record<SpanKind, keyof Breakdown> = {
  queue: 'queue',
  model: 'model',
  native: 'model',
  tool: 'tools',
  subagent: 'tools',
  approval: 'approval',
  client_tool: 'tools',
  interrupted: 'other',
};

/** Graph step dependencies keyed by `${graphCallId}:${stepId}`. */
export function graphDependencies(graphs: Map<string, unknown> | undefined): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const [callId, args] of graphs ?? []) {
    try {
      const raw = (args as { steps?: { tool?: unknown; fallback?: { tool?: unknown } }[] })?.steps;
      const tools = new Set<string>();
      for (const step of Array.isArray(raw) ? raw : []) {
        if (typeof step?.tool === 'string') tools.add(step.tool);
        if (typeof step?.fallback?.tool === 'string') tools.add(step.fallback.tool);
      }
      tools.delete('execute_graph');
      for (const step of parseGraph(structuredClone(args), tools))
        deps.set(
          `${callId}:${step.id}`,
          step.depends_on.map((d) => `${callId}:${d}`),
        );
    } catch {
      // A graph that cannot be re-parsed simply contributes no explicit edges.
    }
  }
  return deps;
}

export function finalizeTimeline(
  input: TimelineInput,
  spans: InternalSpan[],
  approvals: Map<string, InternalSpan>,
  toolSpans: Map<string, InternalSpan>,
  stepById: Map<string, TimelineStep>,
  ended: number | null,
  finish: number,
  limit: number,
): Timeline {
  const byStart = (a: InternalSpan, b: InternalSpan) => a.start - b.start || a.key - b.key;
  const endOf = (s: InternalSpan) => s.end ?? finish;
  const mainLine = spans.filter((s) => s.main).sort(byStart);
  const requesters = spans
    .filter((s) => s.main && (s.kind === 'model' || s.kind === 'native' || s.kind === 'queue'))
    .sort(byStart);
  const requesterOf = (s: InternalSpan) => {
    let found: InternalSpan | undefined;
    for (const r of requesters) {
      if (r.start > s.start) break;
      if (r === s || r.unit === s) continue;
      if (endOf(r) <= s.start + 1 && r.kind !== 'queue') found = r;
    }
    return found;
  };
  const graphDeps = graphDependencies(input.graphs);
  const callToStep = new Map<string, string[]>();
  for (const step of input.steps) {
    const base = step.callId.replace(/_\d+$/, '');
    for (const callKey of new Set([step.callId, base]))
      callToStep.set(callKey, [...(callToStep.get(callKey) ?? []), step.id]);
  }
  for (const span of spans) {
    if (span.main) continue;
    if (span.unit) {
      const requester = requesterOf(span);
      if (requester) span.deps.add(requester);
      continue;
    }
    const requester = requesterOf(span);
    if (requester) span.deps.add(requester);
    const stepId = typeof span.ref.step_id === 'string' ? span.ref.step_id : undefined;
    if (stepId && span.kind !== 'approval') {
      for (const approval of approvals.values())
        if (approval.ref.step_id === stepId) span.deps.add(approval);
      const step = stepById.get(stepId);
      const callKey = step?.callId.replace(/_\d+$/, '');
      for (const dep of (callKey ? graphDeps.get(callKey) : undefined) ?? [])
        for (const depStep of callToStep.get(dep) ?? []) {
          const target = toolSpans.get(depStep);
          if (target && target !== span) span.deps.add(target);
        }
    }
  }
  const parallel = spans.filter((s) => !s.main);
  for (let i = 0; i < mainLine.length; i++) {
    const span = mainLine[i]!;
    const prev = mainLine[i - 1];
    if (prev) span.deps.add(prev);
    const from = prev ? prev.start : -Infinity;
    for (const p of parallel)
      if (
        p.start >= from &&
        p.start <= span.start &&
        endOf(p) > from &&
        endOf(p) <= span.start + 1 &&
        !p.deps.has(span) &&
        !(p.unit && p.unit.deps.has(span))
      )
        span.deps.add(p);
  }

  const critical = new Set<InternalSpan>();
  if (spans.length) {
    let cur: InternalSpan | undefined = [...spans].sort(
      (a, b) => endOf(b) - endOf(a) || Number(b.main) - Number(a.main) || b.start - a.start,
    )[0];
    while (cur && !critical.has(cur)) {
      critical.add(cur);
      const current = cur;
      let candidates = [...current.deps].filter((d) => !critical.has(d));
      if (!candidates.length)
        candidates = spans.filter(
          (s) =>
            !critical.has(s) &&
            s !== current &&
            endOf(s) <= current.start + 1 &&
            s.start < current.start,
        );
      cur = candidates.sort(
        (a, b) => endOf(b) - endOf(a) || Number(b.main) - Number(a.main) || b.start - a.start,
      )[0];
    }
  }
  const breakdown: Breakdown = { queue: 0, model: 0, tools: 0, approval: 0, other: 0 };
  const total = Math.max(0, Math.round(finish - input.createdAt));
  let cursor = input.createdAt;
  let covered = 0;
  for (const span of [...critical].sort(byStart)) {
    const start = Math.max(cursor, span.start);
    const end = Math.min(finish, Math.max(start, endOf(span)));
    if (end <= cursor) continue;
    const portion = end - start;
    breakdown[category[span.kind]] += portion;
    covered += portion;
    cursor = end;
  }
  for (const k of ['queue', 'model', 'tools', 'approval'] as const)
    breakdown[k] = Math.round(breakdown[k]);
  breakdown.other = Math.max(
    0,
    total - breakdown.queue - breakdown.model - breakdown.tools - breakdown.approval,
  );

  const laneEnds: number[] = [];
  const mainSpans = spans.filter((s) => s.main);
  const overlapsMain = (s: InternalSpan) =>
    mainSpans.some((m) => m.start < endOf(s) && endOf(m) > s.start && m !== s);
  const units = new Map<InternalSpan, InternalSpan[]>();
  for (const s of parallel) {
    const anchor = s.unit ?? s;
    units.set(anchor, [...(units.get(anchor) ?? []), s]);
  }
  for (const [anchor, members] of [...units].sort((a, b) =>
    byStart(
      a[1].reduce((m, s) => (s.start < m.start ? s : m)),
      b[1].reduce((m, s) => (s.start < m.start ? s : m)),
    ),
  )) {
    const start = Math.min(...members.map((m) => m.start));
    const end = Math.max(...members.map((m) => (m.end === null ? Infinity : m.end)));
    let lane: number;
    if (anchor.kind === 'approval' && !overlapsMain(anchor)) {
      lane = 0;
      mainSpans.push(anchor);
    } else {
      lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
      if (lane === -1) {
        laneEnds.push(end);
        lane = laneEnds.length - 1;
      } else laneEnds[lane] = end;
      lane += 1;
    }
    for (const m of members) m.lane = lane;
  }

  let kept = [...spans].sort(byStart);
  const truncated = kept.length > limit;
  if (truncated) {
    const keep = new Set([...critical].slice(0, limit));
    for (const s of kept) {
      if (keep.size >= limit) break;
      keep.add(s);
    }
    kept = kept.filter((s) => keep.has(s));
  }
  const ids = new Map(kept.map((s, i) => [s, `sp_${i + 1}`]));
  const offset = (t: number) => Math.max(0, Math.round(t - input.createdAt));
  return {
    id: input.id,
    status: input.status,
    created_at: input.createdAt,
    ended_at: ended,
    now: input.now,
    total_ms: total,
    last_event_id: input.lastEventId,
    spans: kept.map((s) => ({
      id: ids.get(s)!,
      kind: s.kind,
      label: s.label,
      ref: s.ref,
      lane: s.lane,
      start_ms: offset(s.start),
      end_ms: s.end === null ? null : offset(s.end),
      status: s.status,
      critical: critical.has(s),
      depends_on: [...s.deps]
        .filter((dep) => ids.has(dep))
        .sort(byStart)
        .map((dep) => ids.get(dep)!),
      ...(s.estimated ? { estimated: true as const } : {}),
    })),
    critical_path_ms: Math.round(covered),
    breakdown_ms: breakdown,
    truncated,
  };
}
