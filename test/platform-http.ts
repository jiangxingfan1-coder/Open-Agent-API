import { makeBundle } from '../src/lang/bundle.js';
import { agent, setup, token } from './helpers.js';

// Shared by the developer-platform route tests (not a test file itself): in-process inject only.

export type Setup = Awaited<ReturnType<typeof setup>>;
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export const ADMIN = token;
/** Expected point values computed with floats, rounded the way the platform reports them. */
export const pts = (x: number) => Math.round(x * 1e6) / 1e6;

/** One request without or with a Bearer credential; PUT included (the shared `request` has none). */
export function call(
  s: Setup,
  method: Method,
  url: string,
  payload?: unknown,
  bearer?: string,
  headers: Record<string, string> = {},
) {
  return s.app.inject({
    method,
    url,
    payload: payload as never,
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
  });
}
export const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

/** A gateway with the platform enabled, an `agent/paid` and an `agent/free` published. */
export async function withPlatform(
  platform: Record<string, unknown>,
  fn: (s: Setup) => Promise<void>,
  gateway: Record<string, unknown> = {},
): Promise<void> {
  const s = await setup(undefined, {
    platform: { owner: 'owner', registration: 'open', ...platform },
    ...gateway,
  });
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/paid' })));
    s.store.publish('owner', makeBundle(agent({ id: 'agent/free' })));
    await fn(s);
  } finally {
    await s.cleanup();
  }
}

/** Registers a developer through the portal; returns the account and its session token. */
export async function signup(s: Setup, email = 'dev@x.io', password = 'password1') {
  const r = await call(s, 'POST', '/v1/portal/signup', { email, password });
  if (r.statusCode !== 201) throw new Error(`signup failed: ${r.body}`);
  const body = r.json();
  return { account: body.account, session: body.session.token as string };
}
/** Creates an API key for the signed-in developer. */
export async function newKey(s: Setup, session: string, name = 'k') {
  const r = await call(s, 'POST', '/v1/portal/keys', { name }, session);
  if (r.statusCode !== 201) throw new Error(`key failed: ${r.body}`);
  return r.json();
}
