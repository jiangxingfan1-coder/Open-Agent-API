/**
 * Run timeline and critical path, derived only from durable state: lifecycle events (queue,
 * admission, approvals, tools, sub-agents, terminal), model-turn marks kept in the checkpoint,
 * and execution steps. Nothing here calls a model or tool, and no event is added to the log, so
 * compatibility streams and their event sequence numbers are unchanged.
 */
import type { ModelMark, RunStatus } from '../core/contracts.js';
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
  /** Lifecycle events in id order; output deltas are not needed. */
  events: TimelineEvent[];
  steps: TimelineStep[];
  /** execute_graph call id → its arguments, used to recover graph dependencies. */
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
};

type Span = {
  key: number;
  kind: SpanKind;
  label: string | null;
  ref: Record<string, string | number>;
  start: number;
  end: number | null;
  status: SpanStatus;
  main: boolean;
  lane: number;
  deps: Set<Span>;
  estimated?: boolean;
  /** Group key for spans that must share a lane (a node wait and its tool). */
  unit?: Span;
};

export const MAX_TIMELINE_SPANS = 200;
/** Gaps shorter than this between queueing and dispatch are not shown as separate spans. */
const WAIT_THRESHOLD_MS = 10;
const TERMINAL: Record<string, SpanStatus> = {
  'response.completed': 'completed',
  'response.failed': 'failed',
  'response.cancelled': 'cancelled',
  'response.incomplete': 'failed',
  'run.interrupted': 'cancelled',
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

const str = (value: unknown, max = 160) =>
  typeof value === 'string' && value ? value.slice(0, max) : null;

/** Graph step dependencies keyed by `${graphCallId}:${stepId}`. */
function graphDependencies(graphs: Map<string, unknown> | undefined): Map<string, string[]> {
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

export function buildTimeline(input: TimelineInput, limit = MAX_TIMELINE_SPANS): Timeline {
  const spans: Span[] = [];
  let key = 0;
  const add = (span: Omit<Span, 'key' | 'deps' | 'lane'>) => {
    const created: Span = { ...span, key: key++, deps: new Set(), lane: span.main ? 0 : -1 };
    spans.push(created);
    return created;
  };
  let ended: number | null = null;
  let main: Span | undefined;
  let interruptedAt: number | null = null;
  const closeMain = (at: number, status: SpanStatus = 'completed') => {
    if (!main) return;
    main.end = Math.max(main.start, at);
    main.status = status;
    main = undefined;
  };
  const openMain = (kind: SpanKind, at: number, label: string | null, status: SpanStatus) => {
    closeMain(at);
    main = add({ kind, label, ref: {}, start: at, end: null, status, main: true });
  };
  const native = input.engine !== 'kernel';
  const nativeStep = input.steps.find((s) => s.id === `native_${input.id}`);
  const segments: { start: number; end: number | null }[] = [];
  let segment: { start: number; end: number | null } | undefined;
  const closeSegment = (at: number) => {
    if (segment && segment.end === null) segment.end = at;
    segment = undefined;
  };
  const tools = new Map<
    string,
    {
      queued?: number;
      started?: number;
      end?: number;
      status?: SpanStatus;
      tool?: string;
      kind: SpanKind;
      label?: string | null;
      child?: string;
    }
  >();
  const approvals = new Map<string, Span>();
  /** Times at which execution stopped (terminal events), to close marks left open by a crash. */
  const stops: number[] = [];
  let pausedNative = 0;

  for (const event of input.events) {
    const t = event.time;
    const d = event.data;
    if (ended !== null && event.type !== 'response.in_progress' && event.type !== 'step.reconciled')
      continue;
    switch (event.type) {
      case 'response.created':
        openMain('queue', t, 'admission', 'waiting');
        break;
      case 'response.in_progress': {
        if (ended !== null) {
          // Explicit resume after an interruption or failure.
          if (interruptedAt !== null)
            add({
              kind: 'interrupted',
              label: null,
              ref: {},
              start: interruptedAt,
              end: t,
              status: 'completed',
              main: true,
            });
          ended = null;
          interruptedAt = null;
        }
        closeMain(t);
        segment = { start: t, end: null };
        segments.push(segment);
        if (native) openMain('native', t, input.engine, 'running');
        break;
      }
      case 'run.queued':
        closeSegment(t);
        openMain(
          'queue',
          t,
          d.reason === 'approval_resolved' ? 'approval' : (str(d.reason, 40) ?? 'admission'),
          'waiting',
        );
        break;
      case 'run.parked':
        closeSegment(t);
        if (main?.kind === 'model' || main?.kind === 'native') closeMain(t);
        break;
      case 'run.requires_action': {
        const approval = (d.approval ?? {}) as Record<string, unknown>;
        const approvalId = str(approval.id, 80);
        if (!approvalId || approvals.has(approvalId)) break;
        const detail = (approval.detail ?? {}) as Record<string, unknown>;
        if (native && main?.kind === 'native') {
          closeMain(t);
          pausedNative++;
        }
        const span = add({
          // 等调用方执行工具（桥接）单独成一类，不冒充人工审批。
          kind: approval.kind === 'client_tool' ? 'client_tool' : 'approval',
          label: str(detail.tool) ?? str(detail.native, 40) ?? str(approval.kind, 40),
          ref: {
            approval_id: approvalId,
            ...(str(approval.stepId, 120) ? { step_id: str(approval.stepId, 120)! } : {}),
          },
          start: t,
          end: null,
          status: 'waiting',
          main: false,
        });
        approvals.set(approvalId, span);
        break;
      }
      case 'approval.resolved': {
        const span = approvals.get(String(d.approval_id ?? ''));
        if (!span || span.end !== null) break;
        span.end = t;
        span.status = d.decision === 'approve' ? 'completed' : 'failed';
        if (native && pausedNative > 0 && --pausedNative === 0 && !main)
          openMain('native', t, input.engine, 'running');
        break;
      }
      case 'tool.queued':
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.cached':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed': {
        const stepId = str(d.step_id, 120);
        if (!stepId) break;
        const subagent = event.type.startsWith('subagent.');
        const record = tools.get(stepId) ?? { kind: subagent ? 'subagent' : 'tool' };
        tools.set(stepId, record);
        if (event.type === 'tool.queued') {
          record.queued ??= t;
          record.tool ??= str(d.tool) ?? undefined;
        } else if (event.type === 'tool.started' || event.type === 'subagent.started') {
          record.started ??= t;
          if (subagent) {
            record.label = str(d.delegate) ?? str(d.agent) ?? null;
            record.child = str(d.child_run_id, 80) ?? undefined;
          }
        } else {
          record.end = t;
          if (subagent) record.child ??= str(d.child_run_id, 80) ?? undefined;
          record.status =
            event.type === 'tool.cached'
              ? 'cached'
              : event.type.endsWith('.completed')
                ? 'completed'
                : 'failed';
        }
        break;
      }
      default: {
        const terminal = TERMINAL[event.type];
        if (!terminal) break;
        stops.push(t);
        ended = t;
        interruptedAt = t;
        closeSegment(t);
        closeMain(t, main?.kind === 'queue' ? 'cancelled' : terminal);
        for (const span of approvals.values())
          if (span.end === null) {
            span.end = t;
            span.status = 'cancelled';
          }
      }
    }
  }
  const finish = ended ?? input.now;
  if (
    main &&
    ended === null &&
    main.kind === 'queue' &&
    input.status !== 'queued' &&
    input.status !== 'requires_action'
  ) {
    // A queue span left open by a lifecycle transition that records no event.
    main.status = 'completed';
  }

  // Model turns: explicit marks, or inferred from gaps for runs recorded before marks existed.
  if (!native && input.marks.length) {
    for (const mark of input.marks) {
      const stop = mark.end === undefined ? stops.find((at) => at >= mark.start) : undefined;
      const end = mark.end ?? stop ?? null;
      const status: SpanStatus =
        mark.status ??
        (mark.end !== undefined ? 'completed' : stop !== undefined ? 'cancelled' : 'running');
      const dispatched = mark.dispatched ?? mark.start;
      if (dispatched - mark.start >= WAIT_THRESHOLD_MS)
        add({
          kind: 'queue',
          label: 'node',
          ref: { turn: mark.turn },
          start: mark.start,
          end: dispatched,
          status: 'completed',
          main: true,
        });
      add({
        kind: 'model',
        label: str(mark.route, 80),
        ref: { turn: mark.turn, ...(mark.attempt ? { attempt: mark.attempt } : {}) },
        start: Math.max(mark.start, dispatched),
        end,
        status,
        main: true,
      });
    }
  }

  // Tools and sub-agents (with a separate node-wait span when dispatch was delayed).
  const stepById = new Map(input.steps.map((s) => [s.id, s]));
  const toolSpans = new Map<string, Span>();
  for (const [stepId, record] of tools) {
    const step = stepById.get(stepId);
    const start = record.started ?? record.queued ?? record.end;
    if (start === undefined) continue;
    let status: SpanStatus = record.status ?? 'running';
    let end: number | null = record.end ?? null;
    if (record.end === undefined) {
      if (step?.status === 'uncertain') status = 'uncertain';
      else if (ended !== null) status = 'cancelled';
      else status = record.started !== undefined ? 'running' : 'waiting';
      if (ended !== null) end = ended;
    }
    const label =
      record.kind === 'subagent'
        ? (record.label ?? step?.name ?? null)
        : (record.tool ?? step?.name ?? null);
    const span = add({
      kind: record.kind,
      label: label ? label.slice(0, 160) : null,
      ref: {
        step_id: stepId,
        ...(record.kind === 'tool' && label ? { tool: label.slice(0, 160) } : {}),
        ...(record.child ? { child_run_id: record.child } : {}),
      },
      start,
      end,
      status,
      main: false,
    });
    toolSpans.set(stepId, span);
    if (
      record.queued !== undefined &&
      record.started !== undefined &&
      record.started - record.queued >= WAIT_THRESHOLD_MS
    ) {
      const wait = add({
        kind: 'queue',
        label: 'node',
        ref: { step_id: stepId },
        start: record.queued,
        end: record.started,
        status: 'completed',
        main: false,
      });
      span.deps.add(wait);
      wait.unit = span;
    }
  }

  // Native agents: split the time spent waiting for a node from execution.
  if (native && nativeStep?.startedAt !== undefined) {
    const host = spans.find(
      (s) =>
        s.kind === 'native' &&
        s.start < nativeStep.startedAt! &&
        (s.end === null || s.end > nativeStep.startedAt!),
    );
    if (host && nativeStep.startedAt - host.start >= WAIT_THRESHOLD_MS) {
      add({
        kind: 'queue',
        label: 'node',
        ref: {},
        start: host.start,
        end: nativeStep.startedAt,
        status: 'completed',
        main: true,
      });
      host.start = nativeStep.startedAt;
    }
  }

  // Runs recorded before model marks existed: infer model turns from uncovered execution time.
  if (!native && !input.marks.length) {
    const busy = spans.filter((s) => !s.main);
    let turn = 0;
    for (const seg of segments) {
      const open = seg.end === null && ended === null;
      const segEnd = seg.end ?? finish;
      const inside = busy
        .filter((s) => s.start < segEnd && (s.end ?? finish) > seg.start)
        .sort((a, b) => a.start - b.start);
      let cursor = seg.start;
      const gap = (to: number, running = false) => {
        if (to - cursor < 1 && !running) return;
        add({
          kind: 'model',
          label: null,
          ref: { turn: ++turn },
          start: cursor,
          end: running ? null : to,
          status: running ? 'running' : 'completed',
          main: true,
          estimated: true,
        });
      };
      for (const s of inside) {
        if (s.start > cursor) gap(s.start);
        cursor = Math.max(cursor, s.end ?? finish);
      }
      // After the last tool batch the model is (or was) producing the next turn.
      if (open) {
        if (!inside.some((s) => s.end === null)) gap(segEnd, true);
      } else if (segEnd > cursor) gap(segEnd);
    }
  }

  // Dependencies.
  const byStart = (a: Span, b: Span) => a.start - b.start || a.key - b.key;
  const endOf = (s: Span) => s.end ?? finish;
  const mainLine = spans.filter((s) => s.main).sort(byStart);
  const requesters = spans
    .filter((s) => s.main && (s.kind === 'model' || s.kind === 'native' || s.kind === 'queue'))
    .sort(byStart);
  // Timestamps have millisecond resolution, so ends may lag starts by 1 ms; a dependency must
  // still have *started* no later than its dependent (zero-length spans are common).
  const requesterOf = (s: Span) => {
    let found: Span | undefined;
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
        // Work requested by this very span cannot also precede it (zero-length spans tie on time).
        !p.deps.has(span) &&
        !(p.unit && p.unit.deps.has(span))
      )
        span.deps.add(p);
  }

  // Critical path: from the latest finishing span, follow the dependency that finished last.
  const critical = new Set<Span>();
  if (spans.length) {
    let cur: Span | undefined = [...spans].sort(
      (a, b) => endOf(b) - endOf(a) || Number(b.main) - Number(a.main) || b.start - a.start,
    )[0];
    while (cur && !critical.has(cur)) {
      critical.add(cur);
      const current: Span = cur;
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

  // Lanes: lane 0 is the main line; parallel work is packed greedily from lane 1.
  const laneEnds: number[] = [];
  const mainSpans = spans.filter((s) => s.main);
  const overlapsMain = (s: Span) =>
    mainSpans.some((m) => m.start < endOf(s) && endOf(m) > s.start && m !== s);
  const units = new Map<Span, Span[]>();
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

  // Bound the response: keep the critical chain, then the earliest remaining spans.
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
