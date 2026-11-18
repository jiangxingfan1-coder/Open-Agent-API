import { Fault } from '../core/util.js';

type FieldSpec = {
  min: number;
  max: number;
  names?: Record<string, number>;
  wrapSeven?: boolean;
};

type ParsedField = {
  values: Set<number>;
  wildcard: boolean;
};

export type ParsedCron = {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const SPECS: [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 7, names: WEEKDAYS, wrapSeven: true },
];

const cronError = (detail: string) =>
  new Fault('invalid_request', `Invalid cron expression: ${detail}`);

function parseAtom(token: string, spec: FieldSpec): number {
  const lower = token.toLowerCase();
  if (spec.names && Object.hasOwn(spec.names, lower)) return spec.names[lower]!;
  if (!/^\d+$/.test(token)) throw cronError(`unexpected token "${token}".`);
  const n = Number(token);
  if (!Number.isSafeInteger(n) || n < spec.min || n > spec.max)
    throw cronError(`value ${token} out of range ${spec.min}-${spec.max}.`);
  return n;
}

function parseField(raw: string, spec: FieldSpec): ParsedField {
  if (!raw) throw cronError('empty field.');
  const values = new Set<number>();
  const wildcard = raw === '*';
  for (const part of raw.split(',')) {
    if (!part) throw cronError(`empty list item in "${raw}".`);
    const slashParts = part.split('/');
    if (slashParts.length > 2) throw cronError(`invalid step syntax in "${part}".`);
    const rangePart = slashParts[0]!;
    const stepPart = slashParts[1];
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw cronError(`invalid step "${stepPart}".`);
      step = Number(stepPart);
      if (!Number.isSafeInteger(step) || step <= 0)
        throw cronError('step must be a positive integer.');
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.wrapSeven ? 6 : spec.max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !bounds[0] || !bounds[1])
        throw cronError(`invalid range "${rangePart}".`);
      start = parseAtom(bounds[0], spec);
      end = parseAtom(bounds[1], spec);
      if (start > end) throw cronError(`range "${rangePart}" is reversed.`);
    } else {
      if (stepPart !== undefined) throw cronError(`step requires "*" or a range in "${part}".`);
      const single = parseAtom(rangePart, spec);
      values.add(spec.wrapSeven && single === 7 ? 0 : single);
      continue;
    }
    for (let v = start; v <= end; v += step) {
      values.add(spec.wrapSeven && v === 7 ? 0 : v);
    }
  }
  if (!values.size) throw cronError('field matched no values.');
  return { values, wildcard };
}

const parsedCache = new Map<string, ParsedCron>();

/** Parse and validate a standard 5-field cron expression (`minute hour dayOfMonth month dayOfWeek`). */
export function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  const cached = parsedCache.get(trimmed);
  if (cached) return cached;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5)
    throw cronError('expected exactly 5 fields (minute hour dayOfMonth month dayOfWeek).');
  const parsed: ParsedCron = {
    minute: parseField(fields[0]!, SPECS[0]),
    hour: parseField(fields[1]!, SPECS[1]),
    dayOfMonth: parseField(fields[2]!, SPECS[2]),
    month: parseField(fields[3]!, SPECS[3]),
    dayOfWeek: parseField(fields[4]!, SPECS[4]),
  };
  if (parsedCache.size >= 256) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(trimmed, parsed);
  return parsed;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Validate an IANA time zone identifier via `Intl.DateTimeFormat`. */
export function validateTimeZone(timeZone: string): string {
  const tz = timeZone.trim();
  if (!tz || tz.length > 120 || /\s/.test(tz))
    throw new Fault('invalid_request', 'Invalid IANA timezone.');
  if (formatterCache.has(tz)) return tz;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
    if (formatterCache.size >= 128) formatterCache.delete(formatterCache.keys().next().value!);
    formatterCache.set(tz, formatter);
    return tz;
  } catch {
    throw new Fault('invalid_request', `Invalid IANA timezone: "${tz}".`);
  }
}

export const cronMinuteSlot = (epochMs = Date.now()): number => Math.floor(epochMs / 60_000);

/** Check whether `epochMs` falls inside a minute matching `expr` in IANA `timeZone`. */
export function cronMatchesMinute(expr: string, timeZone = 'UTC', epochMs = Date.now()): boolean {
  const cron = parseCron(expr);
  const tz = validateTimeZone(timeZone);
  const formatter = formatterCache.get(tz)!;
  const parts = formatter.formatToParts(new Date(cronMinuteSlot(epochMs) * 60_000));
  let minute = -1;
  let hour = -1;
  let day = -1;
  let month = -1;
  let weekday = -1;
  for (const part of parts) {
    if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'weekday')
      weekday = WEEKDAYS[part.value.toLowerCase().slice(0, 3)] ?? -1;
  }
  if (
    !cron.minute.values.has(minute) ||
    !cron.hour.values.has(hour) ||
    !cron.month.values.has(month)
  )
    return false;
  const domMatch = cron.dayOfMonth.values.has(day);
  const dowMatch = cron.dayOfWeek.values.has(weekday);
  if (!cron.dayOfMonth.wildcard && !cron.dayOfWeek.wildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}
