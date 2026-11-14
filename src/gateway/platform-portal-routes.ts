import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildEndpointDirectory, GATEWAY_VERSION } from './endpoints.js';
import type { AccountView } from './platform-types.js';
import {
  wireAccount,
  wireEntry,
  wireListedAgent,
  wirePage,
  wirePortalKey,
  wireRunDetail,
  wireRunItem,
  wireSession,
  wireUsage,
  type PlatformRouteDeps,
} from './platform-wire.js';

const credentials = z.object({ email: z.string().max(320), password: z.string().max(1000) });
const signupBody = credentials
  .extend({
    name: z.string().max(1000).optional(),
    invite_code: z.string().max(200).optional(),
  })
  .strict();
const loginBody = credentials.strict();
const passwordBody = z
  .object({ current_password: z.string().max(1000), new_password: z.string().max(1000) })
  .strict();
const keyBody = z.object({ name: z.string().max(1000) }).strict();
const redeemBody = z.object({ code: z.string().max(1000) }).strict();
const agentQuery = z.object({ id: z.string().min(1).max(200) }).strict();
const usageQuery = z.object({ days: z.coerce.number().default(30) }).strict();
const resetBody = z
  .object({
    email: z.string().max(320),
    code: z.string().max(1000),
    new_password: z.string().max(1000),
  })
  .strict();
const runsQuery = z
  .object({
    limit: z.coerce.number().optional(),
    cursor: z.coerce.number().optional(),
    agent: z.string().min(1).max(200).optional(),
  })
  .strict();
const ledgerQuery = z
  .object({
    limit: z.coerce.number().optional(),
    cursor: z.coerce.number().optional(),
  })
  .strict();

/**
 * Portal session: `Authorization: Bearer oas_…`. API keys (`sk-oaa-…`, legacy `oaa_…`) never pass here, they get
 * `session_invalid` like any other bad token. The routes that use it skip API-key authentication
 * (see `portalPath` in platform-routes.ts), so this is the only check on them.
 */
function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') && header.length <= 1000 ? header.slice(7) : undefined;
}

/** 开发者门户的接口：公开的站点与目录、注册登录，以及凭会话令牌访问的账号、密钥、兑换与用量。 */
export function registerPortalRoutes(
  app: FastifyInstance,
  { platform, clientIp, publicBaseUrl }: PlatformRouteDeps,
): void {
  const signedIn = (req: FastifyRequest): { token: string; account: AccountView } => {
    const token = bearer(req);
    return { token: token ?? '', account: platform.session(token) };
  };

  // ---- public ------------------------------------------------------------------------------
  app.get('/v1/portal/site', async (req) => {
    const site = platform.site();
    const baseUrl = publicBaseUrl(req);
    return {
      site_name: site.siteName,
      registration: site.registration,
      base_url: baseUrl,
      endpoints: buildEndpointDirectory(baseUrl),
      version: GATEWAY_VERSION,
    };
  });
  app.get('/v1/portal/agents', async () => ({
    data: platform.listedAgents().map(wireListedAgent),
  }));
  app.get('/v1/portal/agent', async (req) =>
    wireListedAgent(platform.listedAgent(agentQuery.parse(req.query).id)),
  );
  app.post('/v1/portal/signup', async (req, reply) => {
    const b = signupBody.parse(req.body);
    const { account, session } = await platform.signup(
      {
        email: b.email,
        password: b.password,
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.invite_code !== undefined ? { inviteCode: b.invite_code } : {}),
      },
      clientIp(req) ?? 'unknown',
    );
    return reply.code(201).send({ account: wireAccount(account), session: wireSession(session) });
  });
  app.post('/v1/portal/login', async (req) => {
    const b = loginBody.parse(req.body);
    const { account, session } = await platform.login(b, clientIp(req) ?? 'unknown');
    return { account: wireAccount(account), session: wireSession(session) };
  });
  app.post('/v1/portal/password-reset', async (req, reply) => {
    const b = resetBody.parse(req.body);
    await platform.resetWithCode(
      { email: b.email, code: b.code, newPassword: b.new_password },
      clientIp(req) ?? 'unknown',
    );
    return reply.code(204).send();
  });

  // ---- portal session ----------------------------------------------------------------------
  app.post('/v1/portal/logout', async (req, reply) => {
    const { token } = signedIn(req);
    platform.logout(token);
    return reply.code(204).send();
  });
  app.get('/v1/portal/account', async (req) => ({ account: wireAccount(signedIn(req).account) }));
  app.post('/v1/portal/account/password', async (req, reply) => {
    const { account } = signedIn(req);
    const b = passwordBody.parse(req.body);
    await platform.changePassword(account.id, b.current_password, b.new_password);
    return reply.code(204).send();
  });
  app.get('/v1/portal/keys', async (req) => ({
    data: platform.keys(signedIn(req).account.id).map(wirePortalKey),
  }));
  app.post('/v1/portal/keys', async (req, reply) => {
    const { account } = signedIn(req);
    const b = keyBody.parse(req.body);
    const key = platform.createKey(account.id, b.name);
    return reply.code(201).send({ ...wirePortalKey(key), token: key.token });
  });
  app.delete('/v1/portal/keys/:id', async (req, reply) => {
    const { account } = signedIn(req);
    platform.revokeKey(account.id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.post('/v1/portal/redeem', async (req) => {
    const { account } = signedIn(req);
    const b = redeemBody.parse(req.body);
    const result = platform.redeem(account.id, b.code);
    return { account: wireAccount(result.account), credited: result.credited };
  });
  app.get('/v1/portal/usage', async (req) => {
    const { account } = signedIn(req);
    return wireUsage(platform.usage(account.id, usageQuery.parse(req.query).days));
  });
  app.get('/v1/portal/runs', async (req) => {
    const { account } = signedIn(req);
    const q = runsQuery.parse(req.query);
    return wirePage(
      platform.runList(account.id, {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.agent !== undefined ? { agent: q.agent } : {}),
      }),
      wireRunItem,
    );
  });
  app.get('/v1/portal/runs/:id', async (req) => {
    const { account } = signedIn(req);
    return wireRunDetail(platform.runDetail(account.id, (req.params as { id: string }).id));
  });
  app.get('/v1/portal/ledger', async (req) => {
    const { account } = signedIn(req);
    const q = ledgerQuery.parse(req.query);
    return wirePage(
      platform.ledger(account.id, {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
      wireEntry,
    );
  });
}
