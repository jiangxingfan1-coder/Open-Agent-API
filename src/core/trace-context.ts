import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context (Level 1, `00-<32hex>-<16hex>-<2hex>`) carried alongside a run without
 * touching `metadata`, idempotency fingerprints or compatibility stream payloads.
 */
export type TraceContext = {
  traceId: string;
  parentId?: string;
  spanId: string;
  flags: string;
  tracestate?: string;
};

export type TraceView = {
  trace_id: string;
  parent_id: string | null;
  span_id: string;
  tracestate?: string;
};

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN = '0000000000000000';
/** Visible ASCII plus SP/HTAB, bounded at 512 characters. */
const TRACESTATE_RE = /^[\x09\x20-\x7e]{1,512}$/;

/** Generate a non-zero 8-byte (16-hex) W3C span ID. */
export function newSpanId(): string {
  for (;;) {
    const span = randomBytes(8).toString('hex');
    if (span !== ZERO_SPAN) return span;
  }
}

/** Parse a `traceparent` header value; invalid values return `undefined` without failing. */
export function parseTraceparent(
  raw: unknown,
): { traceId: string; parentId: string; flags: string } | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = TRACEPARENT_RE.exec(raw.trim());
  if (!match) return undefined;
  const [, traceId, parentId, flags] = match;
  if (!traceId || !parentId || !flags || traceId === ZERO_TRACE || parentId === ZERO_SPAN)
    return undefined;
  return { traceId, parentId, flags };
}

/** Sanitize an optional `tracestate` header (`<= 512` chars); invalid values are ignored. */
export function parseTracestate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || !TRACESTATE_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Extract W3C Trace Context from incoming HTTP headers and allocate a fresh `spanId` for this run.
 * Malformed headers are silently ignored per `docs/architecture.md`.
 */
export function parseTraceHeaders(headers: Record<string, unknown>): TraceContext | undefined {
  const parsed = parseTraceparent(headers.traceparent);
  if (!parsed) return undefined;
  const tracestate = parseTracestate(headers.tracestate);
  return {
    traceId: parsed.traceId,
    parentId: parsed.parentId,
    spanId: newSpanId(),
    flags: parsed.flags,
    ...(tracestate ? { tracestate } : {}),
  };
}

/** Derive a child run's trace context: inherits `traceId`, sets `parentId` to parent's `spanId`. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    parentId: parent.spanId,
    spanId: newSpanId(),
    flags: parent.flags,
    ...(parent.tracestate ? { tracestate: parent.tracestate } : {}),
  };
}

/** Format a W3C `traceparent` header from a `TraceContext`. */
export function formatTraceparent(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;
}

/** Project internal `TraceContext` to the snake_case API view echoed in timeline and run state. */
export function toTraceView(trace: TraceContext | undefined): TraceView | undefined {
  if (!trace) return undefined;
  return {
    trace_id: trace.traceId,
    parent_id: trace.parentId ?? null,
    span_id: trace.spanId,
    ...(trace.tracestate ? { tracestate: trace.tracestate } : {}),
  };
}
