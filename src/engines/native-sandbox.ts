import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  cliLaunch,
  nativeSandboxProfiles,
  type SandboxLauncher,
  type SandboxNativeEngine,
  type SandboxPolicy,
} from './sandbox.js';

/** How a sandboxed native run is started (docs/sandbox-design.md §4.1). */
export type NativeSandbox = {
  launcher: SandboxLauncher;
  /** The caller's provider key, injected as the engine's key variable inside the sandbox. */
  apiKey: string;
  allowedDomains: string[];
  cpuSeconds: number;
  subject?: string;
};

async function isolatedHomeEnv(
  cwd: string,
  homeVar: string,
  homeDir: string,
  xdg = false,
): Promise<Record<string, string>> {
  const home = path.join(cwd, '.oaa-home');
  const state = path.join(home, homeDir);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: home,
    [homeVar]: state,
  };
  if (xdg) {
    const configDir = path.join(home, '.config');
    const cacheDir = path.join(home, '.cache');
    const stateDir = path.join(home, '.local', 'state');
    const dataDir = path.join(home, '.local', 'share');
    for (const dir of [configDir, cacheDir, stateDir, dataDir])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    env.XDG_CONFIG_HOME = configDir;
    env.XDG_CACHE_HOME = cacheDir;
    env.XDG_STATE_HOME = stateDir;
    env.XDG_DATA_HOME = dataDir;
  }
  return env;
}

/**
 * Isolated launch plan for one sandboxed native run: HOME and the CLI's state directory live in
 * the session workspace (`.oaa-home`, so a session can be continued), only the CLI install is
 * readable besides the workspace, and the environment holds nothing but basics and the caller key.
 */
export async function sandboxPlan(
  engine: SandboxNativeEngine,
  executable: string,
  cwd: string,
  box: NativeSandbox,
  args: readonly string[] = [],
) {
  const profile = nativeSandboxProfiles[engine];
  const env = await isolatedHomeEnv(cwd, profile.homeVar, profile.homeDir, profile.xdg);
  if (profile.keyVar) env[profile.keyVar] = box.apiKey;
  const launch = await cliLaunch(executable, args);
  const policy: SandboxPolicy = {
    workspace: cwd,
    readOnly: launch.readOnly,
    allowedDomains: box.allowedDomains,
    cpuSeconds: box.cpuSeconds,
    ...(box.subject ? { subject: box.subject } : {}),
  };
  return { launch, env, policy, profile };
}

/**
 * Isolated launch plan for a generic stdio ACP/OAA adapter: resolves symlinks and script arguments
 * into bounded read-only directories and builds an isolated `.oaa-home` + XDG environment.
 */
export async function acpSandboxPlan(
  command: string,
  args: readonly string[],
  cwd: string,
  box: {
    launcher: SandboxLauncher;
    allowedDomains: string[];
    cpuSeconds: number;
    apiKey?: string;
    keyVar?: string;
    subject?: string;
  },
) {
  const profile = nativeSandboxProfiles.acp;
  const env = await isolatedHomeEnv(cwd, profile.homeVar, profile.homeDir, true);
  if (box.keyVar && box.apiKey) env[box.keyVar] = box.apiKey;
  const launch = await cliLaunch(command, args);
  const policy: SandboxPolicy = {
    workspace: cwd,
    readOnly: launch.readOnly,
    allowedDomains: box.allowedDomains,
    cpuSeconds: box.cpuSeconds,
    ...(box.subject ? { subject: box.subject } : {}),
  };
  return { launch, env, policy, profile };
}
