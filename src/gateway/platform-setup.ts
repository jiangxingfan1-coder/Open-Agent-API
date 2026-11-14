/**
 * 在控制台里启用、修改、停用开发者平台（`GET/PUT /v1/platform/setup`）。
 *
 * 设置存在网关数据库的 `gateway_platform_setup` 表里（单行），不改写配置文件；表只在第一次保存时建，
 * 从没用过这个功能的网关，数据文件与之前一样。保存后**重启网关才生效**：Fastify 开始监听后不能再注册
 * 路由，所以启动时由 `runningPlatform` 把「配置文件的 platform 段，否则已保存且开关为开的设置」合成
 * 平台配置，其余代码路径（`platform-v1`、路由、门户）不变。配置文件优先；写了 platform 段时界面只读。
 * 停用只关开关：已保存的设置与 `platform_*` 表里的账号、流水、上架都保留。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { platformSchema, type GatewayConfig } from '../config/config.js';
import { principalSubject, type Principal } from '../core/contracts.js';
import { Fault } from '../core/util.js';
import type { AuditLog } from '../store/audit.js';
import { requireOwnerAdmin, type PlatformConfig } from './platform-db.js';

const TABLE = 'gateway_platform_setup';
type Saved = {
  enabled: boolean;
  owner: string;
  siteName: string;
  registration: PlatformConfig['registration'];
  signupCredits: number;
};
/** 当前进程里运行的平台配置与来源；平台没在运行时为 undefined。 */
export type RunningPlatform = { config: PlatformConfig; source: 'config' | 'console' };

const fields = platformSchema.shape;
const setupBody = z
  .object({
    enabled: z.boolean(),
    site_name: fields.siteName.unwrap().optional(),
    registration: fields.registration.unwrap().optional(),
    signup_credits: fields.signupCredits.unwrap().optional(),
  })
  .strict();

function hasTable(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}
function loadSaved(db: DatabaseSync): Saved | undefined {
  if (!hasTable(db)) return undefined;
  const row = db.prepare(`SELECT payload FROM ${TABLE} WHERE id=1`).get();
  return row ? (JSON.parse(String(row.payload)) as Saved) : undefined;
}
function save(db: DatabaseSync, saved: Saved): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE}(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)`,
  );
  db.prepare(
    `INSERT INTO ${TABLE}(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
  ).run(JSON.stringify(saved));
}
const toConfig = (s: Saved): PlatformConfig =>
  platformSchema.parse({
    owner: s.owner,
    siteName: s.siteName,
    registration: s.registration,
    signupCredits: s.signupCredits,
  });

/** 启动时：配置文件的 platform 段优先，否则已保存且开关为开的设置（其余字段取 schema 默认值）。 */
export function runningPlatform(
  config: GatewayConfig,
  db: DatabaseSync,
): RunningPlatform | undefined {
  if (config.platform) return { config: config.platform, source: 'config' };
  const saved = loadSaved(db);
  return saved?.enabled ? { config: toConfig(saved), source: 'console' } : undefined;
}

const sameSettings = (a: PlatformConfig, b: PlatformConfig) =>
  a.owner === b.owner &&
  a.siteName === b.siteName &&
  a.registration === b.registration &&
  a.signupCredits === b.signupCredits;
const wireSettings = (c: Pick<Saved, 'siteName' | 'registration' | 'signupCredits'>) => ({
  site_name: c.siteName,
  registration: c.registration,
  signup_credits: c.signupCredits,
});

export function setupView(
  config: GatewayConfig,
  db: DatabaseSync,
  running: RunningPlatform | undefined,
  callerOwner: string,
) {
  const managed = config.platform;
  const saved = managed ? undefined : loadSaved(db);
  let pending = false;
  if (!managed && saved) {
    const desired = saved.enabled ? toConfig(saved) : undefined;
    pending =
      !desired !== !running ||
      (!!desired &&
        !!running &&
        (running.source !== 'console' || !sameSettings(desired, running.config)));
  }
  return {
    enabled: !!running,
    source: running?.source ?? null,
    managed_by_config: !!managed,
    pending_restart: pending,
    owner: managed?.owner ?? saved?.owner ?? callerOwner,
    settings: managed ? wireSettings(managed) : saved ? wireSettings(saved) : null,
    desired: managed ? true : (saved?.enabled ?? false),
  };
}

/**
 * 设置归首次启用它的 owner：配置文件的 platform 段归 `config.platform.owner`，已保存的记录归
 * `saved.owner`（停用后也一样）；都没有时任何 owner 级管理员都可以查看并首次保存。
 * 拒绝消息里不出现那个 owner 的名字。
 */
function requireSetupOwner(
  config: GatewayConfig,
  db: DatabaseSync,
  p: Principal,
): Saved | undefined {
  requireOwnerAdmin(p);
  const saved = config.platform ? undefined : loadSaved(db);
  const owner = config.platform?.owner ?? saved?.owner;
  if (owner !== undefined && owner !== p.owner)
    throw new Fault('scope_denied', 'The platform settings belong to another owner.', 403);
  return saved;
}

export type PlatformSetupDeps = {
  config: GatewayConfig;
  db: DatabaseSync;
  running: RunningPlatform | undefined;
  audit: AuditLog;
  clientIp: (req: FastifyRequest) => string | undefined;
};

/** 两个接口在平台未启用时也注册；权限与运营者接口同一档（owner 级管理员密钥，只在控制台域名上）。 */
export function registerPlatformSetup(app: FastifyInstance, deps: PlatformSetupDeps): void {
  const { config, db, running, audit, clientIp } = deps;
  app.get('/v1/platform/setup', async (req) => {
    requireSetupOwner(config, db, req.principal);
    return setupView(config, db, running, req.principal.owner);
  });
  app.put('/v1/platform/setup', async (req) => {
    const p = req.principal;
    const previous = requireSetupOwner(config, db, p);
    if (config.platform)
      throw new Fault(
        'platform_managed_by_config',
        'The developer platform is configured in the config file; edit its platform section instead.',
        409,
      );
    const b = setupBody.parse(req.body);
    // Defaults come from the same schema as the config file's platform section.
    const d = platformSchema.parse({ owner: p.owner });
    const defaults: Saved = {
      enabled: false,
      owner: p.owner,
      siteName: d.siteName,
      registration: d.registration,
      signupCredits: d.signupCredits,
    };
    const next: Saved = b.enabled
      ? {
          ...(previous ?? defaults),
          enabled: true,
          ...(b.site_name !== undefined ? { siteName: b.site_name } : {}),
          ...(b.registration !== undefined ? { registration: b.registration } : {}),
          ...(b.signup_credits !== undefined ? { signupCredits: b.signup_credits } : {}),
        }
      : { ...(previous ?? defaults), enabled: false };
    save(db, next);
    audit.note({
      owner: p.owner,
      code: 'platform_setup',
      keyId: p.keyId,
      subject: principalSubject(p),
      method: req.method,
      path: req.url.split('?')[0]!,
      ip: clientIp(req),
      detail: `enabled=${next.enabled} registration=${next.registration} signup_credits=${next.signupCredits}`,
    });
    return setupView(config, db, running, p.owner);
  });
}
