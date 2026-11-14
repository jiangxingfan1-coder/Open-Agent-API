import { bi, pick } from '../core/locale.js';

/**
 * Security profiles (docs/security-model.md). `local` (default) changes nothing. `public` fills in
 * stricter values for every setting the config file leaves unset; an explicit value always wins.
 */
export const PUBLIC_PROFILE_DEFAULTS = {
  defaultKeyExecution: 'workspace',
  maxStoredBytesPerSubject: 256 * 1024 * 1024,
  /** Node's `requestTimeout`: receiving one request (headers and body), not the response. */
  requestTimeoutMs: 120_000,
  nativeEnv: { mode: 'allowlist', allow: [] as string[] },
} as const;

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Runs before schema validation on the raw gateway config. Never mutates its input. */
export function applySecurityProfile(raw: unknown): unknown {
  if (!isObject(raw) || !isObject(raw.security) || raw.security.profile !== 'public') return raw;
  const out: Raw = { ...raw, security: { ...raw.security } };
  const security = out.security as Raw;
  const d = PUBLIC_PROFILE_DEFAULTS;
  out.defaultKeyExecution ??= d.defaultKeyExecution;
  out.maxStoredBytesPerSubject ??= d.maxStoredBytesPerSubject;
  security.requestTimeoutMs ??= d.requestTimeoutMs;
  if (isObject(out.localWorker) && out.localWorker.nativeEnv === undefined)
    out.localWorker = { ...out.localWorker, nativeEnv: { ...d.nativeEnv, allow: [] } };
  return out;
}

/**
 * `oaa doctor`: a hint when the gateway looks reachable from outside this machine but the
 * profile is still `local`. Undefined when there is nothing to say.
 */
export function exposureHint(config: {
  host: string;
  publicBaseUrl?: string | undefined;
  security: { profile: 'local' | 'public' };
  platform?: { registration: string } | undefined;
}): { security_profile: string; reasons: string[]; hint: string } | undefined {
  if (config.security.profile !== 'local') return undefined;
  const reasons: string[] = [];
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(config.host))
    reasons.push(`host=${config.host}`);
  if (config.publicBaseUrl) reasons.push('publicBaseUrl');
  if (config.platform && config.platform.registration !== 'closed')
    reasons.push(`platform.registration=${config.platform.registration}`);
  if (!reasons.length) return undefined;
  return {
    security_profile: 'local',
    reasons,
    hint: pick(
      bi(
        '网关看起来可能对外暴露，但安全档位仍是 local。对外开放前请设置 "security": {"profile": "public"} 并按 docs/security-model.md 的清单检查。',
        'The gateway may be reachable from outside, but the security profile is still local. Before exposing it, set "security": {"profile": "public"} and follow the checklist in docs/security-model.md.',
      ),
    ),
  };
}
