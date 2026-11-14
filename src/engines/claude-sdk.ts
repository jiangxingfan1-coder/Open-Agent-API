/**
 * Loading the Claude Agent SDK for the Claude native engine.
 *
 * The SDK is proprietary (Anthropic's own terms), so public release packages do not ship it. When
 * it resolves next to the gateway (a source checkout or `npm install`), it is imported exactly as
 * before. Otherwise it is looked up in a separate vendor directory the owner installs it into; if
 * it is in neither place, the run fails with a catalogued error code and the install command
 * instead of a module-resolution stack trace.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bi, pick } from '../core/locale.js';
import { Fault, executableExists } from '../core/util.js';

export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** Pinned to the version in package.json `dependencies` (test/claude-sdk.test.ts checks it). */
export const CLAUDE_SDK_VERSION = '0.3.322';

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
type Lookup = { specifier?: string; vendorDir?: string; npm?: boolean };
export type ClaudeSdkStatus =
  | { status: 'available'; source: 'bundled' | 'vendor' }
  | { status: 'requires_separate_install'; package: string; install: string; message: string };

/** Where a separately installed SDK is looked up: `$OAA_CLAUDE_SDK_DIR`, else `~/.oaa/vendor`. */
export function claudeSdkVendorDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OAA_CLAUDE_SDK_DIR || path.join(os.homedir(), '.oaa', 'vendor');
}

function locate(
  specifier: string,
  vendorDir: string,
): { source: 'bundled' | 'vendor'; url?: string } | undefined {
  try {
    import.meta.resolve(specifier);
    return { source: 'bundled' };
  } catch {
    // Not bundled; fall back to the vendored copy below.
  }
  try {
    const file = createRequire(path.join(vendorDir, 'package.json')).resolve(specifier);
    return { source: 'vendor', url: pathToFileURL(file).href };
  } catch {
    return undefined;
  }
}

/** PATH 上或当前 Node 旁边有没有 npm。安装包只带 Node 运行时，不带 npm。 */
export function npmAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const dirs = [path.dirname(process.execPath), ...(env.PATH ?? '').split(path.delimiter)];
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'];
  return dirs.some((dir) => dir && names.some((n) => executableExists(path.join(dir, n))));
}

function installHint(specifier: string, vendorDir: string, npm = npmAvailable()) {
  const install = `npm install --prefix "${vendorDir}" ${specifier}@${CLAUDE_SDK_VERSION}`;
  const where = path.join(vendorDir, 'node_modules');
  const noNpm = npm
    ? bi('', '')
    : bi(
        '这台机器上找不到 npm（安装包只自带 Node 运行时，不带 npm）：先从 https://nodejs.org 安装 Node.js 24（自带 npm），再运行下面的安装命令。',
        'npm was not found on this machine (the installer ships only the Node runtime, without npm): first install Node.js 24 from https://nodejs.org (it includes npm), then run the install command below. ',
      );
  const text = bi(
    noNpm.zh +
      `Claude 原生引擎需要另行安装 ${specifier}：该 SDK 受 Anthropic 自己的条款约束，` +
      `不随 Open Agent API 安装包分发。安装命令：${install}。网关会在 ` +
      `${where} 中查找它（可用环境变量 OAA_CLAUDE_SDK_DIR 指定其他目录），装好后重启网关。`,
    noNpm.en +
      `The Claude native engine needs ${specifier} installed separately: that SDK is governed by ` +
      `Anthropic's own terms and is not shipped with Open Agent API. Install it with: ${install}. ` +
      `The gateway looks for it in ${where} (set OAA_CLAUDE_SDK_DIR to use another directory); ` +
      `restart the gateway after installing.`,
  );
  return { install, message: pick(text), text };
}

export function claudeSdkStatus(lookup: Lookup = {}): ClaudeSdkStatus {
  const specifier = lookup.specifier ?? CLAUDE_SDK_PACKAGE;
  const vendorDir = lookup.vendorDir ?? claudeSdkVendorDir();
  const found = locate(specifier, vendorDir);
  if (found) return { status: 'available', source: found.source };
  const { install, message } = installHint(specifier, vendorDir, lookup.npm);
  return { status: 'requires_separate_install', package: specifier, install, message };
}

export async function loadClaudeSdk(lookup: Lookup = {}): Promise<ClaudeSdk> {
  const specifier = lookup.specifier ?? CLAUDE_SDK_PACKAGE;
  const vendorDir = lookup.vendorDir ?? claudeSdkVendorDir();
  const found = locate(specifier, vendorDir);
  if (!found)
    throw new Fault('adapter_unavailable', installHint(specifier, vendorDir, lookup.npm).text, 503);
  if (found.url) return (await import(found.url)) as ClaudeSdk;
  if (specifier === CLAUDE_SDK_PACKAGE) return import('@anthropic-ai/claude-agent-sdk');
  return (await import(specifier)) as ClaudeSdk;
}
