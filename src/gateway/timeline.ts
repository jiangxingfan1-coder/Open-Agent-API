/**
 * Run timeline and critical path, derived only from durable state: lifecycle events (queue,
 * admission, approvals, tools, sub-agents, terminal), model-turn marks kept in the checkpoint,
 * and execution steps. Nothing here calls a model or tool, and no event is added to the log, so
 * compatibility streams and their event sequence numbers are unchanged.
 */
import {
  finalizeTimeline,
  type Breakdown,
  type InternalSpan as Span,
  type SpanKind,
  type SpanStatus,
  type Timeline,
  type TimelineEvent,
  type TimelineInput,
  type TimelineSpan,
  type TimelineStep,
} from './timeline-layout.js';
export type {
  Breakdown,
  SpanKind,
  SpanStatus,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineSpan,
  TimelineStep,
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

const str = (value: unknown, max = 160) =>
  typeof value === 'string' && value ? value.slice(0, max) : null;

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

  return finalizeTimeline(input, spans, approvals, toolSpans, stepById, ended, finish, limit);
}
