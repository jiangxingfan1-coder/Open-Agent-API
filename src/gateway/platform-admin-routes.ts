import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { principalSubject } from '../core/contracts.js';
import type { PlatformAuditCode } from '../store/audit.js';
import {
  wireAccount,
  wireAdminAccount,
  wireAdminUsage,
  wireCode,
  wireEntry,
  wireListing,
  wirePage,
  wireSummary,
  type PlatformRouteDeps,
} from './platform-wire.js';

const finite = z.number().finite();
const pageQuery = {
  limit: z.coerce.number().optional(),
  cursor: z.coerce.number().optional(),
};
const accountsQuery = z.object({ query: z.string().max(254).optional(), ...pageQuery }).strict();
const ledgerQuery = z.object(pageQuery).strict();
const usageQuery = z.object({ days: z.coerce.number().default(30) }).strict();
const listingQuery = z.object({ agent_id: z.string().min(1).max(200) }).strict();
const createBody = z
  .object({
    email: z.string().max(320),
    password: z.string().max(1000),
    name: z.string().max(1000).optional(),
    credits: finite.optional(),
  })
  .strict();
const statusBody = z.object({ status: z.enum(['active', 'disabled']) }).strict();
const creditBody = z
  .object({
    amount: finite,
    note: z.string().max(1000),
    reference: z.string().max(1000).optional(),
  })
  .strict();
const passwordBody = z.object({ new_password: z.string().max(1000) }).strict();
const listingBody = z
  .object({
    agent_id: z.string().min(1).max(200),
    title: z.string().max(1000).optional(),
    summary: z.string().max(5000).optional(),
    tags: z.array(z.string().max(1000)).max(100).optional(),
    price: z
      .object({ per_run: finite.optional(), per_1k_tokens: finite.optional() })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    host_execution: z.boolean().optional(),
  })
  .strict();
const codesBody = z
  .object({
    kind: z.enum(['credit', 'invite']),
    credits: finite.optional(),
    max_uses: z.number().int().optional(),
    count: z.number().int().optional(),
    expires_at: z.number().int().nullable().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

/** 运营者接口（`/v1/platform/*`）：每条都要 owner 级管理员密钥（入账与按邮箱找账号另接受 `billing` 密钥）；资金与账号状态的变更写审计记录。 */
export function registerPlatformAdminRoutes(
  app: FastifyInstance,
  { platform, audit, clientIp }: PlatformRouteDeps,
): void {
  // The operator's own key authenticated on the console host already (onRequest); this adds the
  // owner-wide check. Every route calls it first.
  const operator = (req: FastifyRequest) => platform.requireOperator(req.principal);
  /** An operator action on one account: who, when, which account; never a password or a code. */
  const record = (req: FastifyRequest, code: PlatformAuditCode, accountId: string, detail = '') => {
    const p = req.principal;
    audit.note({
      owner: p.owner,
      code,
      keyId: p.keyId,
      subject: principalSubject(p),
      method: req.method,
      path: req.url.split('?')[0]!,
      ip: clientIp(req),
      accountId,
      ...(detail ? { detail } : {}),
    });
  };
  /** The listing's host-execution switch changed (`on` / `off`). */
  const hostSwitch = (req: FastifyRequest, agentId: string, on: boolean) => {
    const p = req.principal;
    audit.note({
      owner: p.owner,
      code: 'platform_listing_host_execution',
      keyId: p.keyId,
      subject: principalSubject(p),
      method: req.method,
      path: req.url.split('?')[0]!,
      ip: clientIp(req),
      agentId,
      detail: on ? 'on' : 'off',
    });
  };
  const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/v1/platform/summary', async (req) => {
    operator(req);
    return wireSummary(platform.summary());
  });
  app.get('/v1/platform/accounts', async (req) => {
    // Also open to `billing` keys: a payment callback finds the account by email.
    platform.requireCreditor(req.principal);
    const q = accountsQuery.parse(req.query);
    return wirePage(
      platform.adminAccounts({
        ...(q.query !== undefined ? { query: q.query } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
      wireAdminAccount,
    );
  });
  app.post('/v1/platform/accounts', async (req, reply) => {
    operator(req);
    const b = createBody.parse(req.body);
    const account = await platform.createAccount({
      email: b.email,
      password: b.password,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.credits !== undefined ? { credits: b.credits } : {}),
    });
    return reply.code(201).send({ account: wireAccount(account) });
  });
  app.post('/v1/platform/accounts/:id/status', async (req) => {
    operator(req);
    const b = statusBody.parse(req.body);
    const account = platform.setAccountStatus(idOf(req), b.status);
    record(req, 'platform_account_status', account.id, `status=${account.status}`);
    return { account: wireAccount(account) };
  });
  app.post('/v1/platform/accounts/:id/credit', async (req) => {
    const creditor = platform.requireCreditor(req.principal);
    const b = creditBody.parse(req.body);
    const result = platform.creditAccount(idOf(req), b.amount, b.note, {
      ...(b.reference !== undefined ? { reference: b.reference } : {}),
      positiveOnly: creditor === 'billing',
    });
    const body = { account: wireAccount(result.account), entry: wireEntry(result.entry) };
    // A repeated reference posts nothing, so there is nothing new to audit.
    if (result.duplicate) return { ...body, duplicate: true };
    record(
      req,
      'platform_credit_adjusted',
      result.account.id,
      `amount=${result.entry.amount} balance_after=${result.entry.balanceAfter}`,
    );
    return body;
  });
  app.post('/v1/platform/accounts/:id/password', async (req, reply) => {
    operator(req);
    const b = passwordBody.parse(req.body);
    await platform.resetPassword(idOf(req), b.new_password);
    record(req, 'platform_password_reset', idOf(req));
    return reply.code(204).send();
  });
  app.post('/v1/platform/accounts/:id/reset-code', async (req, reply) => {
    operator(req);
    const made = platform.issueResetCode(idOf(req));
    record(req, 'platform_password_reset', idOf(req), 'reset_code');
    return reply.code(201).send({ code: made.code, expires_at: made.expiresAt });
  });
  app.get('/v1/platform/accounts/:id/ledger', async (req) => {
    operator(req);
    const q = ledgerQuery.parse(req.query);
    return wirePage(
      platform.accountLedger(idOf(req), {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      }),
      wireEntry,
    );
  });
  app.get('/v1/platform/listings', async (req) => {
    operator(req);
    return { data: platform.allListings().map(wireListing) };
  });
  app.put('/v1/platform/listings', async (req) => {
    operator(req);
    const b = listingBody.parse(req.body);
    const before = platform.allListings().find((l) => l.agentId === b.agent_id);
    const view = wireListing(
      platform.putListing({
        agentId: b.agent_id,
        ...(b.host_execution !== undefined ? { hostExecution: b.host_execution } : {}),
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.summary !== undefined ? { summary: b.summary } : {}),
        ...(b.tags !== undefined ? { tags: b.tags } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.price
          ? {
              price: {
                ...(b.price.per_run !== undefined ? { perRun: b.price.per_run } : {}),
                ...(b.price.per_1k_tokens !== undefined
                  ? { per1kTokens: b.price.per_1k_tokens }
                  : {}),
              },
            }
          : {}),
      }),
    );
    // Turning the switch on or off (including creating a listing with it on) is audited.
    if (view.host_execution !== (before?.hostExecution ?? false))
      hostSwitch(req, b.agent_id, view.host_execution);
    return view;
  });
  app.delete('/v1/platform/listings', async (req, reply) => {
    operator(req);
    const agentId = listingQuery.parse(req.query).agent_id;
    const before = platform.allListings().find((l) => l.agentId === agentId);
    platform.deleteListing(agentId);
    // Removing a listing whose switch was on also ends that permission.
    if (before?.hostExecution) hostSwitch(req, agentId, false);
    return reply.code(204).send();
  });
  app.get('/v1/platform/codes', async (req) => {
    operator(req);
    return { data: platform.allCodes().map(wireCode) };
  });
  app.post('/v1/platform/codes', async (req, reply) => {
    operator(req);
    const b = codesBody.parse(req.body);
    const made = platform.createCodes({
      kind: b.kind,
      ...(b.credits !== undefined ? { credits: b.credits } : {}),
      ...(b.max_uses !== undefined ? { maxUses: b.max_uses } : {}),
      ...(b.count !== undefined ? { count: b.count } : {}),
      ...(b.expires_at !== undefined ? { expiresAt: b.expires_at } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
    });
    return reply.code(201).send({ data: made.map((c) => ({ ...wireCode(c), code: c.code })) });
  });
  app.delete('/v1/platform/codes/:id', async (req, reply) => {
    operator(req);
    platform.revokeCode(idOf(req));
    return reply.code(204).send();
  });
  app.get('/v1/platform/usage', async (req) => {
    operator(req);
    return wireAdminUsage(platform.adminUsage(usageQuery.parse(req.query).days));
  });
}
