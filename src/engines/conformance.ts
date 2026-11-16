/**
 * The AgentAPI conversion contract: what a caller can rely on once an agent is published as an
 * OAA engine, per access method. These describe the integration path (each value is exercised
 * by test/conformance.test.ts with fixture agents), not a vendor's model quality. Profiles are
 * derived from static worker configuration only, so they are stable for the process lifetime
 * and safe to include in revisioned (ETag) projections; owner-requested handshakes may refine
 * them in the local backend catalog.
 */
import type { WorkerConfig } from '../config/config.js';
import { isNativeEngine, type NativeEngine } from '../config/agent-presets.js';

export type ConversionProfile = {
  /** How OAA reaches the agent. */
  access: 'kernel' | 'native' | 'acp' | 'oaa-adapter' | 'a2a' | 'unknown';
  /** Concrete wire protocol of that access path. */
  transport: string;
  /**
   * `basic`: final result, stable error codes, cancellation; `streaming`: plus incremental
   * text; `interactive`: plus mid-run approvals that reach the agent.
   */
  tier: 'basic' | 'streaming' | 'interactive';
  /** Granularity of text while running: token-level deltas, whole messages, or final only. */
  streaming: 'token' | 'message' | 'final';
  /**
   * Mid-run permission requests: `bridged` to OAA approvals (approve/deny reaches the agent),
   * `denied` (the agent's own permission prompts fail the run), `none` (the path has none).
   */
  approvals: 'bridged' | 'denied' | 'none';
  /**
   * `cooperative`: a protocol-level cancel is sent first, then the process is stopped;
   * `terminate`: the owned process group is stopped; `request-abort`: the HTTP request is
   * aborted (a remote agent may keep running).
   */
  cancel: 'cooperative' | 'terminate' | 'request-abort';
  /**
   * `native`: the agent's own session/context id is resumed; `agent-declared`: resumed only if
   * the agent declares session load/resume at handshake (`none` once a check shows it does
   * not); `adapter-state`: the adapter's opaque state is returned on the next turn; `none`:
   * a continuation is refused (`native_resume_unsupported`).
   */
  resume: 'native' | 'agent-declared' | 'adapter-state' | 'none';
  /** `tool`: tool/step activity is visible; `status`: coarse status only; `none`. */
  tool_events: 'tool' | 'status' | 'none';
  usage: 'reported' | 'agent-reported' | 'partial' | 'none';
  /** Files the agent writes under outputs/ are exported as artifacts. */
  artifacts: boolean;
  /** How a published model route reaches the agent. */
  model_selection: 'route' | 'declared' | 'agent-confirmed' | 'allowlist';
  /**
   * Tools declared by the caller in a compatibility request (docs/harness.md): `bridge` hands
   * them to the caller to execute; `managed` means the agent uses its own tools and the caller's
   * tools are not executed (`X-OAA-Client-Tools: ignored`).
   */
  client_tools: 'bridge' | 'managed';
  /**
   * Image input (docs/images.md): `route` (kernel; per model route, see `providers.*.imageInput`),
   * `native` (the engine's own image input), `agent-declared` (ACP `promptCapabilities.image`,
   * else workspace files), `workspace-file` (image files in the task workspace, named in the
   * input), `none` (images are refused).
   */
  image_input: 'route' | 'native' | 'agent-declared' | 'workspace-file' | 'none';
};

/**
 * The kernel bridges caller tools; ACP agents bridge them through the `oaa-caller` MCP relay
 * (session/new `mcpServers`). Other external agents stay `managed`.
 */
const BRIDGED_ACCESS = new Set(['kernel', 'acp']);

type Profile = Omit<ConversionProfile, 'tier' | 'client_tools'>;
const tierOf = (p: Profile): ConversionProfile['tier'] =>
  p.streaming === 'final' ? 'basic' : p.approvals === 'bridged' ? 'interactive' : 'streaming';
const complete = (p: Profile): ConversionProfile => ({
  ...p,
  tier: tierOf(p),
  client_tools: BRIDGED_ACCESS.has(p.access) ? 'bridge' : 'managed',
});

const NATIVE: Record<NativeEngine, ConversionProfile> = {
  codex: complete({
    access: 'native',
    transport: 'codex-app-server',
    streaming: 'token',
    approvals: 'bridged',
    cancel: 'terminate',
    resume: 'native',
    tool_events: 'tool',
    usage: 'agent-reported',
    artifacts: true,
    model_selection: 'agent-confirmed',
    image_input: 'native',
  }),
  claude: complete({
    access: 'native',
    transport: 'claude-agent-sdk',
    streaming: 'message',
    approvals: 'bridged',
    cancel: 'terminate',
    resume: 'native',
    tool_events: 'tool',
    usage: 'reported',
    artifacts: true,
    model_selection: 'declared',
    image_input: 'native',
  }),
  antigravity: complete({
    access: 'native',
    transport: 'antigravity-stream-json',
    streaming: 'token',
    approvals: 'denied',
    cancel: 'terminate',
    resume: 'native',
    tool_events: 'tool',
    usage: 'partial',
    artifacts: true,
    model_selection: 'agent-confirmed',
    image_input: 'workspace-file',
  }),
  dsh: complete({
    access: 'native',
    transport: 'dsh-headless',
    streaming: 'final',
    approvals: 'none',
    cancel: 'terminate',
    resume: 'none',
    tool_events: 'none',
    usage: 'none',
    artifacts: true,
    model_selection: 'allowlist',
    image_input: 'workspace-file',
  }),
};
const KERNEL = complete({
  access: 'kernel',
  transport: 'oaa-kernel',
  streaming: 'token',
  approvals: 'bridged',
  cancel: 'cooperative',
  resume: 'native',
  tool_events: 'tool',
  usage: 'reported',
  artifacts: true,
  model_selection: 'route',
  image_input: 'route',
});
const ACP = complete({
  access: 'acp',
  transport: 'acp-stdio',
  streaming: 'token',
  approvals: 'bridged',
  cancel: 'cooperative',
  resume: 'agent-declared',
  tool_events: 'tool',
  usage: 'agent-reported',
  artifacts: true,
  model_selection: 'agent-confirmed',
  image_input: 'agent-declared',
});
const UNKNOWN = complete({
  access: 'unknown',
  transport: 'unknown',
  streaming: 'final',
  approvals: 'none',
  cancel: 'request-abort',
  resume: 'none',
  tool_events: 'none',
  usage: 'none',
  artifacts: false,
  model_selection: 'declared',
  image_input: 'none',
});

/** Evidence from an owner-requested handshake (ACP initialize or A2A agent card). */
export type HandshakeEvidence = {
  load_session?: boolean;
  resume_session?: boolean;
  streaming?: boolean;
  /** ACP `promptCapabilities.image`. */
  image?: boolean;
};

/**
 * Profile for an engine as configured on `worker`. An `adapter/<name>` that is not configured
 * here (for example one advertised only by a remote node) is reported as `unknown`.
 */
export function conversionProfile(
  engine: string,
  worker?: WorkerConfig,
  evidence?: HandshakeEvidence,
): ConversionProfile {
  if (engine === 'kernel') return KERNEL;
  if (isNativeEngine(engine)) return NATIVE[engine];
  const adapter = engine.startsWith('adapter/')
    ? worker?.adapters[engine.slice('adapter/'.length)]
    : undefined;
  if (!adapter) return UNKNOWN;
  if (adapter.transport === 'acp') {
    if (!evidence) return ACP;
    return complete({
      ...ACP,
      resume: evidence.load_session || evidence.resume_session ? 'native' : 'none',
      image_input: evidence.image
        ? 'native'
        : adapter.imageFiles === false
          ? 'none'
          : 'workspace-file',
    });
  }
  if (adapter.transport === 'a2a')
    return complete({
      access: 'a2a',
      transport: 'a2a-jsonrpc',
      streaming: adapter.streaming === false ? 'final' : 'token',
      approvals: 'none',
      cancel: 'cooperative',
      resume: 'native',
      tool_events: 'status',
      usage: 'none',
      artifacts: false,
      model_selection: 'declared',
      image_input: 'none',
    });
  if (adapter.transport === 'http')
    return complete({
      access: 'oaa-adapter',
      transport: 'oaa/1-http',
      streaming: 'final',
      approvals: 'none',
      cancel: 'request-abort',
      resume: 'adapter-state',
      tool_events: 'none',
      usage: 'reported',
      artifacts: false,
      model_selection: 'declared',
      image_input: 'none',
    });
  const files = adapter.imageFiles === false ? 'none' : 'workspace-file';
  return adapter.protocol === 'oaa/1-stream'
    ? complete({
        access: 'oaa-adapter',
        transport: 'oaa/1-stream',
        streaming: 'token',
        approvals: 'bridged',
        cancel: 'cooperative',
        resume: 'adapter-state',
        tool_events: 'tool',
        usage: 'reported',
        artifacts: true,
        model_selection: 'declared',
        image_input: files,
      })
    : complete({
        access: 'oaa-adapter',
        transport: 'oaa/1',
        streaming: 'final',
        approvals: 'none',
        cancel: 'terminate',
        resume: 'adapter-state',
        tool_events: 'none',
        usage: 'reported',
        artifacts: true,
        model_selection: 'declared',
        image_input: files,
      });
}

/** New Antigravity policies deliberately use ACP; legacy publications retain their profile. */
export function agentConversionProfile(
  agent: { engine: string; access?: { approval: string } },
  worker?: WorkerConfig,
): ConversionProfile {
  return agent.engine === 'antigravity' && agent.access && agent.access.approval !== 'native'
    ? { ...ACP, transport: 'antigravity-acp' }
    : conversionProfile(agent.engine, worker);
}

/** Static profile for a preset that is not configured yet (native engines and ACP presets). */
export function presetProfile(kind: 'native' | 'acp', id: string): ConversionProfile {
  return kind === 'native' && isNativeEngine(id) ? NATIVE[id] : ACP;
}
