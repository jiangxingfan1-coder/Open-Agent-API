import { WebSocket } from 'ws';
import { type WorkerConfig, validateEndpoint } from '../config/config.js';
import type { Work, WorkEvent } from '../core/contracts.js';
import { LIMITS } from '../core/limits.js';
import {
  Fault,
  boundedJson,
  canonical,
  checkAbort,
  faultOf,
  id,
  secret,
  sleep,
} from '../core/util.js';
import { NO_NEGOTIATION, advertisedExecution } from './advertised-execution.js';
import { type Executor, WorkerRuntime } from './worker.js';
import { sendArtifacts } from './artifact-transfer.js';
import { NODE_HANDSHAKE_MS } from './node-messages.js';

type Emit = (event: WorkEvent) => Promise<Record<string, unknown> | void>;
type WorkerJob = {
  controller: AbortController;
  leaseId: string;
  timer: NodeJS.Timeout;
  actions: Map<string, (answer: Record<string, unknown>) => void>;
  kind: 'install' | 'execute';
  failure?: Fault;
  chunk?: { index: number; offset: number; acknowledge: () => void };
};

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN)
    throw new Fault('node_disconnected', 'Worker connection is closed.', 503);
  if (socket.bufferedAmount > LIMITS.nodeMessageBytes)
    throw new Fault('node_backpressure', 'Worker connection exceeded its buffer limit.', 503);
  socket.send(boundedJson(message, LIMITS.nodeMessageBytes));
}

/** Answer when an approval or caller-tool event cannot reach a decision (cancelled, ended). */
export const noAnswer = (event: WorkEvent) =>
  event.type === 'approval'
    ? { decision: 'deny' }
    : event.type === 'client_tool'
      ? { error: 'The caller tool call was interrupted.' }
      : undefined;

export async function connectWorker(
  config: WorkerConfig,
  stop: AbortSignal,
  runtime: Executor = new WorkerRuntime(config),
): Promise<void> {
  if (!config.gatewayUrl)
    throw new Fault('invalid_config', 'gatewayUrl is required for a remote worker.');
  const url = new URL(config.gatewayUrl);
  url.protocol =
    url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = '/v1/nodes/connect';
  validateEndpoint(url.toString(), true);
  const token = await secret(config);
  let backoff = 250;
  try {
    while (!stop.aborted) {
      await workerConnection(url.toString(), token, config, stop, runtime).catch((e) => {
        if (!stop.aborted && faultOf(e).code === 'node_authentication_denied') throw e;
        if (!stop.aborted) process.stderr.write(`Worker connection: ${faultOf(e).code}\n`);
      });
      if (!stop.aborted) await sleep(backoff, stop).catch(() => {});
      backoff = Math.min(5000, backoff * 2);
    }
  } finally {
    await runtime.close();
  }
}

async function workerConnection(
  url: string,
  token: string,
  config: WorkerConfig,
  stop: AbortSignal,
  runtime: Executor,
): Promise<void> {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}`, 'x-oaa-node-id': config.nodeId },
    maxPayload: LIMITS.nodeMessageBytes,
    handshakeTimeout: NODE_HANDSHAKE_MS,
  });
  const jobs = new Map<string, WorkerJob>();
  const running = new Set<Promise<void>>();
  let ended = false;
  let welcomeTimer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let lastAck = Date.now();
      let leaseMs = 15_000;
      let welcomed = false;
      const abort = () => {
        ended = true;
        if (welcomed) ws.close();
        else ws.terminate();
      };
      stop.addEventListener('abort', abort, { once: true });
      let metadataUpdates = false;
      let artifactChunks = false;
      let lastAdvertisement = '';
      const negotiated = { ...NO_NEGOTIATION };
      const advertise = (type: 'hello' | 'advertisement') => {
        const { execution: full, ...advertisement } = runtime.advertisement();
        if (!negotiated.providerState && full?.providerStateProviders?.length)
          advertisement.providers = advertisement.providers.filter(
            (provider) => !full.providerStateProviders!.includes(provider),
          );
        const execution = advertisedExecution(full, negotiated);
        const fingerprint = canonical({ advertisement, execution });
        if (type === 'advertisement' && fingerprint === lastAdvertisement) return;
        lastAdvertisement = fingerprint;
        send(ws, { type, protocol: 'oaa/1', advertisement, execution });
      };
      ws.once('open', () => {
        try {
          checkAbort(stop);
          advertise('hello');
          // The WebSocket handshake timeout ends at HTTP upgrade; no lease exists yet.
          welcomeTimer = setTimeout(() => {
            if (welcomed || ws.readyState === WebSocket.CLOSED) return;
            ended = true;
            reject(
              new Fault('node_disconnected', 'Gateway did not acknowledge node registration.', 503),
            );
            ws.terminate();
          }, NODE_HANDSHAKE_MS).unref();
        } catch {
          ws.terminate();
        }
      });
      ws.on('message', (data) => {
        if (ended) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'welcome') {
            if (
              welcomed ||
              msg.protocol !== 'oaa/1' ||
              !Number.isInteger(msg.leaseMs) ||
              msg.leaseMs < 100 ||
              msg.leaseMs > 120_000
            )
              throw new Error('Invalid welcome');
            welcomed = true;
            clearTimeout(welcomeTimer);
            leaseMs = msg.leaseMs;
            lastAck = Date.now();
            metadataUpdates =
              Array.isArray(msg.features) && msg.features.includes('execution-capabilities-v1');
            const features: unknown[] = Array.isArray(msg.features) ? msg.features : [];
            artifactChunks = features.includes('artifact-chunks-v1');
            negotiated.byok = metadataUpdates && features.includes('byok-v1');
            negotiated.sandbox = metadataUpdates && features.includes('sandbox-v1');
            negotiated.providerState = metadataUpdates && features.includes('provider-turn-v1');
            negotiated.clientTools = metadataUpdates && features.includes('client-tools-v1');
            negotiated.imageInput = metadataUpdates && features.includes('image-input-v1');
            negotiated.modelCatalogs = metadataUpdates && features.includes('model-catalog-v1');
            negotiated.agentPolicy = metadataUpdates && features.includes('agent-policy-v1');
            negotiated.toolFreeReasoning =
              metadataUpdates && features.includes('tool-free-reasoning-v1');
            negotiated.traceContext = metadataUpdates && features.includes('trace-context-v1');
            negotiated.adapterProfiles =
              metadataUpdates && features.includes('conversion-profiles-v1');
            if (Object.values(negotiated).some(Boolean)) advertise('advertisement');
            heartbeat = setInterval(
              () => {
                if (Date.now() - lastAck > leaseMs) {
                  ws.terminate();
                  return;
                }
                try {
                  send(ws, { type: 'heartbeat' });
                  if (metadataUpdates) advertise('advertisement');
                } catch {
                  ws.terminate();
                }
              },
              Math.max(50, leaseMs / 3),
            );
            return;
          }
          if (!welcomed) throw new Error('Dispatch before welcome');
          if (msg.type === 'heartbeat_ack') {
            lastAck = Date.now();
            return;
          }
          const existing = jobs.get(msg.id);
          if (msg.type === 'artifact_ack') {
            const chunk = existing?.chunk;
            if (
              chunk &&
              existing?.leaseId === msg.leaseId &&
              chunk.index === msg.index &&
              chunk.offset === msg.offset
            )
              chunk.acknowledge();
            return;
          }
          if (['cancel', 'renew', 'action'].includes(msg.type)) {
            if (!existing || existing.leaseId !== msg.leaseId || existing.controller.signal.aborted)
              return;
            if (msg.type === 'cancel') existing.controller.abort();
            else if (msg.type === 'renew') {
              clearTimeout(existing.timer);
              existing.timer = setTimeout(() => existing.controller.abort(), leaseMs);
            } else {
              existing.actions.get(msg.actionId)?.(msg.answer);
              existing.actions.delete(msg.actionId);
            }
            return;
          }
          if (
            !['install', 'execute'].includes(msg.type) ||
            msg.protocol !== 'oaa/1' ||
            typeof msg.id !== 'string' ||
            typeof msg.leaseId !== 'string' ||
            existing
          )
            throw new Error('Invalid dispatch');
          if (
            jobs.size >= config.concurrency + 4 ||
            (msg.type === 'execute' &&
              [...jobs.values()].filter((j) => j.kind === 'execute').length >= config.concurrency)
          ) {
            send(ws, {
              type: 'result',
              id: msg.id,
              leaseId: msg.leaseId,
              error: {
                code: 'worker_capacity_exceeded',
                message:
                  'Worker capacity is occupied, including draining jobs. This request was not started.',
                uncertain: false,
              },
            });
            return;
          }
          const controller = new AbortController();
          const actions = new Map<string, (answer: Record<string, unknown>) => void>();
          const job: WorkerJob = {
            controller,
            leaseId: msg.leaseId as string,
            kind: msg.type,
            actions,
            timer: setTimeout(() => controller.abort(), leaseMs),
          };
          jobs.set(msg.id, job);
          const emit: Emit = async (event) => {
            if (controller.signal.aborted || ended) return noAnswer(event);
            if (event.type !== 'approval' && event.type !== 'client_tool') {
              try {
                send(ws, { type: 'event', id: msg.id, leaseId: job.leaseId, event });
              } catch (error) {
                job.failure = faultOf(error);
                controller.abort();
              }
              return;
            }
            return await new Promise<Record<string, unknown>>((answer, rejectAction) => {
              const actionId = id('action');
              const onAbort = () => {
                actions.delete(actionId);
                rejectAction(new Fault('cancelled', 'Approval interrupted.', 409));
              };
              controller.signal.addEventListener('abort', onAbort, { once: true });
              actions.set(actionId, (result) => {
                controller.signal.removeEventListener('abort', onAbort);
                answer(result);
              });
              try {
                send(ws, { type: 'event', id: msg.id, leaseId: job.leaseId, event, actionId });
              } catch (error) {
                job.failure = faultOf(error);
                controller.abort();
              }
            });
          };
          const task = (async () => {
            try {
              if (
                msg.type === 'execute' &&
                msg.payload?.kind === 'model' &&
                !negotiated.providerState &&
                (runtime
                  .advertisement()
                  .execution?.providerStateProviders?.includes(msg.payload.agent?.provider) ||
                  msg.payload.messages?.some(
                    (message: { providerState?: unknown }) => !!message.providerState,
                  ))
              )
                throw new Fault(
                  'provider_state_unsupported',
                  'Gateway did not negotiate native provider turn state.',
                  503,
                );
              const result =
                msg.type === 'install'
                  ? await runtime
                      .install(msg.payload, controller.signal)
                      .then(() => ({ installed: true }))
                  : await runtime.execute(msg.payload as Work, controller.signal, emit);
              if (job.failure) throw job.failure;
              if ('providerState' in result && result.providerState && !negotiated.providerState)
                throw new Fault(
                  'provider_state_unsupported',
                  'Gateway cannot checkpoint native provider turn state.',
                  503,
                );
              checkAbort(controller.signal);
              const outbound =
                'installed' in result
                  ? result
                  : await sendArtifacts(
                      result,
                      artifactChunks,
                      controller.signal,
                      (chunk) =>
                        new Promise<void>((resolve, reject) => {
                          checkAbort(controller.signal);
                          const abort = () => {
                            delete job.chunk;
                            reject(
                              new Fault('cancelled', 'Artifact transfer interrupted.', 409, true),
                            );
                          };
                          controller.signal.addEventListener('abort', abort, { once: true });
                          job.chunk = {
                            index: chunk.index,
                            offset: chunk.offset,
                            acknowledge: () => {
                              controller.signal.removeEventListener('abort', abort);
                              delete job.chunk;
                              resolve();
                            },
                          };
                          try {
                            send(ws, {
                              type: 'artifact_chunk',
                              id: msg.id,
                              leaseId: job.leaseId,
                              ...chunk,
                            });
                          } catch (error) {
                            controller.signal.removeEventListener('abort', abort);
                            delete job.chunk;
                            reject(error);
                          }
                        }),
                    );
              send(ws, { type: 'result', id: msg.id, leaseId: job.leaseId, result: outbound });
            } catch (error) {
              const e = job.failure ?? faultOf(error);
              try {
                send(ws, {
                  type: 'result',
                  id: msg.id,
                  leaseId: job.leaseId,
                  error: { code: e.code, message: e.message, uncertain: e.uncertain },
                });
              } catch {
                // The connection is gone; there is no one left to report to.
              }
            } finally {
              clearTimeout(job.timer);
              controller.abort();
              jobs.delete(msg.id);
            }
          })();
          running.add(task);
          void task.then(
            () => running.delete(task),
            () => running.delete(task),
          );
        } catch {
          ended = true;
          ws.close(1008, 'Invalid protocol');
        }
      });
      ws.on('error', reject);
      ws.once('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 502;
        reject(
          new Fault(
            [401, 403].includes(status) ? 'node_authentication_denied' : 'node_connection_failed',
            [401, 403].includes(status)
              ? 'Gateway denied this node credential. The worker stopped reconnecting; review its registration before restarting.'
              : `Gateway rejected the worker connection with HTTP ${status}.`,
            status,
          ),
        );
        response.destroy();
        ws.terminate();
      });
      ws.once('close', () => {
        ended = true;
        clearInterval(heartbeat);
        stop.removeEventListener('abort', abort);
        for (const j of jobs.values()) {
          clearTimeout(j.timer);
          j.controller.abort();
        }
        resolve();
      });
    });
  } finally {
    ended = true;
    clearTimeout(welcomeTimer);
    ws.terminate();
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
    await Promise.allSettled(running);
  }
}
