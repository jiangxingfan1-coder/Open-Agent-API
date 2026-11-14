/**
 * Minimal Agent Client Protocol (ACP v1) client for owner-enabled stdio agents.
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio. This client implements only what the OAA
 * worker needs: initialize → session/new (or session/resume / session/load) → optional model
 * selection → session/prompt, streaming `agent_message_chunk` text into durable output, bridging
 * `session/request_permission` to the owner approval flow, and session/cancel on abort.
 * It advertises no client file-system or terminal capabilities. It injects no MCP servers unless
 * the caller's tools are bridged (docs/harness.md): then the session gets one stdio MCP server,
 * `oaa-caller` (see caller-relay.ts). It never authenticates on the agent's behalf. Field names follow the published ACP schema (protocol version 1).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition, ClientTool, Usage, WorkEvent } from '../core/contracts.js';
import type { WorkerConfig } from '../config/config.js';
import type { NativeResult } from './native.js';
import { nativeEnvironment, ownedProcess, terminateOwned } from './process.js';
import { pick, type LocalText } from '../core/locale.js';
import { Fault, checkAbort, redact } from '../core/util.js';
import { ACP_TEXT } from './acp-text.js';
import { AGENT_IO_LIMITS, bounded, record, safeEmit, type Emit } from './shared.js';
import { callerToolPermission, openCallerRelay, type CallerRelay } from './caller-relay.js';
import { PRODUCT_VERSION } from '../core/version.js';

export const ACP_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = AGENT_IO_LIMITS.frameBytes;
const MAX_TEXT = AGENT_IO_LIMITS.textChars;
/** Same order of magnitude as other native approvals, which carry full tool arguments. */
const MAX_APPROVAL_DETAIL = AGENT_IO_LIMITS.approvalDetailChars;

type Json = Record<string, unknown>;
export type AcpTimings = {
  /** Bound for initialize, session creation/restoration and model selection. */
  handshakeTimeoutMs?: number;
  /** How long to wait for the agent to acknowledge session/cancel before terminating it. */
  cancelGraceMs?: number;
  /** How long to wait for a voluntary exit after stdin closes before terminating it. */
  exitGraceMs?: number;
};
export type AcpProbe = {
  status: 'passed';
  protocol_version: number;
  agent: { name: string; version: string | null } | null;
  load_session: boolean;
  resume_session: boolean;
  auth_methods: string[];
  prompt_capabilities: { image: boolean; audio: boolean; embedded_context: boolean };
  model_called: false;
};

const protocolFault = (message: LocalText) => new Fault('native_protocol_error', message, 502);

class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rpcFault(error: AcpRpcError): Fault {
  if (error.code === -32000) return new Fault('adapter_auth_required', ACP_TEXT.authRequired, 503);
  return protocolFault(
    ACP_TEXT.rejected(error.method, error.code, redact(error.message).slice(0, 500)),
  );
}

const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });

function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Fault('adapter_timeout', ACP_TEXT.timeout(label, ms), 504)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function initializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'open-agent-api', title: 'Open Agent API', version: PRODUCT_VERSION },
  };
}

type PeerHandlers = {
  request: (method: string, params: Json) => Promise<unknown>;
  notification: (method: string, params: Json) => void;
};

/** JSON-RPC 2.0 peer over NDJSON stdio. Owns protocol framing and the child's lifetime. */
class AcpPeer {
  private seq = 0;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private stderrTail = '';
  private closing = false;
  private exited = false;
  private rejectFailed!: (error: Error) => void;
  failure: Error | undefined;
  readonly failed: Promise<never>;
  readonly closed: Promise<void>;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: PeerHandlers,
  ) {
    this.failed = new Promise<never>((_resolve, reject) => {
      this.rejectFailed = reject;
    });
    this.failed.catch(() => {});
    this.closed = new Promise<void>((resolve) => {
      // A spawn failure may emit 'error' without a later 'close'.
      child.once('error', () => {
        if (child.pid === undefined) {
          this.exited = true;
          resolve();
        }
      });
      child.once('close', (code, signal) => {
        this.exited = true;
        if (!this.closing) {
          const detail = this.stderr();
          this.fail(
            new Fault(
              'native_incomplete',
              ACP_TEXT.exited(String(signal ?? code ?? 'unknown'), detail),
              502,
            ),
          );
        }
        for (const p of this.pending.values())
          p.reject(new Fault('native_closed', ACP_TEXT.closed, 502));
        this.pending.clear();
        resolve();
      });
    });
    child.once('error', (error) =>
      this.fail(
        new Fault(
          'adapter_unavailable',
          ACP_TEXT.spawnFailed(redact(error.message).slice(0, 300)),
          503,
        ),
      ),
    );
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    child.stdout.on('end', () => {
      if (this.bufferedBytes && !this.closing) this.fail(protocolFault(ACP_TEXT.partialLine));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-16_384);
    });
  }
  stderr(): string {
    return redact(this.stderrTail.trim()).slice(-1000);
  }
  private read(chunk: Buffer): void {
    let start = 0;
    while (!this.failure) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (end > start) {
        this.bufferedBytes += end - start;
        if (this.bufferedBytes > MAX_FRAME_BYTES) {
          this.fail(protocolFault(ACP_TEXT.frameTooLarge));
          return;
        }
        this.buffered.push(chunk.subarray(start, end));
      }
      if (newline === -1) return;
      const line = Buffer.concat(this.buffered).toString('utf8').trim();
      this.buffered = [];
      this.bufferedBytes = 0;
      start = newline + 1;
      if (line) this.dispatch(line);
    }
  }
  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(protocolFault(ACP_TEXT.notJson));
      return;
    }
    const message = record(parsed);
    if (message.jsonrpc !== '2.0') {
      this.fail(protocolFault(ACP_TEXT.notJsonRpc));
      return;
    }
    const id = message.id;
    const validId = typeof id === 'number' || typeof id === 'string';
    if (typeof message.method === 'string') {
      const method = message.method;
      const params = record(message.params);
      if (validId) {
        void this.handlers.request(method, params).then(
          (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
          (error: unknown) =>
            this.write({
              jsonrpc: '2.0',
              id,
              error:
                error instanceof AcpRpcError
                  ? { code: error.code, message: error.message }
                  : { code: -32603, message: 'Internal error' },
            }),
        );
        return;
      }
      if (id !== undefined) {
        this.fail(protocolFault(ACP_TEXT.badId));
        return;
      }
      try {
        this.handlers.notification(method, params);
      } catch (error) {
        this.fail(error instanceof Error ? error : protocolFault(ACP_TEXT.notificationFailed));
      }
      return;
    }
    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error && typeof message.error === 'object') {
        const error = record(message.error);
        pending.reject(
          new AcpRpcError(
            pending.method,
            typeof error.code === 'number' ? error.code : -32603,
            typeof error.message === 'string' ? error.message : 'Unknown error',
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if (id === null && message.error) {
      this.fail(protocolFault(ACP_TEXT.unparsable));
      return;
    }
    if (validId) return;
    this.fail(protocolFault(ACP_TEXT.unrecognized));
  }
  private write(value: Json): void {
    if (this.exited || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(value) + '\n');
    } catch {
      // The child may close stdin at any moment; the exit handler reports it.
    }
  }
  request(method: string, params: Json): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  /** Race a request against process/protocol failure. */
  call(method: string, params: Json): Promise<unknown> {
    return Promise.race([this.request(method, params), this.failed]);
  }
  notify(method: string, params: Json): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.rejectFailed(error);
  }
  /** Close stdin, wait for a voluntary exit, then terminate the owned process group. */
  async shutdown(graceMs: number): Promise<void> {
    this.closing = true;
    if (!this.exited)
      try {
        this.child.stdin.end();
      } catch {
        // Stdin is already closed or broken; shutdown continues.
      }
    if (await settlesWithin(this.closed, graceMs)) return;
    terminateOwned(this.child);
    await settlesWithin(this.closed, 4_000);
  }
}

function usageOf(raw: unknown): Usage | null {
  const u = record(raw);
  const valid = ['inputTokens', 'outputTokens', 'totalTokens'].every(
    (key) => typeof u[key] === 'number' && Number.isSafeInteger(u[key]) && Number(u[key]) >= 0,
  );
  // 全为 0 的上报（如 Qoder）不是真实用量：按未知处理，而不是记成用了 0 个 token。
  const zero = valid && u.inputTokens === 0 && u.outputTokens === 0 && u.totalTokens === 0;
  return valid && !zero
    ? {
        input_tokens: Number(u.inputTokens),
        output_tokens: Number(u.outputTokens),
        total_tokens: Number(u.totalTokens),
      }
    : null;
}

function selectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((item) => {
    const entry = record(item);
    if (Array.isArray(entry.options)) return selectValues(entry.options);
    return typeof entry.value === 'string' ? [entry.value] : [];
  });
}

function resumeCapability(capabilities: Json): boolean {
  const resume = record(capabilities.sessionCapabilities).resume;
  return !!resume && typeof resume === 'object' && !Array.isArray(resume);
}

/**
 * Execute one OAA turn against an owner-enabled ACP agent. The agent process is owned by this
 * call: it is started in the task workspace and stopped when the turn ends.
 */
export async function runAcp(
  agent: AgentDefinition,
  config: WorkerConfig,
  workspace: string,
  input: string,
  signal: AbortSignal,
  emit: Emit,
  state?: Record<string, unknown>,
  timings: AcpTimings = {},
  clientTools?: ClientTool[],
): Promise<NativeResult> {
  const name = agent.engine.startsWith('adapter/') ? agent.engine.slice('adapter/'.length) : '';
  const adapter = config.adapters[name];
  if (!adapter?.enabled)
    throw new Fault('adapter_disabled', 'The named owner-installed adapter is not enabled.', 503);
  if (adapter.transport !== 'acp')
    throw new Fault('invalid_engine', 'This adapter does not use the ACP transport.');
  checkAbort(signal);
  const resumeId =
    typeof state?.sessionId === 'string' && state.sessionId ? state.sessionId : undefined;
  if (resumeId && typeof state?.adapter === 'string' && state.adapter !== name)
    throw new Fault('native_resume_unsupported', ACP_TEXT.otherAdapter, 409);
  const handshakeMs = timings.handshakeTimeoutMs ?? 60_000;
  const cancelGraceMs = timings.cancelGraceMs ?? 3_000;
  const exitGraceMs = timings.exitGraceMs ?? 2_000;
  const cwd = path.resolve(workspace);
  const prompt = agent.instructions ? `${agent.instructions}\n\n${input}` : input;

  let phase: 'starting' | 'session' | 'prompting' | 'finished' = 'starting';
  let sessionId: string | undefined;
  let text = '';
  let denied = 0;
  let thinking = false;
  let contextUsage: { used: number; size: number } | undefined;
  let observedCost: { amount: number; currency: string } | undefined;
  const toolStatus = new Map<string, string>();
  const skippedContent = new Set<string>();
  const life = new AbortController();
  const child = ownedProcess(
    adapter.command,
    adapter.args,
    cwd,
    life.signal,
    nativeEnvironment(config.nativeEnv),
  );
  let peer!: AcpPeer;
  const report = (event: WorkEvent) => {
    safeEmit(emit, event, (error) =>
      peer.fail(error instanceof Error ? error : new Fault('event_failed', String(error), 500)),
    );
  };
  const progress = (data: Json) =>
    report({ type: 'progress', data: { native: 'acp', adapter: name, ...data } });

  const permission = async (params: Json): Promise<unknown> => {
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (phase !== 'prompting' || params.sessionId !== sessionId || signal.aborted) return cancelled;
    const options = (Array.isArray(params.options) ? params.options : []).map(record);
    const ids = options.map((option) => option.optionId);
    const allow = options.find((o) => o.kind === 'allow_once' && typeof o.optionId === 'string');
    const reject = options.find((o) => o.kind === 'reject_once' && typeof o.optionId === 'string');
    const refuse = (reason: string) => {
      denied++;
      progress({ event: 'permission_denied', reason });
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled;
    };
    // Only one-shot choices are offered: an owner approval never becomes a standing grant.
    if (!allow || options.length > 16 || new Set(ids).size !== ids.length)
      return refuse('no_allow_once_option');
    const call = record(params.toolCall);
    // 桥接回合里中继提供的工具由调用方执行：直接允许一次，不再请 owner 审批（docs/harness.md）。
    const callerTool = callerToolPermission(call, clientTools?.map((t) => t.name) ?? []);
    if (callerTool !== null) {
      progress({ event: 'permission_auto_allowed', tool: callerTool });
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    const locations = (Array.isArray(call.locations) ? call.locations : [])
      .slice(0, 20)
      .map((item) => bounded(record(item).path, 1024))
      .filter((item): item is string => item !== null);
    const detail = {
      native: 'acp',
      adapter: name,
      ...(adapter.preset ? { preset: adapter.preset } : {}),
      tool_call_id: bounded(call.toolCallId, 160),
      title: bounded(call.title, 240) ?? pick(ACP_TEXT.approvalTitle),
      kind: bounded(call.kind, 40),
      input: call.rawInput ?? null,
      locations,
      options: options
        .filter((o) => o.kind === 'allow_once' || o.kind === 'reject_once')
        .map((o) => ({ kind: o.kind, name: bounded(o.name, 160) })),
    };
    // Never obtain an approval for content the owner cannot see in full.
    if (JSON.stringify(detail).length > MAX_APPROVAL_DETAIL) return refuse('detail_too_large');
    let answer: Record<string, unknown> | void;
    try {
      answer = await emit({ type: 'approval', data: detail });
    } catch (error) {
      denied++;
      if (!signal.aborted)
        peer.fail(
          error instanceof Error ? error : new Fault('approval_failed', String(error), 500),
        );
      return cancelled;
    }
    if (phase !== 'prompting' || signal.aborted) return cancelled;
    if (answer?.decision === 'approve')
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    return refuse('owner_denied');
  };

  peer = new AcpPeer(child, {
    request: async (method, params) => {
      if (method === 'session/request_permission') return await permission(params);
      throw new AcpRpcError(
        method,
        -32601,
        `Open Agent API does not provide ${method.slice(0, 80)}.`,
      );
    },
    notification: (method, params) => {
      // Replayed history (session/load) and pre-prompt chatter are not part of this turn's output.
      if (method !== 'session/update' || phase !== 'prompting') return;
      if (params.sessionId !== sessionId) throw protocolFault(ACP_TEXT.foreignUpdate);
      const update = record(params.update);
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const content = record(update.content);
        if (content.type === 'text' && typeof content.text === 'string') {
          if (text.length + content.text.length > MAX_TEXT)
            throw new Fault('output_too_large', 'Agent output exceeds limit.', 413);
          text += content.text;
          thinking = false;
          if (content.text) report({ type: 'text', data: { delta: content.text } });
        } else {
          // Non-text output (images, audio, resources) is not persisted; report each type once.
          const type = bounded(content.type, 40) ?? 'unknown';
          if (!skippedContent.has(type) && skippedContent.size < 16) {
            skippedContent.add(type);
            progress({ event: 'content_skipped', content_type: type });
          }
        }
      } else if (kind === 'agent_thought_chunk') {
        if (!thinking) progress({ event: 'thinking' });
        thinking = true;
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = bounded(update.toolCallId, 160) ?? '';
        const status =
          typeof update.status === 'string' ? update.status : (toolStatus.get(id) ?? 'pending');
        thinking = false;
        if (kind === 'tool_call' || toolStatus.get(id) !== status) {
          toolStatus.set(id, status);
          if (toolStatus.size > 4096) toolStatus.delete(toolStatus.keys().next().value!);
          progress({
            event: 'tool',
            tool_call_id: id,
            title: bounded(update.title, 240),
            kind: bounded(update.kind, 40),
            status: status.slice(0, 40),
          });
        }
      } else if (kind === 'plan') {
        progress({
          event: 'plan',
          entries: Array.isArray(update.entries) ? update.entries.length : 0,
        });
      } else if (kind === 'usage_update') {
        const used = update.used;
        const size = update.size;
        if (Number.isSafeInteger(used) && Number.isSafeInteger(size))
          contextUsage = { used: Number(used), size: Number(size) };
        const cost = record(update.cost);
        if (
          typeof cost.amount === 'number' &&
          Number.isFinite(cost.amount) &&
          cost.amount >= 0 &&
          typeof cost.currency === 'string'
        )
          observedCost = { amount: cost.amount, currency: cost.currency.slice(0, 8) };
      }
    },
  });

  let promptSettled: Promise<unknown> | undefined;
  let cancelling: Promise<void> | undefined;
  let rejectCancelled!: (error: Error) => void;
  const cancelledRun = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  cancelledRun.catch(() => {});
  const onAbort = () => {
    cancelling ??= (async () => {
      if (phase === 'prompting' && sessionId && !peer.failure) {
        peer.notify('session/cancel', { sessionId });
        if (promptSettled) await settlesWithin(promptSettled, cancelGraceMs);
      }
      rejectCancelled(new Fault('cancelled', ACP_TEXT.cancelled, 409));
      await peer.shutdown(Math.min(exitGraceMs, 1_000));
    })();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const step = <T>(promise: Promise<T>, label: string) =>
    deadline(Promise.race([promise, cancelledRun]), handshakeMs, label);
  let relay: CallerRelay | undefined;
  try {
    if (signal.aborted) onAbort();
    // Bridged caller tools: one stdio MCP server per turn. Without them the wire stays `[]`.
    if (clientTools?.length) relay = await openCallerRelay(cwd, clientTools, emit);
    const mcpServers = relay ? [relay.server] : [];
    const init = record(await step(peer.call('initialize', initializeParams()), 'initialize'));
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw protocolFault(
        ACP_TEXT.badVersion(String(init.protocolVersion).slice(0, 20), ACP_PROTOCOL_VERSION),
      );
    const capabilities = record(init.agentCapabilities);
    const info = record(init.agentInfo);
    const loadSession = capabilities.loadSession === true;
    const resumeSession = resumeCapability(capabilities);
    progress({
      event: 'initialized',
      agent: bounded(info.name, 120),
      version: bounded(info.version, 80),
      load_session: loadSession,
      resume_session: resumeSession,
    });
    let session: Json;
    phase = 'session';
    if (resumeId) {
      const method = resumeSession ? 'session/resume' : loadSession ? 'session/load' : undefined;
      if (!method) throw new Fault('native_resume_unsupported', ACP_TEXT.noResume, 409);
      session = record(
        await step(peer.call(method, { sessionId: resumeId, cwd, mcpServers }), method),
      );
      sessionId = resumeId;
    } else {
      session = record(await step(peer.call('session/new', { cwd, mcpServers }), 'session/new'));
      if (
        typeof session.sessionId !== 'string' ||
        !session.sessionId ||
        session.sessionId.length > 512
      )
        throw protocolFault(ACP_TEXT.noSessionId);
      sessionId = session.sessionId;
    }
    if (agent.model !== 'default') {
      const requested = agent.model;
      const options = (Array.isArray(session.configOptions) ? session.configOptions : []).map(
        record,
      );
      const option = options.find(
        (o) => o.category === 'model' && o.type === 'select' && typeof o.id === 'string',
      );
      const legacy = record(session.models);
      const legacyModels = (Array.isArray(legacy.availableModels) ? legacy.availableModels : [])
        .map((m) => record(m).modelId)
        .filter((m): m is string => typeof m === 'string');
      if (option && selectValues(option.options).includes(requested)) {
        if (option.currentValue !== requested) {
          const changed = record(
            await step(
              peer.call('session/set_config_option', {
                sessionId,
                configId: option.id,
                value: requested,
              }),
              'session/set_config_option',
            ),
          );
          const confirmed = (Array.isArray(changed.configOptions) ? changed.configOptions : [])
            .map(record)
            .find((o) => o.id === option.id);
          if (confirmed?.currentValue !== requested)
            throw new Fault('native_model_mismatch', ACP_TEXT.modelUnconfirmed, 409);
        }
      } else if (!option && legacyModels.includes(requested)) {
        if (legacy.currentModelId !== requested)
          await step(
            peer.call('session/set_model', { sessionId, modelId: requested }),
            'session/set_model',
          );
      } else if (!(resumeId && !option && !legacyModels.length && state?.model === requested))
        // A restored session that reports no model configuration keeps the model this platform
        // confirmed for it on an earlier turn; anything else cannot be confirmed.
        throw new Fault(
          'model_not_supported',
          ACP_TEXT.modelNotOffered(requested.slice(0, 120)),
          400,
        );
    }
    checkAbort(signal);
    phase = 'prompting';
    const promptRequest = peer.call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
    promptSettled = promptRequest;
    const response = record(await Promise.race([promptRequest, cancelledRun]));
    phase = 'finished';
    const stopReason = response.stopReason;
    if (stopReason === 'cancelled' || signal.aborted)
      throw signal.aborted
        ? new Fault('cancelled', ACP_TEXT.cancelled, 409)
        : new Fault('native_incomplete', ACP_TEXT.unrequestedCancel, 502);
    if (stopReason !== 'end_turn')
      throw new Fault('native_incomplete', ACP_TEXT.stopped(String(stopReason).slice(0, 60)), 502);
    if (denied) throw new Fault('permission_denied', ACP_TEXT.denied(denied), 403);
    const usage = usageOf(response.usage);
    return {
      text,
      nativeState: {
        transport: 'acp',
        adapter: name,
        ...(adapter.preset ? { preset: adapter.preset } : {}),
        sessionId,
        model: agent.model,
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentName: bounded(info.name, 120),
        agentVersion: bounded(info.version, 80),
        resumable: resumeSession || loadSession,
        ...(contextUsage ? { contextUsage } : {}),
        ...(observedCost ? { observedCost } : {}),
        usageScope: usage ? 'agent_reported_turn' : 'unreported',
      },
      usage,
    };
  } catch (error) {
    if (signal.aborted) throw new Fault('cancelled', ACP_TEXT.cancelled, 409);
    if (error instanceof AcpRpcError) throw rpcFault(error);
    throw error;
  } finally {
    phase = 'finished';
    signal.removeEventListener('abort', onAbort);
    await (cancelling ?? peer.shutdown(exitGraceMs));
    life.abort();
    await relay?.close();
  }
}

/**
 * Explicit owner-requested handshake check: initialize only, in an empty temporary directory.
 * No session is created and no prompt is sent, so no model is called.
 */
export async function probeAcp(
  command: string,
  args: string[],
  timeoutMs = 20_000,
  env?: NodeJS.ProcessEnv,
): Promise<AcpProbe> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-acp-check-'));
  const life = new AbortController();
  let peer: AcpPeer | undefined;
  try {
    peer = new AcpPeer(ownedProcess(command, args, dir, life.signal, env), {
      request: async (method) => {
        throw new AcpRpcError(method, -32601, 'Not available during a handshake check.');
      },
      notification: () => {},
    });
    const init = record(
      await deadline(peer.call('initialize', initializeParams()), timeoutMs, 'initialize'),
    );
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw protocolFault(ACP_TEXT.badVersion(String(init.protocolVersion).slice(0, 20)));
    const capabilities = record(init.agentCapabilities);
    const info = record(init.agentInfo);
    const prompt = record(capabilities.promptCapabilities);
    return {
      status: 'passed',
      protocol_version: ACP_PROTOCOL_VERSION,
      agent:
        typeof info.name === 'string'
          ? { name: info.name.slice(0, 120), version: bounded(info.version, 80) }
          : null,
      load_session: capabilities.loadSession === true,
      resume_session: resumeCapability(capabilities),
      auth_methods: (Array.isArray(init.authMethods) ? init.authMethods : [])
        .map((method) => bounded(record(method).id, 160))
        .filter((method): method is string => !!method)
        .slice(0, 16),
      prompt_capabilities: {
        image: prompt.image === true,
        audio: prompt.audio === true,
        embedded_context: prompt.embeddedContext === true,
      },
      model_called: false,
    };
  } catch (error) {
    if (error instanceof AcpRpcError) throw rpcFault(error);
    throw error;
  } finally {
    await peer?.shutdown(1_000);
    life.abort();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
