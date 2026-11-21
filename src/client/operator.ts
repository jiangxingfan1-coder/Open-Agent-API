/**
 * Dispatch for the operator commands: `approvals`, `approve`, `deny`, `status`, `verify`, `webhook`,
 * `prune`, `file-index`.
 * cli.ts only hands over the parsed flags; everything else lives in the modules imported here.
 */
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import { decideApprovals, showApprovals } from './approvals.js';
import { resolveConnection, type ConnectionFlags } from './connection.js';
import { showStatus } from './status.js';
import { runVerifyCommand, type VerifyFlags } from './verify.js';
import { runWebhookCommand, type WebhookFlags } from './webhook-cli.js';
import { pruneCommand } from './prune.js';
import { fileIndexCommand } from './file-index.js';
import { loadConfig } from '../config/config.js';
import path from 'node:path';

export const OPERATOR_COMMANDS = [
  'approvals',
  'approve',
  'deny',
  'status',
  'verify',
  'webhook',
  'prune',
  'file-index',
] as const;

export const isOperatorCommand = (command: string): command is (typeof OPERATOR_COMMANDS)[number] =>
  (OPERATOR_COMMANDS as readonly string[]).includes(command);

export type OperatorFlags = ConnectionFlags &
  VerifyFlags &
  WebhookFlags & {
    json?: boolean;
    watch?: boolean;
    action?: string;
    all?: boolean;
    yes?: boolean;
    reason?: string;
    config?: string;
    'older-than'?: string;
    'dry-run'?: boolean;
    vacuum?: boolean;
    write?: boolean;
  };

/** Run `fn` with an AbortSignal that fires on Ctrl+C or SIGTERM, then remove the handlers. */
export async function withInterrupt<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Persistent handlers: a second Ctrl+C during cleanup is ignored instead of killing the process
  // halfway and leaving agent processes behind.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await fn(controller.signal);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export async function runOperatorCommand(
  command: (typeof OPERATOR_COMMANDS)[number],
  args: string[],
  flags: OperatorFlags,
  ctx: { prefix?: string } = {},
): Promise<void> {
  if (command === 'approvals') {
    const { client } = await resolveConnection(flags);
    await withInterrupt((signal) =>
      showApprovals(client, { json: flags.json, watch: flags.watch, signal }),
    );
    return;
  }
  if (command === 'approve' || command === 'deny') {
    const run = args[0];
    if (!run)
      throw new Fault(
        'arguments',
        bi(`${command} 需要运行编号（RESPONSE_ID）。`, `${command} needs a run ID (RESPONSE_ID).`),
      );
    const { client } = await resolveConnection(flags);
    const results = await decideApprovals(client, {
      run,
      decision: command,
      action: flags.action,
      all: flags.all,
      reason: flags.reason,
      yes: flags.yes,
      json: flags.json,
    });
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    process.exitCode = await withInterrupt((interrupt) =>
      runVerifyCommand(args, flags, { interrupt }),
    );
    return;
  }
  if (command === 'webhook') {
    const { client } = await resolveConnection(flags);
    await runWebhookCommand(client, args, flags);
    return;
  }
  if (command === 'status') {
    // Read-only; exits 1 when the gateway is not running so scripts can test it.
    if (!(await showStatus(flags, { json: flags.json, prefix: ctx.prefix }))) process.exitCode = 1;
    return;
  }
  if (command === 'file-index') {
    const target = args[0] ?? 'scope-bytes';
    if (
      args.length > 1 ||
      (target !== 'scope-only' && target !== 'scope-bytes') ||
      Object.keys(flags).some((k) => !['config', 'dir', 'write', 'dry-run', 'json'].includes(k)) ||
      (flags.config && flags.dir) ||
      (flags.write && flags['dry-run'])
    )
      throw new Fault(
        'arguments',
        'Use file-index [scope-bytes | scope-only] [--write | --dry-run] [--config FILE | --dir DIR].',
      );
    const file = path.resolve(
      flags.config ?? (flags.dir ? path.join(flags.dir, 'config.json') : '.oaa/config.json'),
    );
    const config = await loadConfig(file);
    process.stdout.write(
      JSON.stringify(
        {
          ...fileIndexCommand(config.dataDir, !!flags.write, target),
          storage_cap_configured: config.maxStoredBytesPerSubject !== undefined,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (command === 'prune') {
    const file = path.resolve(
      flags.config ?? (flags.dir ? path.join(flags.dir, 'config.json') : '.oaa/config.json'),
    );
    const report = await pruneCommand(await loadConfig(file), {
      olderThan: flags['older-than'],
      dryRun: flags['dry-run'],
      vacuum: flags.vacuum,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  throw new Fault('unknown_command', `Unknown command: ${command}`);
}
