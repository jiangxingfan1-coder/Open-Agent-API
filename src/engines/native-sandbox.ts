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
};
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
) {
  const profile = nativeSandboxProfiles[engine];
  const home = path.join(cwd, '.oaa-home');
  const state = path.join(home, profile.homeDir);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const launch = await cliLaunch(executable);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: home,
    [profile.homeVar]: state,
    [profile.keyVar]: box.apiKey,
  };
  const policy: SandboxPolicy = {
    workspace: cwd,
    readOnly: launch.readOnly,
    allowedDomains: box.allowedDomains,
    cpuSeconds: box.cpuSeconds,
  };
  return { launch, env, policy, profile };
}
