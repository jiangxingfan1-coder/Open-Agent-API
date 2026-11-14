/** Sandbox types shared by process.ts and sandbox.ts (kept apart so the two do not import each other). */
export type SandboxBackend = 'srt';
export type SandboxPolicy = {
  /** The only writable directory (the run's session workspace). */
  workspace: string;
  /** Additional readable paths: the installed bundle, language runtimes. */
  readOnly: string[];
  /** Domains the process may reach through the proxy. Empty: no network at all. */
  allowedDomains: string[];
  /** CPU-time cap in seconds (`ulimit -t`). */
  cpuSeconds: number;
};
export type SandboxedCommand = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Must be called once the process has exited (or never started). */
  release: () => void;
};
export type SandboxReport = {
  backend: SandboxBackend;
  version: string;
  /** Execution kinds verified on this host by the startup self-check. */
  kinds: ('script' | `native/${string}`)[];
};
export interface SandboxLauncher {
  readonly backend: SandboxBackend;
  /** Self-check outcome; undefined until checked or when the check failed. */
  report(): SandboxReport | undefined;
  /** Wrap one command. Resolves only when this process may start (one at a time). */
  wrap(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<SandboxedCommand>;
  close(): Promise<void>;
}
