import type { AgentDefinition, ClientTool, Usage, WorkEvent } from '../core/contracts.js';
import type { SandboxLauncher } from './sandbox.js';
import { sandboxPlan } from './native-sandbox.js';
import { codexInput } from './image-blocks.js';
import { ownedProcess, spawnSandboxed, jsonLines, terminateOwned } from './process.js';
import { checkAbort, Fault, redact } from '../core/util.js';
import { record, type Emit, type NativeResult } from './shared.js';
import { CODEX_TOOL_ITEMS } from './native-signals.js';
import { REASONING_ONLY } from './reasoning-policy.js';
import {
  codexCallerArgs,
  codexCallerTool,
  codexDecisionPayload,
  codexReasoningArgs,
  type AcpStdioMcpServer,
} from './native-bridge.js';
import { PRODUCT_VERSION } from '../core/version.js';

export type CodexTurnOptions = {
  clientTools?: ClientTool[];
  relay?: AcpStdioMcpServer;
  toolsDisabled?: boolean;
  interruptGraceMs?: number;
};

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/mcpToolCall/requestApproval',
  'mcpServer/requestApproval',
  'item/tool/requestApproval',
  'item/tool/requestUserInput',
  'tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

const THREAD_SCOPED_METHODS = new Set([
  'mcpServer/elicitation/request',
  'item/mcpToolCall/requestApproval',
  'mcpServer/requestApproval',
]);

export async function codex(
  command: string,
  args: string[],
  agent: AgentDefinition,
  cwd: string,
  input: ReturnType<typeof codexInput>,
  signal: AbortSignal,
  emit: Emit,
  state: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
  sandboxed?: {
    launcher: SandboxLauncher;
    plan: Awaited<ReturnType<typeof sandboxPlan>>;
  },
  options?: CodexTurnOptions,
): Promise<NativeResult> {
  checkAbort(signal);
  const toolsDisabled = options?.toolsDisabled === true;
  const extraArgs = toolsDisabled
    ? codexReasoningArgs(Boolean(sandboxed))
    : options?.relay
      ? codexCallerArgs(options.relay)
      : [];
  const serverArgs = [...args, ...extraArgs, 'app-server', '--listen', 'stdio://'];
  const life = new AbortController();
  const child = sandboxed
    ? await spawnSandboxed(
        sandboxed.plan.launch.command,
        // Engine flags go after the configured args (which may hold a script path) and before
        // the subcommand, so `node <script> -c …` never reads them as node's own flags.
        [
          ...sandboxed.plan.launch.prefix,
          ...args,
          ...sandboxed.plan.profile.args,
          ...extraArgs,
          'app-server',
          '--listen',
          'stdio://',
        ],
        cwd,
        life.signal,
        env,
        { launcher: sandboxed.launcher, policy: sandboxed.plan.policy },
      )
    : ownedProcess(command, serverArgs, cwd, life.signal, env);
  let seq = 0;
  let text = '';
  let threadId = '';
  let turnId = '';
  let observedModel = '';
  let observedUsage: Usage | null = null;
  let usage: Usage | null = null;
  const streamedItems = new Set<string>();
  let terminalResult = false;
  let finishing = false;
  let denied = false;
  const pending = new Map<
    number,
    { method: string; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  const send = (value: unknown) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n');
  };
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++seq;
      pending.set(n, { method, resolve, reject });
      send({ id: n, method, params });
    });
  return await new Promise<NativeResult>((resolve, reject) => {
    let failure: Error | undefined;
    let closed = false;
    let stderr = '';
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    let interruptId: number | undefined;
    const interruptGraceMs = options?.interruptGraceMs ?? 2_500;
    const handshakeTimer = setTimeout(
      () => fail(new Fault('adapter_timeout', 'Codex initialization timed out.', 504)),
      15_000,
    );
    const finish = () => {
      clearTimeout(handshakeTimer);
      if (closed) return;
      child.stdin.end();
      exitTimer ??= setTimeout(() => terminateOwned(child), 2000);
      exitTimer.unref();
    };
    const fail = (e: Error) => {
      failure ??= e;
      clearTimeout(handshakeTimer);
      terminateOwned(child);
    };
    const onAbort = () => {
      clearTimeout(handshakeTimer);
      if (closed) return;
      if (threadId && turnId && !finishing && child.stdin.writable) {
        interruptId = ++seq;
        send({ id: interruptId, method: 'turn/interrupt', params: { threadId, turnId } });
        interruptTimer ??= setTimeout(() => {
          child.stdin.end();
          terminateOwned(child);
        }, interruptGraceMs);
        interruptTimer.unref();
      } else {
        child.stdin.end();
        terminateOwned(child);
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // A delta or progress event the gateway cannot accept ends the turn, as on every other engine.
    let reporting = Promise.resolve();
    const report = (event: WorkEvent) => {
      reporting = reporting.then(() => emit(event)).then(() => {});
      void reporting.catch((error: unknown) =>
        fail(error instanceof Error ? error : new Fault('event_failed', String(error), 500)),
      );
    };
    jsonLines(
      child,
      (msg) => {
        if (typeof msg.id === 'number' && !msg.method) {
          if (msg.id === interruptId) {
            if (!closed) child.stdin.end();
            return;
          }
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (p) {
            if (msg.error) {
              const detail = redact(String(record(msg.error).message ?? 'Request rejected')).slice(
                0,
                500,
              );
              p.reject(new Fault('native_protocol_error', `Codex ${p.method}: ${detail}`, 502));
            } else {
              const result = record(msg.result);
              if (p.method === 'turn/start') {
                const returnedId = record(result.turn).id;
                if (
                  typeof returnedId !== 'string' ||
                  !returnedId ||
                  (turnId && turnId !== returnedId)
                ) {
                  p.reject(
                    new Fault('native_protocol_error', 'Codex returned an invalid turn ID.', 502),
                  );
                  return;
                }
                turnId = returnedId;
                clearTimeout(handshakeTimer);
              }
              p.resolve(result);
            }
          }
          return;
        }
        const params = record(msg.params);
        if (
          msg.method === 'turn/started' &&
          params.threadId === threadId &&
          !turnId &&
          [...pending.values()].some((p) => p.method === 'turn/start')
        ) {
          const startedId = record(params.turn).id;
          if (typeof startedId === 'string' && startedId) turnId = startedId;
        }
        const scoped =
          !!threadId &&
          params.threadId === threadId &&
          !!turnId &&
          (params.turnId ?? record(params.turn).id) === turnId;
        if (msg.method && msg.id !== undefined) {
          void (async () => {
            const method = String(msg.method);
            // MCP elicitation and MCP tool approvals may be thread-scoped in the app-server schema.
            const threadScoped =
              THREAD_SCOPED_METHODS.has(method) &&
              !!threadId &&
              params.threadId === threadId &&
              !!turnId &&
              params.turnId == null;
            if ((!scoped && !threadScoped) || finishing || !APPROVAL_METHODS.has(method)) {
              send({
                id: msg.id,
                error: {
                  code: -32601,
                  message: 'Host operation is not supported by this adapter.',
                },
              });
              return;
            }
            if (toolsDisabled) {
              denied = true;
              report({
                type: 'progress',
                data: { native: 'codex', event: 'permission_denied', reason: 'tools_disabled' },
              });
              send({ id: msg.id, result: codexDecisionPayload(method, params, false) });
              return;
            }
            const callerTool = codexCallerTool(method, params, options?.clientTools);
            if (callerTool !== null) {
              report({
                type: 'progress',
                data: { native: 'codex', event: 'permission_auto_allowed', tool: callerTool },
              });
              send({ id: msg.id, result: codexDecisionPayload(method, params, true) });
              return;
            }
            const answer = await emit({
              type: 'approval',
              data: { native: 'codex', method, params },
            });
            send({
              id: msg.id,
              result: codexDecisionPayload(method, params, answer?.decision === 'approve', answer),
            });
          })().catch(fail);
        }
        if (!scoped || finishing) return;
        if (msg.method === 'thread/tokenUsage/updated') {
          observedUsage = tokenUsage(record(params.tokenUsage).total);
          const baseline =
            typeof state?.threadId === 'string'
              ? tokenUsage(state.observedUsage, true)
              : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
          if (observedUsage && baseline) {
            const delta = {
              input_tokens: observedUsage.input_tokens - baseline.input_tokens,
              output_tokens: observedUsage.output_tokens - baseline.output_tokens,
              total_tokens: observedUsage.total_tokens - baseline.total_tokens,
            };
            usage = Object.values(delta).every((v) => v >= 0) ? delta : null;
          }
        }
        if (msg.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          if (typeof params.itemId === 'string') streamedItems.add(params.itemId);
          text += params.delta;
          report({ type: 'text', data: { delta: params.delta } });
        }
        if (msg.method === 'item/completed') {
          const item = params.item as Record<string, unknown> | undefined;
          if (
            item?.type === 'agentMessage' &&
            typeof item.id === 'string' &&
            typeof item.text === 'string' &&
            !streamedItems.has(item.id)
          ) {
            streamedItems.add(item.id);
            text += item.text;
            report({ type: 'text', data: { delta: item.text } });
          }
          if (item?.status === 'declined') denied = true;
          if (item && item.type !== 'agentMessage')
            report({
              type: 'progress',
              data: {
                native: 'codex',
                event: 'item',
                itemType: item.type,
                kind: CODEX_TOOL_ITEMS.has(String(item.type)) ? 'tool' : 'status',
                status: item.status,
              },
            });
        }
        if (msg.method === 'turn/completed') {
          if (signal.aborted) {
            if (!closed) child.stdin.end();
            return;
          }
          const turn = params.turn as Record<string, unknown>;
          // Same rule as every other engine: an operation the owner declined fails the run.
          if (denied) {
            fail(new Fault('permission_denied', 'Codex reported a declined operation.', 403));
            return;
          }
          if (turn?.status !== 'completed') {
            const detail = redact(
              String(record(turn?.error).message ?? 'Turn did not complete'),
            ).slice(0, 500);
            fail(new Fault('native_incomplete', `Codex: ${detail}`, 502));
            return;
          }
          // Persistence may be asynchronous; provider completion is not the gateway's commit.
          finishing = true;
          terminalResult = true;
          void reporting.then(
            () => {
              finish();
            },
            () => {},
          );
        }
      },
      fail,
    );
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-8192);
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(handshakeTimer);
      clearTimeout(exitTimer);
      clearTimeout(interruptTimer);
      life.abort();
      reject(error);
    });
    child.once('close', () => {
      closed = true;
      signal.removeEventListener('abort', onAbort);
      clearTimeout(handshakeTimer);
      clearTimeout(exitTimer);
      clearTimeout(interruptTimer);
      life.abort();
      for (const p of pending.values())
        p.reject(new Fault('native_closed', 'Codex process closed.', 502));
      pending.clear();
      const settle = () => {
        signal.removeEventListener('abort', settle);
        if (signal.aborted) reject(new Fault('cancelled', 'Codex cancelled.', 409));
        else if (failure) reject(failure);
        else if (!terminalResult)
          reject(
            new Fault(
              'native_incomplete',
              `Codex exited without a completed turn: ${redact(stderr).slice(0, 1000)}`,
              502,
            ),
          );
        else
          resolve({ text, nativeState: { threadId, turnId, observedModel, observedUsage }, usage });
      };
      if (!finishing || signal.aborted) settle();
      else {
        signal.addEventListener('abort', settle, { once: true });
        void reporting.then(settle, settle);
      }
    });
    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'open-agent-api', title: 'Open Agent API', version: PRODUCT_VERSION },
        capabilities: {},
      });
      send({ method: 'initialized', params: {} });
      const autoApprove =
        !toolsDisabled &&
        (agent.access?.approval === 'auto' || (!agent.access && agent.approvals === 'auto'));
      const instructions = toolsDisabled
        ? agent.instructions
          ? `${agent.instructions}\n\n${REASONING_ONLY}`
          : REASONING_ONLY
        : agent.instructions;
      const params = {
        cwd,
        allowProviderModelFallback: false,
        ...(toolsDisabled
          ? { approvalPolicy: 'on-request', ...(sandboxed ? {} : { sandbox: 'read-only' }) }
          : autoApprove
            ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
            : {}),
        ...(agent.model !== 'default' ? { model: agent.model } : {}),
        ...(instructions ? { developerInstructions: instructions } : {}),
      };
      const start =
        typeof state?.threadId === 'string'
          ? await request('thread/resume', { ...params, threadId: state.threadId })
          : await request('thread/start', params);
      const returnedThread = record(start.thread).id;
      if (typeof returnedThread !== 'string' || !returnedThread)
        throw new Fault('native_protocol_error', 'Codex returned an invalid thread ID.', 502);
      if (typeof state?.threadId === 'string' && returnedThread !== state.threadId)
        throw new Fault('native_protocol_error', 'Codex resumed a different thread.', 502);
      threadId = returnedThread;
      observedModel = typeof start.model === 'string' ? start.model : '';
      if (agent.model !== 'default' && observedModel !== agent.model)
        throw new Fault('model_not_supported', 'Codex did not confirm the requested model.', 400);
      await request('turn/start', { threadId, input });
    })().catch((e: unknown) => {
      if (!signal.aborted || !interruptTimer)
        fail(e instanceof Error ? e : new Fault('native_protocol_error', String(e), 502));
    });
  });
}

function tokenUsage(value: unknown, normalized = false): Usage | null {
  const v = record(value);
  const input_tokens = v[normalized ? 'input_tokens' : 'inputTokens'];
  const output_tokens = v[normalized ? 'output_tokens' : 'outputTokens'];
  const total_tokens = v[normalized ? 'total_tokens' : 'totalTokens'];
  if (
    ![input_tokens, output_tokens, total_tokens].every(
      (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null;
  return {
    input_tokens: input_tokens as number,
    output_tokens: output_tokens as number,
    total_tokens: total_tokens as number,
  };
}
