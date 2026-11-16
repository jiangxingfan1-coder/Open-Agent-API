import path from 'node:path';
import { AgentModelCatalogs } from './agent-models.js';
import { validateModelWork } from '../core/work-manifest.js';
import { executeNative, collectNativeArtifacts } from './native-executor.js';
import { ProjectWorkspaces } from './project-workspaces.js';
import { mkdir, readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { JsonSchemas } from '../core/schemas.js';
import { McpConnections, mcpConfigured, descriptorDigest, findMcpTool } from './mcp-connections.js';
import type { WorkerConfig } from '../config/config.js';
import { validateEndpoint } from '../config/config.js';
import {
  agentSchema,
  bindingSchema,
  type AgentBundle,
  type ArtifactPayload,
  type NodeAdvertisement,
  type ToolResult,
  type Work,
  type WorkEvent,
  type WorkResult,
  type WorkContext,
} from '../core/contracts.js';
import { installBundle, builtin } from '../lang/bundle.js';
import { createModelDriver, providerApiKey, type ModelDriver } from '../providers/models.js';
import { validateProviderState } from '../providers/provider-state.js';
import {
  SrtLauncher,
  permittedDomains,
  runtimeReadPaths,
  type SandboxLauncher,
  type SandboxNativeEngine,
} from '../engines/sandbox.js';
import type { NativeSandbox } from '../engines/native.js';
import type { AcpTimings } from '../engines/acp.js';
import * as img from './image-capabilities.js';
import { safeEmit, type Emit } from '../engines/shared.js';
import { adapterNamePattern } from '../config/agent-presets.js';
import { collectProcess } from '../engines/process.js';
import {
  boundedJson,
  canonical,
  checkAbort,
  Fault,
  readBounded,
  relativeName,
  sha,
  writePrivate,
  executableExists,
} from '../core/util.js';

export interface Executor {
  advertisement(): NodeAdvertisement;
  install(bundle: AgentBundle, signal?: AbortSignal): Promise<void>;
  execute(work: Work, signal: AbortSignal, emit: Emit): Promise<WorkResult>;
  close(): Promise<void>;
}
export type LocalHandler = (
  args: Record<string, unknown>,
  context: WorkContext,
  signal: AbortSignal,
) => Promise<ToolResult>;
/** Whether an adapter entry is enabled and locally usable (no process is started). */
export function adapterReady(
  name: string,
  a: WorkerConfig['adapters'][string],
  options: { fresh?: boolean } = {},
): boolean {
  if (!a.enabled || !adapterNamePattern.test(name)) return false;
  if (a.transport === 'stdio' || a.transport === 'acp') return executableExists(a.command, options);
  try {
    validateEndpoint(a.url);
    return !a.tokenEnv || !!process.env[a.tokenEnv];
  } catch {
    return false;
  }
}
export class WorkerRuntime implements Executor {
  readonly modelCatalogs: AgentModelCatalogs;
  readonly projects: ProjectWorkspaces;
  private reasoningRoots = new Map<string, string>();
  /** Protocol timing bounds for ACP agents; tests shorten them. */
  acpTimings: AcpTimings = {};
  private bundles = new Map<string, AgentBundle>();
  private installing = new Map<string, Promise<void>>();
  private drivers = new Map<string, ModelDriver>();
  private providedDrivers: Set<string>;
  private driverVersions = new Map<string, string>();
  private mcpConnections: McpConnections;
  private ajv = new JsonSchemas();
  private workspaces = new Map<string, { fingerprint: string; root: string }>();
  private workspaceInFlight = new Map<string, Promise<string>>();
  /** OS sandbox for `sandbox`-level scripts; advertised only after its self-check passes. */
  readonly sandbox?: SandboxLauncher;
  /** Settles when the sandbox self-check has finished (immediately without a sandbox). */
  readonly sandboxChecked: Promise<unknown>;
  constructor(
    readonly config: WorkerConfig,
    readonly handlers = new Map<string, LocalHandler>(),
    drivers = new Map<string, ModelDriver>(),
    options: { sandbox?: SandboxLauncher } = {},
  ) {
    this.modelCatalogs = new AgentModelCatalogs(config);
    this.projects = new ProjectWorkspaces(config.dataDir, config.owner);
    this.drivers = drivers;
    this.providedDrivers = new Set(drivers.keys());
    this.mcpConnections = new McpConnections(config);
    if (options.sandbox) {
      this.sandbox = options.sandbox;
      this.sandboxChecked = Promise.resolve();
    } else if (config.sandbox?.backend === 'srt') {
      const srt = new SrtLauncher({
        dataDir: config.dataDir,
        extraDeniedReads: config.sandbox.denyRead,
        ...(config.sandbox.parentProxy ? { parentProxy: config.sandbox.parentProxy } : {}),
      });
      this.sandbox = srt;
      // Probe only engines the owner both enabled and listed for sandboxing.
      const natives = Object.fromEntries(
        Object.keys(config.sandbox.native ?? {})
          .filter((engine) => config.native[engine as 'claude' | 'codex']?.enabled)
          .map((engine) => [engine, config.native[engine as 'claude' | 'codex']!.executable]),
      );
      this.sandboxChecked = srt.selfCheck(process.execPath, natives).catch(() => undefined);
    } else this.sandboxChecked = Promise.resolve();
  }
  advertisement(): NodeAdvertisement {
    const mcpReady = new Map(
      Object.keys(this.config.mcp).map((name) => [name, mcpConfigured(this.config, name)]),
    );
    const native = Object.entries(this.config.native).filter(
      ([, n]) => n?.enabled && executableExists(n.executable),
    );
    const adapters = Object.entries(this.config.adapters).filter(([name, a]) =>
      adapterReady(name, a),
    );
    return {
      nodeId: this.config.nodeId,
      providers: [
        ...new Set([
          ...Object.entries(this.config.providers)
            .filter(([, p]) => {
              try {
                validateEndpoint(p.baseUrl);
                return providerApiKey(p) !== undefined;
              } catch {
                return false;
              }
            })
            .map(([name]) => name),
          ...this.providedDrivers,
        ]),
      ],
      natives: [...native.map(([name]) => name), ...adapters.map(([name]) => `adapter/${name}`)],
      capabilities: this.config.tools
        .filter(
          (t) =>
            this.handlers.has(t.reference) ||
            t.handler.kind !== 'mcp' ||
            mcpReady.get(t.handler.server),
        )
        .map((t) => t.capability),
      warm: [...this.bundles.keys()].slice(-500),
      concurrency: this.config.concurrency,
      execution: {
        agentPolicyVersion: 1,
        toolFreeReasoning: [
          'kernel',
          ...native
            .filter(([name]) => name === 'antigravity' || name === 'claude')
            .map(([name]) => name),
        ],
        projectWorkspaces: this.projects.advertised(),
        projectEngines: [
          ...native.map(([name]) => name),
          ...adapters
            .filter(([, adapter]) => adapter.transport === 'stdio' || adapter.transport === 'acp')
            .map(([name]) => `adapter/${name}`),
        ],
        modelCatalogs: this.modelCatalogs.snapshot(),
        builtins: ['read_file', 'write_file', 'list_files', 'read_skill'],
        scripts: this.config.scripts.filter(
          (runtime) => runtime === 'node' || executableExists(runtime),
        ),
        toolSelection: true,
        // Caller-tool bridging (docs/harness.md): the kernel loop and ACP adapters (via MCP).
        clientTools: {
          native: [
            'kernel',
            ...native
              .filter(([name]) => this.modelCatalogs.snapshot()[name]?.clientTools === 'hybrid')
              .map(([name]) => name),
            ...adapters.filter(([, a]) => a.transport === 'acp').map(([n]) => `adapter/${n}`),
          ],
        },
        imageInput: img.imageInputAdvert(this.config, this.drivers),
        providerStateProviders: [
          ...new Set([
            ...Object.entries(this.config.providers)
              .filter(
                ([name, config]) =>
                  !this.providedDrivers.has(name) && config.kind !== 'openai-chat',
              )
              .map(([name]) => name),
            ...[...this.providedDrivers].filter(
              (name) => this.drivers.get(name)?.providerStateVersion === 1,
            ),
          ]),
        ],
        ...(this.sandbox?.report() ? { sandbox: this.sandbox.report()! } : {}),
        byokProviders: [
          ...new Set([
            ...Object.entries(this.config.providers)
              .filter(([, p]) => {
                if (!p.byok) return false;
                try {
                  validateEndpoint(p.baseUrl);
                  return true;
                } catch {
                  return false;
                }
              })
              .map(([name]) => name),
            ...[...this.providedDrivers].filter((name) => !!this.drivers.get(name)?.withApiKey),
          ]),
        ],
        nativeModels: this.modelCatalogs.claims([
          ...native.map(([name]) => name),
          ...adapters.map(([name]) => `adapter/${name}`),
        ]),
      },
    };
  }
  /**
   * The sandbox a native run must use, or undefined for host execution. A sandbox-level native
   * run is refused unless this worker verified a sandbox for the engine, the owner listed it, and
   * the caller's key is present. A caller key without sandbox isolation is never accepted for a
   * native agent (it would mix into the owner's own CLI configuration).
   */
  private nativeSandbox(work: Extract<Work, { kind: 'native' }>): NativeSandbox | undefined {
    if (work.isolation !== 'sandbox') {
      if (work.credential)
        throw new Fault(
          'byok_not_supported',
          'A caller key is accepted for a native agent only inside the OS sandbox.',
          400,
        );
      return undefined;
    }
    const engine = work.agent.engine as SandboxNativeEngine;
    const profile = this.config.sandbox?.native?.[engine];
    if (!this.sandbox?.report()?.kinds.includes(`native/${engine}`) || !profile)
      throw new Fault(
        'sandbox_unavailable',
        'This worker has no verified OS sandbox for this native agent.',
        503,
      );
    if (!work.credential)
      throw new Fault(
        'provider_key_required',
        "A sandboxed native agent runs only on the caller's own provider key.",
        400,
      );
    return {
      launcher: this.sandbox,
      apiKey: work.credential.apiKey,
      allowedDomains: profile.providerDomains,
      cpuSeconds: profile.cpuSeconds,
    };
  }
  /**
   * A fresh, uncached driver bound to a caller-supplied key. Only providers that explicitly opt in
   * (`byok: true`, or an injected driver offering `withApiKey`) accept one; the worker's own key is
   * never substituted.
   */
  private byokDriver(provider: string, apiKey: string): ModelDriver {
    if (this.providedDrivers.has(provider)) {
      const injected = this.drivers.get(provider);
      if (injected?.withApiKey) return injected.withApiKey(apiKey);
    } else {
      const cfg = this.config.providers[provider];
      if (cfg?.byok) return createModelDriver(cfg, apiKey, provider);
    }
    throw new Fault(
      'byok_not_supported',
      'This model provider does not accept caller-supplied keys on this node.',
      400,
    );
  }
  async install(raw: AgentBundle, signal?: AbortSignal): Promise<void> {
    if (signal) checkAbort(signal);
    if (this.bundles.has(raw.digest)) return;
    let pending = this.installing.get(raw.digest);
    if (!pending) {
      pending = (async () => {
        const bundle = await installBundle(path.join(this.config.dataDir, 'bundles'), raw);
        this.bundles.set(bundle.digest, bundle);
      })();
      this.installing.set(raw.digest, pending);
    }
    try {
      await pending;
      if (signal) checkAbort(signal);
    } finally {
      this.installing.delete(raw.digest);
    }
  }
  private async workspace(context: WorkContext): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(context.sessionId) || context.owner !== this.config.owner)
      throw new Fault('invalid_context', 'Worker ownership or session does not match.', 403);
    const selected = new Map(
      context.files.map((f) => [f.workspacePath ?? `inputs/${f.id}/${f.name}`, f]),
    );
    for (const file of selected.values()) {
      if (file.allowedNodes && !file.allowedNodes.includes(this.config.nodeId))
        throw new Fault('data_placement_denied', 'Input file cannot be sent to this node.', 403);
      if (
        !/^[a-zA-Z0-9_-]+$/.test(file.id) ||
        (file.workspacePath && !file.workspacePath.startsWith('outputs/'))
      )
        throw new Fault('invalid_file', 'Invalid workspace file reference.');
    }
    const sessionKey = `${context.owner}:${context.sessionId}`;
    const fingerprint = sha(
      [...selected.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, f]) => `${k}:${f.id}:${f.sha256}`)
        .join(';'),
    );
    const cached = this.workspaces.get(sessionKey);
    // A pruned workspace (oaa prune) is rebuilt instead of reused from the cache.
    if (cached && cached.fingerprint === fingerprint && existsSync(cached.root)) return cached.root;
    const inFlight = this.workspaceInFlight.get(sessionKey);
    if (inFlight) return inFlight;

    const task = (async () => {
      const root = path.join(
        this.config.dataDir,
        'sessions',
        sha(context.owner).slice(0, 16),
        context.sessionId,
      );
      await mkdir(root, { recursive: true, mode: 0o700 });
      for (const file of selected.values()) {
        const data = Buffer.from(file.content, 'base64');
        if (sha(data) !== file.sha256)
          throw new Fault('file_integrity', 'Input file digest mismatch.');
        const name = file.workspacePath
          ? relativeName(file.workspacePath)
          : `inputs/${file.id}/${relativeName(file.name)}`;
        try {
          await writePrivate(root, name, data, !file.workspacePath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
            sha(await readBounded(root, name)) !== file.sha256
          )
            throw error;
        }
      }
      this.workspaces.set(sessionKey, { fingerprint, root });
      if (this.workspaces.size > 256) {
        this.workspaces.delete(this.workspaces.keys().next().value!);
      }
      return root;
    })();

    this.workspaceInFlight.set(sessionKey, task);
    try {
      return await task;
    } finally {
      this.workspaceInFlight.delete(sessionKey);
    }
  }
  async execute(work: Work, signal: AbortSignal, emit: Emit): Promise<WorkResult> {
    checkAbort(signal);
    const bundle = this.bundles.get(work.context.digest);
    if (!bundle)
      throw new Fault('bundle_not_loaded', 'Required immutable bundle is not installed.', 409);
    const root = await this.workspace(work.context);
    if (work.kind === 'model' || work.kind === 'native') {
      const agent = validateModelWork(bundle, work, this.modelCatalogs.snapshot());
      if (work.kind === 'native') {
        let executionRoot = root;
        if (work.toolsDisabled) {
          executionRoot =
            this.reasoningRoots.get(work.context.sessionId) ??
            (await mkdtemp(path.join(os.tmpdir(), 'oaa-reasoning-')));
          this.reasoningRoots.set(work.context.sessionId, executionRoot);
        }
        const outputRoot = path.join(root, 'outputs');
        await mkdir(outputRoot, { recursive: true, mode: 0o700 });
        const project = !work.toolsDisabled && agent.access?.workspace === 'project';
        const lease = await this.projects.acquire(agent.id, executionRoot, project, signal);
        try {
          const identity = sha(lease.root);
          if (
            work.nativeState?.workspaceIdentity &&
            work.nativeState.workspaceIdentity !== identity
          )
            throw new Fault(
              'native_resume_unsupported',
              'The working directory changed. Use an explicit handoff instead of resuming the old native session.',
              409,
            );
          const result = await executeNative(
            work,
            agent,
            this.config,
            executionRoot,
            signal,
            emit,
            this.acpTimings,
            this.nativeSandbox(work),
            this.modelCatalogs.snapshot()[agent.engine]?.clientTools === 'hybrid',
            project ? lease.root : undefined,
          );
          return {
            ...result,
            ...(agent.access
              ? { nativeState: { ...result.nativeState, workspaceIdentity: identity } }
              : {}),
            artifacts: await collectNativeArtifacts(outputRoot),
          };
        } finally {
          lease.release();
        }
      }
      const callerKey = work.credential?.apiKey;
      let driver = callerKey === undefined ? this.drivers.get(agent.provider) : undefined;
      if (callerKey !== undefined) driver = this.byokDriver(agent.provider, callerKey);
      else if (!this.providedDrivers.has(agent.provider)) {
        const cfg = this.config.providers[agent.provider];
        if (!cfg)
          throw new Fault(
            'provider_unavailable',
            'Model provider is not configured on this node.',
            503,
          );
        const version = sha(canonical(cfg) + (providerApiKey(cfg) ?? ''));
        if (!driver || this.driverVersions.get(agent.provider) !== version) {
          driver = createModelDriver(cfg, undefined, agent.provider);
          this.drivers.set(agent.provider, driver);
          this.driverVersions.set(agent.provider, version);
        }
      }
      if (
        work.toolNames &&
        (new Set(work.toolNames).size !== work.toolNames.length ||
          work.toolNames.some((n) => !agent.tools.some((t) => t.name === n)))
      )
        throw new Fault(
          'tool_not_published',
          'Per-turn tool selection exceeds the published agent.',
          403,
        );
      // 调用方请求的输出上限只能调低已发布的上限（Work.maxOutputTokens）。
      const cap = Math.min(Number(work.maxOutputTokens ?? Infinity), agent.limits.maxOutputTokens);
      const maxOutputTokens = cap > 0 ? cap : agent.limits.maxOutputTokens;
      const effectiveAgent = { ...agent, limits: { ...agent.limits, maxOutputTokens } };
      if (work.toolBoundary === 'client') {
        effectiveAgent.allowGraph = false;
        effectiveAgent.workflows = [];
        effectiveAgent.delegates = [];
        effectiveAgent.skills = [];
      }
      if (work.toolNames)
        effectiveAgent.tools = agent.tools.filter((t) => work.toolNames!.includes(t.name));
      if (!driver)
        throw new Fault('provider_unavailable', 'Model provider is not configured.', 503);
      if (
        work.messages.some((message) => !!message.providerState) &&
        driver.providerStateVersion !== 1
      )
        throw new Fault(
          'provider_state_unsupported',
          'This driver cannot preserve native provider turn state.',
          503,
        );
      // A delta the gateway cannot accept (persistence, backpressure) ends this turn with that
      // error instead of becoming an unhandled rejection.
      // 工作区准备等 await 期间可能已被取消：不再把已中止的 signal 交给驱动（只听事件的驱动会永远等下去）。
      checkAbort(signal);
      const turn = new AbortController();
      const stop = () => turn.abort(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      let refused: Error | undefined;
      try {
        const messages = img.withImageData(work.messages, work.context.files);
        const result = await driver.call(effectiveAgent, messages, turn.signal, (delta) => {
          safeEmit(emit, { type: 'text', data: { delta } }, (error) => {
            refused ??=
              error instanceof Error ? error : new Fault('event_failed', String(error), 500);
            turn.abort(refused);
          });
        });
        if (refused) throw refused;
        if (result.providerState)
          result.providerState = validateProviderState(result.providerState, {
            text: result.text,
            calls: result.calls,
          });
        return result;
      } catch (caught) {
        const error = refused ?? caught;
        // Upstream errors must never echo a caller's key back into run state or logs.
        if (callerKey && error instanceof Error && error.message.includes(callerKey))
          error.message = error.message.split(callerKey).join('[redacted]');
        throw error;
      } finally {
        signal.removeEventListener('abort', stop);
      }
    }
    const binding = bindingSchema.parse(work.binding);
    if (!bundle.agent.tools.some((t) => canonical(t) === canonical(binding)))
      throw new Fault('tool_not_published', 'Tool was not published in this bundle.', 403);
    const validate = this.ajv.compile(binding.capability.inputSchema);
    if (!validate(work.arguments))
      throw new Fault('invalid_tool_arguments', this.ajv.errorsText(validate.errors));
    const cap = binding.capability;
    if (!cap.resultExport)
      throw new Fault(
        'result_export_denied',
        'This capability does not permit results to leave its executor.',
        403,
      );
    if (cap.placement === 'host-bound' && cap.nodeId !== this.config.nodeId)
      throw new Fault('capability_bound_elsewhere', 'Capability is bound to another host.', 403);
    const handler = binding.handler;
    let result: ToolResult;
    if (handler.kind === 'builtin') {
      const trusted = builtin(handler.name);
      if (
        cap.id !== trusted.capability.id ||
        cap.effect !== trusted.capability.effect ||
        cap.version !== '1'
      )
        throw new Fault(
          'manifest_mismatch',
          'Built-in tool identity and effects cannot be overridden.',
          403,
        );
      const name = String(work.arguments.path ?? '');
      if (handler.name === 'read_file')
        result = { value: { text: (await readBounded(root, name, 1_000_000)).toString('utf8') } };
      else if (handler.name === 'read_skill') {
        const file = bundle.files.find((f) => f.path === name);
        if (!file)
          throw new Fault(
            'skill_not_published',
            'This file is not in the capability package.',
            404,
          );
        const bytes = await readBounded(
          path.join(this.config.dataDir, 'bundles', bundle.digest),
          name,
          200_000,
        );
        if (sha(bytes) !== file.sha256)
          throw new Fault('bundle_integrity', 'Installed skill content has changed.');
        result = { value: { text: bytes.toString('utf8') } };
      } else if (handler.name === 'write_file') {
        const content = String(work.arguments.content);
        const bytes = Buffer.from(content);
        await writePrivate(root, `outputs/${relativeName(name)}`, bytes);
        result = {
          value: { path: `outputs/${name}`, bytes: bytes.length },
          artifacts: [{ name, content: bytes.toString('base64'), sha256: sha(bytes) }],
        };
      } else {
        const files: string[] = [];
        const walk = async (rel: string) => {
          for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
            if (files.length >= 1000) return;
            if (e.isDirectory()) await walk(path.posix.join(rel, e.name));
            else if (e.isFile()) files.push(path.posix.join(rel, e.name));
          }
        };
        await walk('');
        result = { value: { files } };
      }
    } else if (handler.kind === 'script') {
      if (!this.config.scripts.includes(handler.runtime))
        throw new Fault(
          'script_disabled',
          'This worker does not permit this portable script runtime.',
          403,
        );
      const file = bundle.files.find((f) => f.path === handler.path);
      if (!file) throw new Fault('missing_script', 'Published script missing.');
      const script = path.join(
        this.config.dataDir,
        'bundles',
        bundle.digest,
        relativeName(handler.path),
      );
      for (const asset of bundle.files)
        if (
          sha(
            await readBounded(path.join(this.config.dataDir, 'bundles', bundle.digest), asset.path),
          ) !== asset.sha256
        )
          throw new Fault('bundle_integrity', 'Installed script package content has changed.');
      // A sandbox-level caller's script runs only inside the verified OS sandbox, never on host.
      let sandboxed: Parameters<typeof collectProcess>[6];
      if (work.isolation === 'sandbox') {
        if (!this.sandbox?.report()?.kinds.includes('script'))
          throw new Fault(
            'sandbox_unavailable',
            'This worker has no verified OS sandbox for scripts.',
            503,
          );
        sandboxed = {
          launcher: this.sandbox,
          policy: {
            workspace: root,
            readOnly: [
              path.join(this.config.dataDir, 'bundles', bundle.digest),
              ...runtimeReadPaths(),
            ],
            allowedDomains: permittedDomains(
              cap.network?.allowedDomains ?? [],
              this.config.sandbox?.allowDomains ?? [],
            ),
            cpuSeconds: this.config.sandbox?.cpuSeconds ?? 60,
          },
        };
      }
      const stdout = await collectProcess(
        handler.runtime === 'node' ? process.execPath : 'python3',
        [script],
        root,
        JSON.stringify(work.arguments),
        signal,
        {
          PATH: process.env.PATH,
          LANG: 'en_US.UTF-8',
          OAA_WORKSPACE: root,
          ...(sandboxed ? { HOME: root } : {}),
        },
        sandboxed,
      );
      result = { value: JSON.parse(stdout) };
    } else {
      const configured = this.config.tools.find((t) => t.reference === handler.reference);
      if (!configured || canonical(configured.capability) !== canonical(cap))
        throw new Fault(
          'capability_mismatch',
          'Node tool metadata does not match the published binding.',
          403,
        );
      if (!cap.resultExport)
        throw new Fault(
          'result_export_denied',
          'Capability does not permit returning results to the gateway.',
          403,
        );
      const custom = this.handlers.get(handler.reference);
      if (custom) result = await custom(work.arguments, work.context, signal);
      else if (configured.handler.kind === 'read_directory')
        result = {
          value: {
            text: (
              await readBounded(configured.handler.root, String(work.arguments.path), 1_000_000)
            ).toString('utf8'),
          },
        };
      else if (configured.handler.kind === 'script') {
        const h = configured.handler;
        result = {
          value: JSON.parse(
            await collectProcess(
              h.executable,
              h.args,
              h.cwd,
              JSON.stringify(work.arguments),
              signal,
              { PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
            ),
          ),
        };
      } else {
        const h = configured.handler;
        result = await this.mcpConnections.use(h.server, work.context, signal, async (client) => {
          if (
            h.descriptorSha256 &&
            descriptorDigest(await findMcpTool(client, h.tool, signal)) !== h.descriptorSha256
          )
            throw new Fault(
              'mcp_tool_changed',
              'MCP tool metadata changed. Inspect and prepare a new capability version before executing it.',
              409,
            );
          checkAbort(signal);
          const answer = await client.callTool(
            { name: h.tool, arguments: work.arguments },
            undefined,
            { signal, timeout: cap.timeoutMs },
          );
          if (answer.isError)
            throw new Fault(
              'mcp_tool_failed',
              'MCP tool returned isError=true.',
              502,
              ['write', 'unknown'].includes(cap.effect),
            );
          return { value: answer.structuredContent ?? answer.content };
        });
      }
    }
    checkAbort(signal);
    boundedJson(result, 12 * 1024 * 1024);
    return result;
  }
  async close(): Promise<void> {
    await this.modelCatalogs.close();
    await this.projects.ready;
    for (const root of this.reasoningRoots.values())
      await rm(root, { recursive: true, force: true });
    this.reasoningRoots.clear();
    await this.mcpConnections.close();
    await this.sandbox?.close();
  }
}
