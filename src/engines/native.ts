import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentDefinition, WorkEvent, Usage, ArtifactPayload } from '../core/contracts.js';
import type { WorkerConfig } from '../config/config.js';
import { directExecutable } from './win-spawn.js';
import {
  DeferredProcess,
  ownedProcess,
  jsonLines,
  collectProcess,
  nativeEnvironment,
  spawnSandboxed,
  terminateOwned,
} from './process.js';
import type { SandboxLauncher, SandboxNativeEngine } from './sandbox.js';
import { claudePrompt, codexInput, imageDeliveryHint, type EngineImages } from './image-blocks.js';
import { Fault, id, redact } from '../core/util.js';
import { agentFailure, safeEmit, type Emit } from './shared.js';
import { loadClaudeSdk } from './claude-sdk.js';
import { CODEX_TOOL_ITEMS, DENIAL, errorText } from './native-signals.js';
import { PRODUCT_VERSION } from '../core/version.js';

import { sandboxPlan, type NativeSandbox } from './native-sandbox.js';
export type { NativeSandbox } from './native-sandbox.js';

export type NativeResult = {
  text: string;
  nativeState: Record<string, unknown>;
  usage: Usage | null;
  artifacts?: ArtifactPayload[];
};
export async function runNative(
  agent: AgentDefinition,
  config: WorkerConfig,
  cwd: string,
  input: string,
  signal: AbortSignal,
  emit: Emit,
  state?: Record<string, unknown>,
  sandbox?: NativeSandbox,
  images?: EngineImages,
): Promise<NativeResult> {
  const kind = agent.engine;
  if (kind !== 'codex' && kind !== 'claude' && kind !== 'antigravity' && kind !== 'dsh')
    throw new Fault('invalid_engine', 'This is not a built-in native backend.');
  const settings = config.native[kind];
  if (!settings?.enabled)
    throw new Fault('native_disabled', `${kind} is not enabled on this worker.`, 503);
  if (sandbox && kind !== 'claude' && kind !== 'codex')
    throw new Fault('sandbox_unavailable', `${kind} cannot run inside the OS sandbox yet.`, 503);
  const plan = sandbox
    ? await sandboxPlan(kind as SandboxNativeEngine, settings.executable, cwd, sandbox)
    : undefined;
  if (kind === 'claude') {
    const { query } = await loadClaudeSdk();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let session = '';
    let text = '';
    let usage: Usage | null = null;
    let completed = false;
    const q = query({
      prompt: await claudePrompt(input, cwd, images),
      options: {
        pathToClaudeCodeExecutable: plan
          ? settings.executable
          : directExecutable(settings.executable),
        cwd,
        model: agent.model === 'default' ? undefined : agent.model,
        resume: typeof state?.sessionId === 'string' ? state.sessionId : undefined,
        // Sandboxed: no owner settings, `--bare` (API-key auth only, no OAuth or keychain), and the
        // CLI started through the sandbox instead of the SDK's local spawn.
        settingSources: plan ? [] : ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: agent.instructions },
        abortController: controller,
        maxTurns: agent.limits.maxTurns,
        env: plan ? plan.env : nativeEnvironment(config.nativeEnv),
        ...(plan
          ? {
              extraArgs: { bare: null },
              spawnClaudeCodeProcess: (options) => {
                // The SDK starts the configured CLI directly, or (for a .js/.mjs CLI) through a
                // runtime with the script first. Either way the sandbox runs the real node binary
                // or the real executable path, never a symlink inside the denied home directory.
                const viaRuntime = options.args[0] === settings.executable;
                const direct = options.command === settings.executable;
                const command = viaRuntime || direct ? plan.launch.command : options.command;
                const args = viaRuntime
                  ? [...plan.launch.prefix, ...options.args.slice(1)]
                  : direct
                    ? [...plan.launch.prefix, ...options.args]
                    : options.args;
                return new DeferredProcess(() =>
                  spawnSandboxed(
                    command,
                    args,
                    options.cwd ?? cwd,
                    options.signal,
                    { ...plan.env, ...pickDefined(options.env, Object.keys(plan.env)) },
                    { launcher: sandbox!.launcher, policy: plan.policy },
                  ),
                );
              },
            }
          : {}),
        canUseTool: async (tool, args) => {
          const answer = await emit({
            type: 'approval',
            data: { native: 'claude', tool, arguments: args },
          });
          return answer?.decision === 'approve'
            ? { behavior: 'allow', updatedInput: args }
            : { behavior: 'deny', message: 'The API owner denied this action.' };
        },
      },
    });
    try {
      for await (const message of q) {
        if ('session_id' in message && typeof message.session_id === 'string')
          session = message.session_id;
        if (message.type === 'assistant') {
          for (const part of message.message.content)
            if (part.type === 'text') {
              text += part.text;
              await emit({ type: 'text', data: { delta: part.text } });
            } else if (part.type === 'tool_use') {
              // Tool activity is visible like other native engines (names only, no arguments).
              await emit({
                type: 'progress',
                data: { native: 'claude', event: 'tool', tool: String(part.name).slice(0, 160) },
              });
            }
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error)
            throw agentFailure(
              'Claude',
              message.subtype === 'success' && message.result.trim()
                ? message.result
                : 'errors' in message
                  ? message.errors.join('; ')
                  : '',
            );
          if (message.permission_denials?.length)
            throw new Fault('permission_denied', 'Claude reported denied tool operations.', 403);
          completed = true;
          text = message.result;
          usage = {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
            total_tokens: message.usage.input_tokens + message.usage.output_tokens,
          };
        }
      }
      if (!completed) throw new Fault('native_truncated', 'Claude ended without a result.', 502);
      return { text, nativeState: { sessionId: session }, usage };
    } catch (error) {
      throw imageDeliveryHint(error, 'Claude Code', 'Agent SDK image blocks', images);
    } finally {
      signal.removeEventListener('abort', abort);
      q.close();
    }
  }
  if (kind === 'dsh') {
    if (state)
      throw new Fault(
        'native_resume_unsupported',
        'DSH headless currently supports one-shot tasks only.',
        409,
      );
    const mapped = settings.models?.[agent.model];
    if (agent.model !== 'default' && !mapped?.length)
      throw new Fault(
        'model_not_supported',
        'DSH needs an owner-configured model overlay for this model. No global settings were changed.',
        400,
      );
    const text = await collectProcess(
      settings.executable,
      [
        '--profile',
        'headless',
        ...settings.args,
        ...(mapped ?? []),
        '--',
        `${agent.instructions}\n\n${input}`,
      ],
      cwd,
      '',
      signal,
      nativeEnvironment(config.nativeEnv),
    );
    await emit({ type: 'text', data: { delta: text } });
    return { text, nativeState: { oneShot: true }, usage: null };
  }
  if (kind === 'antigravity') {
    const args = [
      ...settings.args,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];
    if (agent.model !== 'default') args.push('--model', agent.model);
    if (typeof state?.conversationId === 'string')
      args.push('--conversation', state.conversationId);
    const child = ownedProcess(
      settings.executable,
      args,
      cwd,
      signal,
      nativeEnvironment(config.nativeEnv),
    );
    return await new Promise<NativeResult>((resolve, reject) => {
      let final: Record<string, unknown> | undefined;
      let initialized = false;
      let observedModel: string | undefined;
      let toolCount = 0;
      let denied = false;
      let stderr = '';
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
        terminateOwned(child);
      };
      const report = (event: WorkEvent) => {
        safeEmit(emit, event, (error) => fail(error as Error));
      };
      jsonLines(
        child,
        (msg) => {
          if (failure) return;
          if (msg.event === 'init') {
            if (initialized) {
              fail(
                new Fault(
                  'native_protocol_error',
                  'Antigravity emitted a duplicate initialization.',
                  502,
                ),
              );
              return;
            }
            const init = msg.init as Record<string, unknown> | undefined;
            observedModel = typeof init?.model === 'string' ? init.model : undefined;
            if (agent.model !== 'default' && observedModel !== agent.model) {
              fail(
                new Fault(
                  'native_model_mismatch',
                  'Antigravity did not confirm the explicitly requested model; no prompt was sent.',
                  409,
                ),
              );
              return;
            }
            initialized = true;
            toolCount = Array.isArray(init?.tools) ? init.tools.length : 0;
            report({
              type: 'progress',
              data: {
                native: 'antigravity',
                event: 'initialized',
                model: observedModel ?? null,
                tool_count: toolCount,
                permission_mode:
                  typeof init?.permission_mode === 'string' ? init.permission_mode : null,
              },
            });
            child.stdin.write(
              JSON.stringify({
                event: 'user',
                message: { content: `${agent.instructions}\n\n${input}` },
              }) + '\n',
            );
            return;
          }
          if (!initialized) {
            fail(
              new Fault(
                'native_protocol_error',
                'Antigravity emitted a turn before initialization.',
                502,
              ),
            );
            return;
          }
          const payload = (msg.step_update ?? {}) as Record<string, unknown>;
          if (
            msg.event === 'step_update' &&
            payload.step_type === 'agent_response' &&
            typeof payload.text_delta === 'string'
          )
            report({ type: 'text', data: { delta: payload.text_delta } });
          if (msg.event === 'step_update' && payload.step_type === 'tool') {
            const tool = payload.tool_info as Record<string, unknown> | undefined;
            // Only a recognisable denial fails the turn as permission_denied; any other tool error
            // is the agent's to recover from, and its own result decides the turn.
            if (tool?.error && DENIAL.test(errorText(tool.error))) denied = true;
            report({
              type: 'progress',
              data: {
                native: 'antigravity',
                event: 'tool',
                tool: payload.tool_name,
                state: payload.state,
              },
            });
          }
          if (msg.event === 'result') {
            final = msg.result as Record<string, unknown>;
            child.stdin.end();
          }
        },
        fail,
      );
      child.stderr.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString('utf8')).slice(-32_768);
        if (DENIAL.test(stderr)) denied = true;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (signal.aborted) reject(new Fault('cancelled', 'Antigravity cancelled.', 409));
        else if (failure) reject(failure);
        else if (denied)
          reject(
            new Fault(
              'permission_denied',
              'Antigravity reported denied or failed tool operations; exit code is not success evidence.',
              403,
            ),
          );
        else if (
          code !== 0 ||
          !final ||
          final.status !== 'SUCCESS' ||
          typeof final.response !== 'string' ||
          typeof final.conversation_id !== 'string'
        )
          reject(
            new Fault(
              'native_incomplete',
              `Antigravity did not complete: ${redact(typeof final?.error === 'string' ? final.error : stderr).slice(0, 1000)}`,
              502,
            ),
          );
        else {
          const raw = final.usage as Record<string, unknown> | undefined;
          const observedUsage =
            raw &&
            ['input_tokens', 'output_tokens', 'total_tokens'].every(
              (key) =>
                typeof raw[key] === 'number' &&
                Number.isSafeInteger(raw[key]) &&
                Number(raw[key]) >= 0,
            )
              ? {
                  input_tokens: Number(raw.input_tokens),
                  output_tokens: Number(raw.output_tokens),
                  total_tokens: Number(raw.total_tokens),
                }
              : null;
          resolve({
            text: final.response,
            nativeState: {
              conversationId: final.conversation_id,
              observedModel,
              toolCount,
              observedUsage,
              usageScope: 'provider_reported_session',
            },
            usage: state ? null : observedUsage,
          });
        }
      });
      child.stdin.on('error', () => {});
    });
  }
  return await codex(
    settings.executable,
    settings.args,
    agent,
    cwd,
    codexInput(input, cwd, images),
    signal,
    emit,
    state,
    plan ? plan.env : nativeEnvironment(config.nativeEnv),
    plan ? { launcher: sandbox!.launcher, plan } : undefined,
  ).catch((error: unknown) => {
    throw imageDeliveryHint(error, 'Codex', 'turn/start localImage items', images);
  });
}

/**
 * Of the SDK's computed environment, keep only variables the sandbox plan already defines
 * (the SDK may adjust them) and the SDK's own CLAUDE_CODE_* / CLAUDE_AGENT_SDK_* markers.
 * Anything else the SDK copies from this process must not reach the sandbox.
 */
function pickDefined(
  env: Record<string, string | undefined>,
  allowed: string[],
): Record<string, string> {
  const keep = new Set(allowed);
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (keep.has(entry[0]) || /^CLAUDE_(CODE|AGENT_SDK)_[A-Z0-9_]+$/.test(entry[0])),
    ),
  );
}

async function codex(
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
): Promise<NativeResult> {
  const serverArgs = [...args, 'app-server', '--listen', 'stdio://'];
  const child = sandboxed
    ? await spawnSandboxed(
        sandboxed.plan.launch.command,
        // Engine flags go after the configured args (which may hold a script path) and before
        // the subcommand, so `node <script> -c …` never reads them as node's own flags.
        [
          ...sandboxed.plan.launch.prefix,
          ...args,
          ...sandboxed.plan.profile.args,
          'app-server',
          '--listen',
          'stdio://',
        ],
        cwd,
        signal,
        env,
        { launcher: sandboxed.launcher, policy: sandboxed.plan.policy },
      )
    : ownedProcess(command, serverArgs, cwd, signal, env);
  let seq = 0;
  let text = '';
  let threadId = '';
  let terminalResult = false;
  let denied = false;
  const pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++seq;
      pending.set(n, { resolve, reject });
      send({ id: n, method, params });
    });
  return await new Promise<NativeResult>((resolve, reject) => {
    let failure: Error | undefined;
    let stderr = '';
    const fail = (e: Error) => {
      failure = e;
      child.stdin.end();
      terminateOwned(child);
    };
    // A delta or progress event the gateway cannot accept ends the turn, as on every other engine.
    const report = (event: WorkEvent) =>
      safeEmit(emit, event, (error) =>
        fail(error instanceof Error ? error : new Fault('event_failed', String(error), 500)),
      );
    jsonLines(
      child,
      (msg) => {
        if (typeof msg.id === 'number' && !msg.method) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (p) {
            if (msg.error)
              p.reject(new Fault('native_protocol_error', 'Codex RPC rejected a request.', 502));
            else p.resolve((msg.result ?? {}) as Record<string, unknown>);
          }
          return;
        }
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (msg.method && msg.id !== undefined) {
          void (async () => {
            const method = String(msg.method);
            if (
              ![
                'item/commandExecution/requestApproval',
                'item/fileChange/requestApproval',
                'item/permissions/requestApproval',
                'item/tool/requestUserInput',
                'tool/requestUserInput',
                'mcpServer/elicitation/request',
              ].includes(method)
            ) {
              send({
                id: msg.id,
                error: {
                  code: -32601,
                  message: 'Host operation is not supported by this adapter.',
                },
              });
              return;
            }
            const answer = await emit({
              type: 'approval',
              data: { native: 'codex', method, params },
            });
            let result: unknown = {
              decision: answer?.decision === 'approve' ? 'accept' : 'decline',
            };
            if (method.includes('requestUserInput'))
              result = answer?.answers ? { answers: answer.answers } : { answers: {} };
            if (method.includes('elicitation'))
              result = {
                action: answer?.decision === 'approve' ? 'accept' : 'decline',
                content: answer?.content ?? null,
              };
            if (method === 'item/permissions/requestApproval')
              result = {
                permissions: answer?.decision === 'approve' ? (params.permissions ?? {}) : {},
                scope: 'turn',
              };
            send({ id: msg.id, result });
          })().catch(fail);
        }
        if (msg.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          text += params.delta;
          report({ type: 'text', data: { delta: params.delta } });
        }
        if (msg.method === 'item/completed') {
          const item = params.item as Record<string, unknown> | undefined;
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
          const turn = params.turn as Record<string, unknown>;
          // Same rule as every other engine: an operation the owner declined fails the run.
          if (denied) {
            fail(new Fault('permission_denied', 'Codex reported a declined operation.', 403));
            return;
          }
          if (turn?.status !== 'completed') {
            fail(new Fault('native_incomplete', 'Codex turn did not complete.', 502));
            return;
          }
          terminalResult = true;
          child.stdin.end();
        }
      },
      fail,
    );
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-8192);
    });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code) => {
      for (const p of pending.values())
        p.reject(new Fault('native_closed', 'Codex process closed.', 502));
      pending.clear();
      if (signal.aborted) reject(new Fault('cancelled', 'Codex cancelled.', 409));
      else if (failure) reject(failure);
      else if (code !== 0 || !terminalResult)
        reject(
          new Fault(
            'native_incomplete',
            `Codex exited without a completed turn: ${redact(stderr).slice(0, 1000)}`,
            502,
          ),
        );
      else resolve({ text, nativeState: { threadId }, usage: null });
    });
    void (async () => {
      await request('initialize', {
        clientInfo: { name: 'open-agent-api', title: 'Open Agent API', version: PRODUCT_VERSION },
        capabilities: {},
      });
      send({ method: 'initialized', params: {} });
      const params = {
        cwd,
        ...(agent.model !== 'default' ? { model: agent.model } : {}),
        ...(agent.instructions ? { developerInstructions: agent.instructions } : {}),
      };
      const start =
        typeof state?.threadId === 'string'
          ? await request('thread/resume', { ...params, threadId: state.threadId })
          : await request('thread/start', params);
      threadId = String((start.thread as Record<string, unknown>).id);
      await request('turn/start', { threadId, input });
    })().catch(fail);
  });
}
