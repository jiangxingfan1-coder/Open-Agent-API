/**
 * `oaa prune [--older-than 30d] [--dry-run] [--vacuum]`: delete finished runs older than the
 * given age with their events, artifacts and workspaces (src/store/retention.ts).
 *
 * With a gateway running on the configured address the request goes through its API
 * (`POST /v1/maintenance/prune`, admin key) so the live process keeps consistent caches; that
 * path prunes the admin key's owner and cannot VACUUM. Otherwise the data directory is opened
 * directly (taking the gateway lease, so a gateway cannot start meanwhile).
 */
import path from 'node:path';
import { GatewayClient } from './client.js';
import { gatewayUrl, healthPid } from './onboarding.js';
import type { GatewayConfig } from '../config/config.js';
import { bi } from '../core/locale.js';
import { Fault } from '../core/util.js';
import { Store } from '../store/store.js';
import { databaseBytes, parseAge, prune } from '../store/retention.js';

export type PruneFlags = { olderThan?: string; dryRun?: boolean; vacuum?: boolean };

export async function pruneCommand(
  config: GatewayConfig,
  flags: PruneFlags,
): Promise<Record<string, unknown>> {
  let olderThanMs: number;
  try {
    olderThanMs = parseAge(flags.olderThan ?? '30d');
  } catch {
    throw new Fault(
      'arguments',
      bi(
        `--older-than 的格式不对：${flags.olderThan}。示例：30d、12h、45m。`,
        `Invalid --older-than: ${flags.olderThan}. Examples: 30d, 12h, 45m.`,
      ),
    );
  }
  const url = gatewayUrl(config);
  if ((await healthPid(url)) !== undefined) {
    if (flags.vacuum)
      throw new Fault(
        'gateway_already_running',
        bi(
          '--vacuum 需要先停止网关（oaa stop）。',
          '--vacuum needs the gateway stopped first (oaa stop).',
        ),
        409,
      );
    const admin = config.keys.find((k) => k.scopes.includes('admin') && k.tokenFile)?.tokenFile;
    if (!admin) throw new Fault('token_required', 'No admin key with a tokenFile is configured.');
    const client = await GatewayClient.fromOptions(url, admin);
    return {
      via: 'gateway',
      ...(await client.request('POST', '/v1/maintenance/prune', {
        older_than_ms: Math.max(60_000, Math.round(olderThanMs)),
        dry_run: !!flags.dryRun,
      })),
    };
  }
  const store = new Store(config.dataDir);
  try {
    const report = await prune(store, {
      olderThanMs,
      dryRun: flags.dryRun,
      workerDataDir: config.localWorker?.dataDir,
    });
    let vacuumed: number | undefined;
    if (flags.vacuum && !flags.dryRun) {
      store.db.exec('VACUUM');
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      vacuumed = await databaseBytes(store.root);
    }
    return {
      via: 'data_dir',
      data_dir: path.resolve(config.dataDir),
      ...report,
      ...(vacuumed === undefined ? {} : { database_bytes_after_vacuum: vacuumed }),
    };
  } finally {
    store.close();
  }
}

/** `oaa doctor` hint: the database size against `retention.warnDatabaseMb`. */
export async function databaseHealth(config: GatewayConfig): Promise<Record<string, unknown>> {
  const bytes = await databaseBytes(config.dataDir);
  const limitMb = config.retention?.warnDatabaseMb ?? 1024;
  const over = bytes > limitMb * 1024 * 1024;
  return {
    bytes,
    warn_mb: limitMb,
    retention_runs_days: config.retention?.runsDays ?? null,
    ...(over
      ? {
          warning: bi(
            `数据库已超过 ${limitMb} MB。可以运行 oaa prune --older-than 30d --dry-run 查看能清理多少，或在配置里设置 retention.runsDays。`,
            `The database is larger than ${limitMb} MB. Run oaa prune --older-than 30d --dry-run to see what can be removed, or set retention.runsDays in the config.`,
          ),
        }
      : {}),
  };
}
