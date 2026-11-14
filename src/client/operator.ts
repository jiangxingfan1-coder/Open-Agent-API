/**
 * Dispatch for the operator commands: `approvals`, `approve`, `deny`, `status`, `verify`, `webhook`.
 * cli.ts only hands over the parsed flags; everything else lives in the modules imported here.
 */
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import { decideApprovals, showApprovals } from './approvals.js';
import { resolveConnection, type ConnectionFlags } from './connection.js';
import { showStatus } from './status.js';
import { runVerifyCommand, type VerifyFlags } from './verify.js';
import { runWebhookCommand, type WebhookFlags } from './webhook-cli.js';

export const OPERATOR_COMMANDS = [
  'approvals',
  'approve',
  'deny',
  'status',
  'verify',
  'webhook',
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
  throw new Fault('unknown_command', `Unknown command: ${command}`);
}
