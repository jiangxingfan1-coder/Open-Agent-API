import { hasFeature, state } from './state.js';
import { lang, t } from './i18n.js';

// The gateway answers in the language of this header (error messages, the error catalog).
export const acceptLanguage = lang === 'zh' ? 'zh-CN' : 'en';
/** Request headers for an authenticated read; `extra` wins over the defaults. */
export const authHeaders = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  'Accept-Language': acceptLanguage,
  ...extra,
});

// Error copy comes from the gateway's error catalog (GET /v1/errors, error-catalog-v1) once
// connected. The local table only covers what can happen before the catalog is readable:
// no connection, a rejected key, a refused host or origin, a gateway that is shutting down.
export const LOCAL_ERROR_TEXT = {
  connection_failed: t('error.local.connection_failed'),
  unauthorized: t('error.local.unauthorized'),
  key_expired: t('error.local.key_expired'),
  invalid_host: t('error.local.invalid_host'),
  origin_denied: t('error.local.origin_denied'),
  shutting_down: t('error.local.shutting_down'),
  permission_denied: t('error.local.permission_denied'),
  catalog_capacity: t('error.local.catalog_capacity'),
  cancelled: t('error.local.cancelled'),
};
// Codes whose raw message carries the useful detail (a syntax position, a rejected field).
export const ERROR_DETAIL = new Set([
  'invalid_request',
  'unsafe_bundle',
  'oaa_syntax_error',
  'invalid_engine',
  'upstream_failed',
]);
export const errorCatalog = { etag: null, entries: null };
// Sentence-ending marks; the Chinese ones (full stop, exclamation, question) are escapes.
const END_OF_SENTENCE = /[\u3002\uff01\uff1f.!?]$/;
export const sentence = (text) =>
  END_OF_SENTENCE.test(text) ? text : `${text}${lang === 'zh' ? '\u3002' : '.'}`;
// One lookup for every error shown in the console: catalog first, then the local table.
// Returns null when neither knows the code; callers then show the raw code and message.
// A catalog entry may carry its own English (`en`, `nextEn`); without it an English console
// falls back to the local table and then to the gateway's message, which already follows
// Accept-Language.
export function errorText(code) {
  if (!code) return null;
  const entry = errorCatalog.entries?.get(code);
  const main = lang === 'zh' ? entry?.zh : entry?.en;
  const next = lang === 'zh' ? entry?.next : entry?.nextEn;
  const gap = lang === 'zh' ? '' : ' ';
  if (main) return next ? `${sentence(main)}${gap}${sentence(next)}` : sentence(main);
  return LOCAL_ERROR_TEXT[code] ?? null;
}
// Read once per connection; a failed or unsupported read leaves the local table in charge.
export async function fetchErrorCatalog(token) {
  if (hasFeature('error-catalog-v1') !== true) return;
  const headers = authHeaders(token);
  if (errorCatalog.etag && errorCatalog.entries) headers['If-None-Match'] = errorCatalog.etag;
  try {
    const response = await fetch('/v1/errors', { headers });
    if (response.status === 304 || !response.ok) return;
    const data = await response.json();
    if (token !== state.token || !Array.isArray(data?.data)) return;
    errorCatalog.entries = new Map(data.data.map((e) => [e.code, e]));
    errorCatalog.etag = response.headers.get('ETag');
  } catch {
    // The catalog only improves wording; keep the local copy.
  }
}
export function apiError(status, data) {
  const code = data?.error?.code;
  const raw = data?.error?.message;
  const scope = code === 'scope_denied' ? /needs (\w+) scope/.exec(raw || '')?.[1] : null;
  const known = scope ? t('error.scopeMissing', { scope }) : errorText(code);
  const fallback =
    status === 401
      ? t('error.http401')
      : status === 403
        ? t('error.http403')
        : status === 404
          ? t('error.http404')
          : status >= 500
            ? t('error.http5xx', { status })
            : t('error.httpOther', { status });
  const message = known
    ? ERROR_DETAIL.has(code) && raw
      ? t('error.withDetail', { text: known.replace(END_OF_SENTENCE, ''), detail: raw })
      : known
    : raw || fallback;
  const failure = Error(message);
  failure.status = status;
  failure.code = code;
  return failure;
}
export async function api(method, url, body, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: authHeaders(options.token ?? state.token, {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (failure) {
    if (failure?.name === 'AbortError') throw failure;
    throw Error(LOCAL_ERROR_TEXT.connection_failed);
  }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(response.status, data);
  return data;
}
