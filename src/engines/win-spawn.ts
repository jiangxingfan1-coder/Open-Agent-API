/**
 * Windows process launching. Node refuses to spawn `.cmd` / `.bat` files without a shell (EINVAL,
 * CVE-2024-27980) and does not apply PATHEXT, so an npm-installed CLI (`codex.cmd`) can neither be
 * found nor started by name. This module resolves the real file, runs npm shims straight through
 * node (no cmd.exe involved), and only falls back to `cmd.exe /d /s /c` with every argument quoted
 * and caret-escaped, so caller-controlled text can never become a cmd command.
 * Everything here is a no-op outside Windows unless `platform` is passed explicitly (tests).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Fault } from '../core/util.js';
import { bi } from '../core/locale.js';
import { npmShimTarget, resolveWindowsCommand } from '../core/which.js';

export { npmShimTarget, resolveWindowsCommand };

type Platform = NodeJS.Platform;

/** Quote one argument for the MSVCRT / CommandLineToArgvW parser. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(backslashes * 2 + 1) + '"';
    else out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** Caret-escape every character cmd.exe treats specially (including quotes, `%` and `!`). */
export function escapeCmdMeta(text: string): string {
  return text.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}

/**
 * A `cmd.exe /d /s /c "..."` command line running `file` with `args`. Arguments are escaped twice:
 * once for cmd.exe parsing this line and once more for the batch file re-parsing `%*`. CR/LF and
 * NUL cannot be passed through cmd.exe at all and are rejected instead of being truncated.
 */
export function cmdCommandLine(file: string, args: readonly string[]): string {
  for (const value of [file, ...args])
    if (/[\r\n\0]/.test(value))
      throw new Fault(
        'invalid_request',
        bi(
          'Windows 批处理启动器（.cmd）无法安全传递含换行的参数；请把智能体装成 .exe 或 node 脚本，或改用标准输入传文本。',
          'Arguments with line breaks cannot be passed to a Windows batch-file launcher; install the agent as an .exe or node script, or pass the text on stdin.',
        ),
        400,
      );
  const line = [
    escapeCmdMeta(quoteWindowsArg(file)),
    ...args.map((a) => escapeCmdMeta(escapeCmdMeta(quoteWindowsArg(a)))),
  ].join(' ');
  return `"${line}"`;
}

export type LaunchPlan = {
  command: string;
  args: string[];
  /** Set when `args` is a pre-built command line that Node must pass unchanged. */
  windowsVerbatimArguments?: boolean;
};

/** How to start `command args` on this platform without a shell and without injection risk. */
export function launchPlan(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
): LaunchPlan {
  if (platform !== 'win32') return { command, args };
  const resolved = resolveWindowsCommand(command, env) ?? command;
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs')
    return { command: process.execPath, args: [resolved, ...args] };
  if (ext !== '.cmd' && ext !== '.bat') return { command: resolved, args };
  const script = npmShimTarget(resolved);
  if (script) return { command: process.execPath, args: [script, ...args] };
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', cmdCommandLine(resolved, args)],
    windowsVerbatimArguments: true,
  };
}

/**
 * Path a host that spawns the CLI itself (the Claude Agent SDK) can start: an npm shim becomes its
 * JavaScript entry point, which such hosts run through node. Unchanged elsewhere.
 */
export function directExecutable(executable: string, platform: Platform = process.platform) {
  if (platform !== 'win32') return executable;
  const resolved = resolveWindowsCommand(executable) ?? executable;
  return /\.(cmd|bat)$/i.test(resolved) ? (npmShimTarget(resolved) ?? resolved) : resolved;
}

/** End a whole Windows process tree (`taskkill /T /F`); there is no graceful console signal. */
export function killWindowsTree(pid: number): void {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    killer.unref();
  } catch {
    // taskkill unavailable; the caller's direct kill is the fallback.
  }
}
