/**
 * HTTP-level tolerance that official SDKs and browser clients depend on (compatibility lab findings):
 *
 * - CORS preflight: a browser lists every non-safelisted header it will send (`user-agent`,
 *   `x-stainless-*`, `x-requested-with`, ...) and refuses the call when one is missing from
 *   `Access-Control-Allow-Headers`. The Origin has already been checked against `allowedOrigins`
 *   when this runs, so the answer is the fixed list plus exactly what was asked for.
 * - Body-less POSTs: the official SDKs send `Content-Type: application/json` with a zero-length body
 *   on calls that take no body (`responses.cancel`), which Fastify rejects as `invalid_json`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Fault } from '../core/util.js';
import { sendError } from './compat-errors.js';

const FIXED_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Last-Event-ID',
  'X-OAA-Provider-Key',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
  'x-oaa-model',
  'x-model',
  'x-target-model',
  'x-oaa-agent-version',
  'x-routing-strategy',
  'x-oaa-strategy',
  'x-oaa-compat',
  'x-oaa-protocol',
  'x-oaa-client-tools',
  'X-OAA-Webhook-Token',
];

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** `Access-Control-Allow-Headers` for a preflight: the fixed list plus the well-formed requested names. */
export function corsAllowHeaders(requested: string | string[] | undefined): string {
  const asked = (Array.isArray(requested) ? requested.join(',') : (requested ?? ''))
    .split(',')
    .map((h) => h.trim())
    .filter((h) => HEADER_NAME.test(h));
  const seen = new Set(FIXED_ALLOWED_HEADERS.map((h) => h.toLowerCase()));
  const extra = asked.filter((h) => !seen.has(h.toLowerCase()) && seen.add(h.toLowerCase()));
  return [...FIXED_ALLOWED_HEADERS, ...extra.slice(0, 40)].join(', ');
}

/** A zero-length JSON body on a call that takes none is treated as no body at all. */
export function tolerateEmptyJsonBody(req: FastifyRequest): void {
  const type = req.headers['content-type'];
  if (req.headers['content-length'] !== '0' || typeof type !== 'string' || !type.includes('json'))
    return;
  const path = req.url.split('?')[0]!;
  if (
    req.method === 'DELETE' ||
    /\/(cancel|resume|reconcile|webhook-token)$/.test(path) ||
    /^\/v1\/webhooks\/workflows\/[^/]+$/.test(path)
  )
    delete req.headers['content-type'];
}

/**
 * Fastify `rewriteUrl`: runs of slashes are squeezed, and the trailing slash of an API path (`/v1...`)
 * is dropped, so a Base URL typed with a trailing slash (`/v1//chat/completions`, `/v1/models/`) still
 * routes. Everything the gateway reads afterwards (routing, the auth hook, error shapes) sees the same
 * normalized path. Console and portal paths keep their trailing slash.
 */
export function rewriteApiUrl(url = ''): string {
  const q = url.indexOf('?');
  const path = (q < 0 ? url : url.slice(0, q)).replace(/\/{2,}/g, '/');
  const api = /^\/v1(beta)?(\/|$)/.test(path) ? path.replace(/\/+$/, '') || '/' : path;
  return api + (q < 0 ? '' : url.slice(q));
}

/**
 * The 404 text for an unknown route. Most "404"s from chat clients are a mistyped Base URL, so the
 * message names the usual cause: the OpenAI-style Base URL must end with `/v1`, and a client that
 * already adds `/v1` turns a Base URL ending in `/v1` into `/v1/v1/...`.
 */
export function routeNotFoundMessage(method: string, url: string): string {
  const path = url.split('?')[0]!.slice(0, 200);
  const base = `No route matches ${method} ${path}.`;
  if (/^\/v1\/v1(\/|$)/.test(path))
    return `${base} The path contains /v1 twice: this client already adds /v1, so remove it from the Base URL.`;
  if (/^\/(chat\/completions|completions|models|responses|embeddings)(\/|$)/.test(path))
    return `${base} The Base URL of an OpenAI-compatible client must end with /v1 (for example http://127.0.0.1:8787/v1).`;
  return base;
}

/** Fastify not-found handler: a 404 in the shape of the protocol the path belongs to. */
export const notFound = (req: FastifyRequest, reply: FastifyReply) =>
  sendError(
    req,
    reply,
    404,
    new Fault('route_not_found', routeNotFoundMessage(req.method, req.url), 404),
  );
