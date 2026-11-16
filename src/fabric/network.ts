import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  capabilitySchema,
  executionCapabilitiesSchema,
  type AgentDefinition,
  type FilePayload,
  type ImageMode,
  type AgentBundle,
  type NodeAdvertisement,
  type NodeCredential,
  type NodePolicy,
  type Work,
  type WorkEvent,
  type WorkResult,
} from '../core/contracts.js';
import { type Executor, WorkerRuntime } from './worker.js';
import { type WorkerConfig, validateEndpoint } from '../config/config.js';
import {
  permits,
  modelPlacement,
  toolPlacement,
  workPlacement,
  workTarget,
  type PlacementReason,
} from './placement.js';
export { permits } from './placement.js';
import { NO_NEGOTIATION, advertisedExecution } from './advertised-execution.js';
export { advertisedExecution } from './advertised-execution.js';
import {
  Fault,
  boundedJson,
  canonical,
  checkAbort,
  faultOf,
  id,
  safeEqual,
  secret,
  sha,
  sleep,
  deadlineTimer,
  coarseDelay,
} from '../core/util.js';
import { LIMITS } from '../core/limits.js';
import { isUncertainWhenStarted } from '../core/errors.js';
import { checkWorkResult, parseNodeMessage, type NodeMessage } from './node-messages.js';

const advertisementSchema = z
  .object({
    nodeId: z.string(),
    providers: z.array(z.string()).max(100),
    // Built-in engines plus every enabled owner adapter (ACP presets alone exceed 30).
    natives: z.array(z.string()).max(128),
    capabilities: z.array(capabilitySchema).max(200),
    warm: z.array(z.string()).max(500),
    concurrency: z.number().int().min(1).max(64),
    execution: executionCapabilitiesSchema.optional(),
  })
  .strict();
type Emit = (event: WorkEvent) => Promise<Record<string, unknown> | void>;
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  emit: Emit;
  signal: AbortSignal;
  abort: () => void;
  timer: NodeJS.Timeout;
  lease: NodeJS.Timeout;
  leaseId: string;
  kind: 'install' | Work['kind'];
  cancellation?: Fault;
};
type WorkerJob = {
  controller: AbortController;
  leaseId: string;
  timer: NodeJS.Timeout;
  actions: Map<string, (answer: Record<string, unknown>) => void>;
  kind: 'install' | 'execute';
  failure?: Fault;
};
function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN)
    throw new Fault('node_disconnected', 'Worker connection is closed.', 503);
  if (socket.bufferedAmount > LIMITS.nodeMessageBytes)
    throw new Fault('node_backpressure', 'Worker connection exceeded its buffer limit.', 503);
  socket.send(boundedJson(message, LIMITS.nodeMessageBytes));
}
/** 导出只为进程内测试能直接驱动它（替身 socket）；网关内只由 NodeHub 创建。 */
export class RemoteExecutor implements Executor {
  private pending = new Map<string, Pending>();
  private disconnected = false;
  lastSeen = Date.now();
  constructor(
    readonly socket: WebSocket,
    private advert: NodeAdvertisement,
    readonly leaseMs: number,
    readonly changed: (advertisement: NodeAdvertisement) => void,
  ) {
    socket.on('message', (bytes) => this.message(bytes.toString()));
    socket.once('close', () => this.disconnect());
  }
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const [id, pending] of this.pending) {
      this.cleanup(id);
      pending.reject(
        pending.cancellation ??
          new Fault(
            'node_disconnected',
            'Worker disconnected or its trust was revoked; execution outcome may be unknown.',
            503,
          ),
      );
    }
    this.socket.terminate();
  }
  advertisement(): NodeAdvertisement {
    return this.advert;
  }
  private cleanup(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    clearInterval(p.lease);
    p.signal.removeEventListener('abort', p.abort);
    this.pending.delete(requestId);
  }
  private cancel(requestId: string, fault: Fault): void {
    const p = this.pending.get(requestId);
    if (!p || p.cancellation) return;
    p.cancellation = fault;
    clearTimeout(p.timer);
    clearInterval(p.lease);
    // A sent cancellation is not evidence that the worker released its execution slot.
    p.timer = setTimeout(() => this.socket.terminate(), this.leaseMs);
    try {
      send(this.socket, { type: 'cancel', id: requestId, leaseId: p.leaseId });
    } catch {
      this.socket.terminate();
    }
  }
  /** 最近的线协议问题（拒绝的、忽略的消息），最多 50 条；只在内存，供诊断与测试。 */
  readonly protocolIssues: string[] = [];
  private note(issue: string): void {
    if (this.protocolIssues.push(issue.slice(0, 300)) > 50) this.protocolIssues.shift();
  }
  private refuse(issue: string): void {
    this.note(`closed: ${issue}`);
    this.socket.close(1008, 'Invalid protocol');
  }
  private message(raw: string): void {
    if (this.disconnected) return;
    // 每类上行消息都先过结构校验。
    let msg: NodeMessage;
    try {
      msg = parseNodeMessage(raw);
    } catch (error) {
      return this.refuse((error as Error).message);
    }
    try {
      if (msg.type === 'heartbeat') {
        this.lastSeen = Date.now();
        send(this.socket, { type: 'heartbeat_ack' });
        return;
      }
      if (msg.type === 'advertisement') {
        const next = advertisementSchema.parse({
          ...(msg.advertisement as object),
          execution: msg.execution,
        });
        this.changed(next);
        this.advert = next;
        this.lastSeen = Date.now();
        return;
      }
      if (msg.type === 'unknown') return this.note(`ignored message type ${msg.name}`);
      const key = msg.id;
      const p = this.pending.get(key);
      // 迟到、重复、租约不符或不是发给本节点的请求：照旧忽略（至多提交一次）。
      if (!p || msg.leaseId !== p.leaseId) return this.note(`ignored ${msg.type} for ${key}`);
      if (msg.type === 'event') {
        if (p.cancellation) return;
        const event = msg.event;
        void p
          .emit(event)
          .then((answer) => {
            const answered = event.type === 'approval' || event.type === 'client_tool';
            if (answered && this.pending.get(key) === p && !p.cancellation)
              send(this.socket, {
                type: 'action',
                id: key,
                leaseId: p.leaseId,
                actionId: msg.actionId,
                answer: answer ?? noAnswer(event),
              });
          })
          .catch((e) => {
            if (this.pending.get(key) === p) this.cancel(key, faultOf(e));
          });
        return;
      }
      this.cleanup(key);
      if (p.cancellation) return p.reject(p.cancellation);
      if (msg.error)
        return p.reject(new Fault(msg.error.code, msg.error.message, 502, msg.error.uncertain));
      let result: unknown;
      try {
        result = checkWorkResult(p.kind, msg.result);
      } catch (error) {
        // 节点声称执行完了、结果却不合规：外部效果未知，按 uncertain 拒绝并断开。
        p.reject(new Fault('invalid_protocol', 'Worker returned a malformed result.', 502, true));
        return this.refuse((error as Error).message);
      }
      p.resolve(result);
    } catch (error) {
      this.refuse(`rejected ${msg.type}: ${(error as Error).message}`);
    }
  }
  private call(
    type: string,
    payload: unknown,
    signal: AbortSignal,
    emit: Emit,
    timeoutMs: number,
  ): Promise<unknown> {
    checkAbort(signal);
    if (this.disconnected)
      throw new Fault('node_disconnected', 'Worker is no longer trusted or connected.', 503);
    const requestId = id('rpc');
    const leaseId = id('lease');
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.cancel(requestId, new Fault('cancelled', 'Worker job cancellation requested.', 409));
      };
      const timer = setTimeout(() => {
        this.cancel(requestId, new Fault('work_timeout', 'Worker exceeded its deadline.', 504));
      }, timeoutMs);
      const lease = setInterval(
        () => {
          if (Date.now() - this.lastSeen > this.leaseMs) {
            this.socket.terminate();
            return;
          }
          try {
            send(this.socket, { type: 'renew', id: requestId, leaseId, leaseMs: this.leaseMs });
          } catch {
            this.socket.terminate();
          }
        },
        Math.max(50, this.leaseMs / 3),
      );
      lease.unref();
      const kind = type === 'execute' ? (payload as Work).kind : 'install';
      this.pending.set(requestId, {
        resolve,
        reject,
        signal,
        abort,
        emit,
        timer,
        lease,
        leaseId,
        kind,
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        send(this.socket, {
          protocol: 'oaa/1',
          type,
          id: requestId,
          leaseId,
          leaseMs: this.leaseMs,
          payload,
        });
      } catch (e) {
        this.cleanup(requestId);
        reject(e);
      }
    });
  }
  async install(bundle: AgentBundle, signal?: AbortSignal): Promise<void> {
    if (signal) checkAbort(signal);
    if (this.advert.warm.includes(bundle.digest)) return;
    const deadline = AbortSignal.timeout(30_000);
    await this.call(
      'install',
      bundle,
      signal ? AbortSignal.any([signal, deadline]) : deadline,
      async () => {},
      30_000,
    );
    this.advert.warm.push(bundle.digest);
  }
  async execute(work: Work, signal: AbortSignal, emit: Emit): Promise<WorkResult> {
    return (await this.call(
      'execute',
      work,
      signal,
      emit,
      work.kind === 'tool' ? work.binding.capability.timeoutMs : work.agent.limits.timeoutMs,
    )) as WorkResult;
  }
  async close(): Promise<void> {
    this.disconnect();
  }
}

type NodeState = {
  credential: NodeCredential;
  executor: Executor;
  active: number;
  averageMs: number;
  successes: number;
  failures: number;
  targets: Map<string, TargetHealth>;
  connectedAt: number;
};
type TargetHealth = {
  averageMs: number;
  successes: number;
  failures: number;
  cooldownUntil: number;
  active: number;
  cancelled: number;
};
export type CandidateReport = {
  node_id: string;
  eligible: boolean;
  available: boolean;
  active: number;
  capacity: number;
  wait_ms: number;
  estimated_ms: number;
  reasons: { code: string; message: string }[];
};
export type AvailabilityReport = {
  available: boolean;
  ready: boolean;
  status: 'ready' | 'degraded' | 'busy' | 'cooling_down' | 'unavailable';
  candidates: CandidateReport[];
  tools: {
    name: string;
    required: boolean;
    available: boolean;
    nodes: string[];
    reasons: { code: string; message: string }[];
  }[];
  toolNames: string[];
  reasons: { code: string; message: string }[];
};
type Job = {
  work: Work;
  bundle: AgentBundle;
  emit: Emit;
  signal: AbortSignal;
  queuedAt: number;
  preferred?: string;
  resolve: (v: { result: WorkResult; nodeId: string; executionMs: number }) => void;
  reject: (e: unknown) => void;
  onStart?: (nodeId: string) => void;
  abort: () => void;
};
export class NodeHub {
  readonly nodes = new Map<string, NodeState>();
  readonly events = new EventEmitter();
  private queue: Job[] = [];
  private served = new Map<string, number>();
  private locks = new Set<string>();
  private closing = false;
  private wakeTimer: NodeJS.Timeout | undefined;
  private wakeAt = Infinity;
  private heartbeatTimer: NodeJS.Timeout;
  private policies = new Map<string, NodePolicy>();
  private peers = new Map<WebSocket, string>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.nodeMessageBytes });
  constructor(
    readonly credentials: NodeCredential[],
    readonly leaseMs = 15_000,
    policies: NodePolicy[] = [],
  ) {
    if (new Set(credentials.map((c) => c.nodeId)).size !== credentials.length)
      throw new Fault(
        'node_credentials_conflict',
        'Node credentials must have unique identities.',
        409,
      );
    for (const policy of policies) {
      const credential = credentials.find((c) => c.nodeId === policy.nodeId);
      if (credential && credential.owner !== policy.owner)
        throw new Fault(
          'node_owner_conflict',
          'A configured node identity is reserved by another owner.',
          409,
        );
      this.policies.set(policy.nodeId, policy);
    }
    this.heartbeatTimer = setInterval(
      () => {
        for (const node of this.nodes.values())
          if (
            node.executor instanceof RemoteExecutor &&
            Date.now() - node.executor.lastSeen > this.leaseMs
          )
            node.executor.socket.terminate();
      },
      Math.max(50, this.leaseMs / 3),
    );
    this.heartbeatTimer.unref();
  }
  addLocal(credential: NodeCredential, executor: Executor): void {
    if (this.policies.has(credential.nodeId))
      throw new Fault(
        'node_identity_reserved',
        'A remote lifecycle policy already reserves this local node ID.',
        409,
      );
    this.register(credential, executor);
  }
  policy(nodeId: string): NodePolicy['state'] {
    return this.policies.get(nodeId)?.state ?? 'active';
  }
  /**
   * Announce a node-state change that happened outside the hub (e.g. a local backend toggle).
   * `change` listeners receive the owner when it is known; undefined means "any owner".
   */
  notifyChange(owner?: string): void {
    this.events.emit('change', owner);
  }
  isLocal(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    return !!node && !(node.executor instanceof RemoteExecutor);
  }
  applyPolicy(policy: NodePolicy) {
    if (this.isLocal(policy.nodeId))
      throw new Fault(
        'local_node_policy',
        'Remote credential controls cannot change the local worker.',
        409,
      );
    this.policies.set(policy.nodeId, policy);
    const node = this.nodes.get(policy.nodeId);
    const affected = node?.active ?? 0;
    if (policy.state === 'revoked') {
      // Remove scheduling authority and ignore future frames before asynchronous socket close.
      this.nodes.delete(policy.nodeId);
      if (node?.executor instanceof RemoteExecutor) node.executor.disconnect();
      for (const [socket, nodeId] of this.peers) if (nodeId === policy.nodeId) socket.terminate();
    }
    this.events.emit('change', policy.owner);
    this.pump();
    return { affected_jobs: affected, disconnected: policy.state === 'revoked' };
  }
  private admissionReasons(nodeId: string): PlacementReason[] {
    const state = this.policy(nodeId);
    return state === 'active'
      ? []
      : [
          {
            code: state === 'draining' ? 'node_draining' : 'node_revoked',
            message: 'The node is not accepting new execution work.',
          },
        ];
  }
  private validateAdvertisement(
    credential: NodeCredential,
    raw: NodeAdvertisement,
  ): NodeAdvertisement {
    const advert = advertisementSchema.parse(raw);
    if (
      advert.nodeId !== credential.nodeId ||
      advert.capabilities.some(
        (c) =>
          !permits(credential.capabilities, c.id) || (c.nodeId && c.nodeId !== credential.nodeId),
      )
    )
      throw new Fault('node_scope_denied', 'Node advertisement exceeds its grant.', 403);
    return advert;
  }
  private register(credential: NodeCredential, executor: Executor): void {
    this.validateAdvertisement(credential, executor.advertisement());
    if (this.nodes.has(credential.nodeId))
      throw new Fault(
        'node_already_connected',
        'A node with this identity is already connected.',
        409,
      );
    this.nodes.set(credential.nodeId, {
      credential,
      executor,
      active: 0,
      averageMs: 0,
      successes: 0,
      failures: 0,
      targets: new Map(),
      connectedAt: Date.now(),
    });
    this.events.emit('change', credential.owner);
    this.pump();
  }
  upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const nodeId = String(req.headers['x-oaa-node-id'] ?? '');
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const credential = this.credentials.find(
      (c) =>
        c.nodeId === nodeId &&
        (c.token.startsWith('sha256:')
          ? safeEqual(c.token.slice(7), sha(token))
          : safeEqual(c.token, token)),
    );
    if (!credential || this.closing || this.policy(nodeId) === 'revoked') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.peers.set(ws, nodeId);
      ws.once('close', () => this.peers.delete(ws));
      const timeout = setTimeout(() => ws.close(1008, 'Handshake timeout'), 5000);
      ws.once('message', (bytes) => {
        clearTimeout(timeout);
        try {
          if (
            this.closing ||
            !this.credentials.includes(credential) ||
            this.policy(nodeId) === 'revoked'
          )
            throw new Error('Node access changed before handshake completion');
          const msg = JSON.parse(bytes.toString());
          if (msg.type !== 'hello' || msg.protocol !== 'oaa/1')
            throw new Error('Protocol mismatch');
          const advert = advertisementSchema.parse({
            ...msg.advertisement,
            ...(msg.execution ? { execution: msg.execution } : {}),
          });
          const executor = new RemoteExecutor(ws, advert, this.leaseMs, (next) => {
            this.validateAdvertisement(credential, next);
            queueMicrotask(() => {
              this.events.emit('change', credential.owner);
              this.pump();
            });
          });
          this.register(credential, executor);
          send(ws, {
            type: 'welcome',
            protocol: 'oaa/1',
            leaseMs: this.leaseMs,
            features: [
              'execution-capabilities-v1',
              'byok-v1',
              'sandbox-v1',
              'provider-turn-v1',
              'client-tools-v1',
              'image-input-v1',
              'model-catalog-v1',
              'agent-policy-v1',
              'tool-free-reasoning-v1',
            ],
          });
          ws.once('close', () => {
            if (this.nodes.get(nodeId)?.executor === executor) this.nodes.delete(nodeId);
            this.events.emit('change', credential.owner);
            this.pump();
          });
        } catch {
          ws.close(1008, 'Invalid or duplicate node');
        }
      });
      ws.once('close', () => clearTimeout(timeout));
      ws.on('error', () => {});
    });
  }
  /**
   * Why a run's current work is still waiting for a node, if it is. Position and `ahead` count
   * only the same owner's queued work; the estimate is a rough hint, not a commitment.
   */
  waiting(
    runId: string,
    owner: string,
  ):
    | {
        position: number;
        ahead: number;
        reason: 'node_busy' | 'cooling_down' | 'unknown';
        estimated_start_ms: number | null;
      }
    | undefined {
    const index = this.queue.findIndex((job) => job.work.context.runId === runId);
    if (index === -1) return undefined;
    const job = this.queue[index]!;
    let ahead = 0;
    for (let i = 0; i < index; i++) if (this.queue[i]!.work.context.owner === owner) ahead++;
    const now = Date.now();
    const target = workTarget(job.work);
    const nodes = [...this.nodes.values()].filter((n) => this.eligible(job, n));
    const cooldown = (n: NodeState) => n.targets.get(target)?.cooldownUntil ?? 0;
    const ready = nodes.filter(
      (n) => cooldown(n) <= now && n.active < n.executor.advertisement().concurrency,
    );
    if (!nodes.length || ready.length)
      return { position: ahead + 1, ahead, reason: 'unknown', estimated_start_ms: null };
    if (nodes.every((n) => cooldown(n) > now))
      return {
        position: ahead + 1,
        ahead,
        reason: 'cooling_down',
        estimated_start_ms: Math.max(0, Math.min(...nodes.map(cooldown)) - now),
      };
    const typical = nodes
      .filter((n) => cooldown(n) <= now)
      .map((n) => {
        const health = n.targets.get(target);
        return health?.successes
          ? Math.max(1, health.averageMs)
          : target.startsWith('tool:')
            ? 50
            : 1000;
      });
    return {
      position: ahead + 1,
      ahead,
      reason: 'node_busy',
      estimated_start_ms: Math.round(Math.min(...typical)),
    };
  }
  inventory(owner: string): Record<string, unknown>[] {
    return [...this.nodes.values()]
      .filter((n) => n.credential.owner === owner)
      .map((n) => ({
        ...n.executor.advertisement(),
        agent_grants: [...n.credential.agents],
        capability_grants: [...n.credential.capabilities],
        active: n.active,
        average_ms: n.averageMs,
        successes: n.successes,
        failures: n.failures,
        targets: [...n.targets].map(([target, h]) => ({ target, ...h })),
        connected_at: n.connectedAt,
        admission_state: this.policy(n.credential.nodeId),
        accepting: this.policy(n.credential.nodeId) === 'active',
        local: !(n.executor instanceof RemoteExecutor),
        drained: this.policy(n.credential.nodeId) === 'draining' && n.active === 0,
      }));
  }
  releaseRun(runId: string): void {
    this.served.delete(runId);
  }
  supports(
    owner: string,
    agent: AgentBundle['agent'],
    provider = agent.provider,
    model = agent.model,
  ): boolean {
    return this.availability(owner, { ...agent, provider, model }).available;
  }
  availability(
    owner: string,
    agent: AgentDefinition,
    files: Pick<FilePayload, 'allowedNodes'>[] = [],
    preferred?: string,
    digest = '',
    byok = false,
    sandbox = false,
    providerState = false,
    clientTools = false,
    images?: ImageMode,
  ): AvailabilityReport {
    const nodes = [...this.nodes.values()].filter(
      (n) => n.credential.owner === owner && permits(n.credential.agents, agent.id),
    );
    const advertisements = new Map(nodes.map((n) => [n, n.executor.advertisement()]));
    const request = { owner, agent, files, preferred, byok, sandbox, providerState, clientTools };
    const placed = { ...request, images };
    const tools = agent.tools.map((binding) => {
      const inspected = nodes.map((n) => ({
        n,
        reasons: [
          ...this.admissionReasons(n.credential.nodeId),
          ...toolPlacement(
            request,
            { credential: n.credential, advertisement: advertisements.get(n)! },
            binding,
          ),
        ],
      }));
      const capable = inspected.filter((x) => !x.reasons.length);
      return {
        name: binding.name,
        required: binding.required === true,
        available: capable.length > 0,
        nodes: capable.map((x) => x.n.credential.nodeId),
        reasons: capable.length ? [] : dedupeReasons(inspected.flatMap((x) => x.reasons)),
      };
    });
    const toolNames = tools.filter((t) => t.available).map((t) => t.name);
    const target = `${agent.engine === 'kernel' ? 'model' : 'native'}:${agent.engine}:${agent.provider}:${agent.model}`;
    const candidates = nodes.map((n) => {
      const advert = advertisements.get(n)!;
      const constraints = [
        ...this.admissionReasons(n.credential.nodeId),
        ...modelPlacement(placed, { credential: n.credential, advertisement: advert }, toolNames),
      ];
      const health = n.targets.get(target);
      const wait = Math.max(0, (health?.cooldownUntil ?? 0) - Date.now());
      const reasons: { code: string; message: string }[] = [...constraints];
      if (wait)
        reasons.push({
          code: 'target_cooling_down',
          message: 'Only this execution target is cooling down after upstream throttling.',
        });
      if (n.active >= advert.concurrency)
        reasons.push({
          code: 'node_busy',
          message: 'All worker slots are occupied; accepted work will queue.',
        });
      return {
        node_id: n.credential.nodeId,
        eligible: constraints.length === 0,
        available: constraints.length === 0 && wait === 0,
        active: n.active,
        capacity: advert.concurrency,
        wait_ms: wait,
        estimated_ms: this.estimate(
          n,
          target,
          digest,
          files.reduce(
            (sum, f) =>
              sum +
              ('content' in f && typeof f.content === 'string'
                ? f.content.length
                : 'bytes' in f && typeof f.bytes === 'number'
                  ? Math.ceil(f.bytes / 3) * 4
                  : 0),
            0,
          ),
          advert,
        ),
        reasons,
      };
    });
    candidates.sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        a.estimated_ms - b.estimated_ms ||
        a.node_id.localeCompare(b.node_id),
    );
    const missingRequired = tools.filter((t) => t.required && !t.available);
    const available = !missingRequired.length && candidates.some((c) => c.available);
    const reasons = dedupeReasons([
      ...(nodes.length
        ? []
        : [{ code: 'no_online_nodes', message: 'No authorized worker is online.' }]),
      ...(!candidates.some((c) => c.available) ? candidates.flatMap((c) => c.reasons) : []),
      ...missingRequired.map((t) => ({
        code: 'required_tool_unavailable',
        message: `Required tool ${t.name} has no eligible executor.`,
      })),
    ]);
    const missingOptional = tools.some((t) => !t.required && !t.available);
    const status: AvailabilityReport['status'] = !available
      ? candidates.some((c) => c.eligible && c.wait_ms > 0) && !missingRequired.length
        ? 'cooling_down'
        : 'unavailable'
      : missingOptional
        ? 'degraded'
        : candidates.every((c) => !c.available || c.active >= c.capacity)
          ? 'busy'
          : 'ready';
    return {
      available,
      ready: available && !missingOptional,
      status,
      candidates,
      tools,
      toolNames,
      reasons,
    };
  }
  private eligible(job: Job, node: NodeState, allowDraining = false): boolean {
    const state = this.policy(node.credential.nodeId);
    if (state !== 'active' && !(allowDraining && state === 'draining')) return false;
    return (
      workPlacement(
        job.work,
        job.bundle.agent,
        { credential: node.credential, advertisement: node.executor.advertisement() },
        job.preferred,
      ).length === 0
    );
  }
  execute(
    work: Work,
    bundle: AgentBundle,
    signal: AbortSignal,
    emit: Emit,
    options: { preferred?: string; onStart?: (nodeId: string) => void } = {},
  ): Promise<{ result: WorkResult; nodeId: string; executionMs: number }> {
    checkAbort(signal);
    if (this.closing) throw new Fault('shutting_down', 'Gateway is shutting down.', 503);
    if (this.queue.length >= LIMITS.nodeQueueLength)
      throw new Fault('queue_full', 'Node queue is full.', 429);
    return new Promise((resolve, reject) => {
      const job: Job = {
        work,
        bundle,
        emit,
        signal,
        resolve,
        reject,
        queuedAt: Date.now(),
        ...options,
        abort: () => {
          this.queue = this.queue.filter((j) => j !== job);
          signal.removeEventListener('abort', job.abort);
          reject(new Fault('cancelled', 'Queued work cancelled.', 409));
        },
      };
      signal.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  private pump(): void {
    if (this.closing) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = Infinity;
    this.queue.sort(
      (a, b) =>
        (this.served.get(a.work.context.runId) ?? 0) -
        (Date.now() - a.queuedAt) / 1000 -
        ((this.served.get(b.work.context.runId) ?? 0) - (Date.now() - b.queuedAt) / 1000),
    );
    for (const job of [...this.queue]) {
      if (job.signal.aborted) {
        job.abort();
        continue;
      }
      const candidates = [...this.nodes.values()].filter((n) => this.eligible(job, n));
      if (!candidates.length) {
        const draining = [...this.nodes.values()].some(
          (n) => this.policy(n.credential.nodeId) === 'draining' && this.eligible(job, n, true),
        );
        this.queue = this.queue.filter((j) => j !== job);
        job.signal.removeEventListener('abort', job.abort);
        job.reject(
          new Fault(
            draining ? 'node_draining' : 'capability_unavailable',
            draining
              ? 'An otherwise eligible node is draining. Restore capacity before explicitly resuming this checkpoint.'
              : 'No authorized online node satisfies the model, capability, and data-placement requirements.',
            503,
          ),
        );
        continue;
      }
      const lock =
        job.work.kind === 'tool' && job.work.binding.capability.effect !== 'read'
          ? `${job.work.context.owner}:${job.work.binding.capability.resourceKey ?? job.work.binding.capability.id}`
          : undefined;
      if (lock && this.locks.has(lock)) continue;
      const available = candidates.filter(
        (n) =>
          n.active < n.executor.advertisement().concurrency &&
          (n.targets.get(workTarget(job.work))?.cooldownUntil ?? 0) <= Date.now(),
      );
      if (!available.length) {
        for (const n of candidates) {
          const until = n.targets.get(workTarget(job.work))?.cooldownUntil ?? 0;
          if (until > Date.now()) this.wakeAt = Math.min(this.wakeAt, until);
        }
        continue;
      }
      available.sort((a, b) => this.score(job, a) - this.score(job, b));
      const node = available[0]!;
      this.queue = this.queue.filter((j) => j !== job);
      job.signal.removeEventListener('abort', job.abort);
      node.active++;
      const health = this.targetHealth(node, workTarget(job.work));
      health.active++;
      if (lock) this.locks.add(lock);
      this.served.set(job.work.context.runId, (this.served.get(job.work.context.runId) ?? 0) + 1);
      this.events.emit('change', node.credential.owner);
      void this.dispatch(job, node).finally(() => {
        node.active--;
        health.active--;
        if (lock) this.locks.delete(lock);
        this.events.emit('change', node.credential.owner);
        this.pump();
      });
    }
    if (this.queue.length && Number.isFinite(this.wakeAt)) {
      // coarseDelay: see util.ts (an unref'd timer re-armed with exact durations leaks).
      this.wakeTimer = setTimeout(() => this.pump(), coarseDelay(this.wakeAt - Date.now() + 1));
      this.wakeTimer.unref();
    }
  }
  private targetHealth(node: NodeState, key: string): TargetHealth {
    let health = node.targets.get(key);
    if (!health) {
      health = {
        averageMs: 0,
        successes: 0,
        failures: 0,
        cooldownUntil: 0,
        active: 0,
        cancelled: 0,
      };
      node.targets.set(key, health);
    }
    return health;
  }
  private estimate(
    node: NodeState,
    target: string,
    digest: string,
    bytes: number,
    advert = node.executor.advertisement(),
  ): number {
    const baseline = target.startsWith('tool:') ? 50 : 1000;
    const own = node.targets.get(target);
    const execution = own?.successes ? Math.max(1, own.averageMs) : baseline;
    const queued =
      [...node.targets].reduce(
        (sum, [key, h]) =>
          sum +
          h.active * (h.successes ? Math.max(1, h.averageMs) : key.startsWith('tool:') ? 50 : 1000),
        0,
      ) / advert.concurrency;
    return execution + queued + (advert.warm.includes(digest) ? 0 : 25) + bytes / 100_000;
  }
  private score(job: Job, node: NodeState): number {
    return this.estimate(
      node,
      workTarget(job.work),
      job.bundle.digest,
      job.work.context.files.reduce((sum, f) => sum + f.content.length, 0),
    );
  }
  private async dispatch(job: Job, node: NodeState): Promise<void> {
    const start = Date.now();
    let started = false;
    const health = this.targetHealth(node, workTarget(job.work));
    let executionStart = Date.now();
    let executionDeadline: AbortSignal | undefined;
    try {
      if (this.policy(node.credential.nodeId) !== 'active')
        throw new Fault(
          this.policy(node.credential.nodeId) === 'draining'
            ? 'node_draining'
            : 'node_disconnected',
          'Node stopped accepting work before preparation.',
          503,
        );
      await node.executor.install(job.bundle, job.signal);
      checkAbort(job.signal);
      if (this.policy(node.credential.nodeId) !== 'active')
        throw new Fault(
          this.policy(node.credential.nodeId) === 'draining'
            ? 'node_draining'
            : 'node_disconnected',
          'Node stopped accepting work before execution.',
          503,
        );
      job.onStart?.(node.credential.nodeId);
      started = true;
      executionStart = Date.now();
      // A clearable timer: AbortSignal.timeout would keep every finished job alive until its
      // (default 30-minute) deadline fired.
      const timer = deadlineTimer(
        job.work.kind === 'tool'
          ? job.work.binding.capability.timeoutMs
          : job.work.agent.limits.timeoutMs,
      );
      executionDeadline = timer.signal;
      const result = await node.executor
        .execute(job.work, AbortSignal.any([job.signal, executionDeadline]), job.emit)
        .finally(timer.clear);
      node.successes++;
      const executionMs = Date.now() - executionStart;
      health.successes++;
      health.averageMs = health.averageMs
        ? health.averageMs * 0.8 + executionMs * 0.2
        : executionMs;
      if (health.cooldownUntil <= Date.now()) health.cooldownUntil = 0;
      node.averageMs = node.averageMs
        ? node.averageMs * 0.8 + (Date.now() - start) * 0.2
        : Date.now() - start;
      job.resolve({ result, nodeId: node.credential.nodeId, executionMs });
    } catch (error) {
      const fault =
        executionDeadline?.aborted && !job.signal.aborted
          ? new Fault('work_timeout', 'Execution exceeded its deadline.', 504)
          : faultOf(error);
      if (fault.code === 'cancelled' && job.signal.aborted) health.cancelled++;
      else {
        node.failures++;
        health.failures++;
      }
      if (fault.code === 'upstream_rate_limited') {
        health.cooldownUntil = Date.now() + 5000;
      }
      if (
        started &&
        (job.work.kind === 'native' ||
          (job.work.kind === 'tool' &&
            ['write', 'unknown'].includes(job.work.binding.capability.effect))) &&
        isUncertainWhenStarted(fault.code)
      )
        fault.uncertain = true;
      job.reject(fault);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.wakeTimer);
    for (const j of [...this.queue]) j.abort();
    for (const n of this.nodes.values()) await n.executor.close();
    for (const socket of this.peers.keys()) socket.terminate();
    this.peers.clear();
    this.nodes.clear();
    this.wss.close();
  }
}
function dedupeReasons(
  reasons: { code: string; message: string }[],
): { code: string; message: string }[] {
  return [...new Map(reasons.map((r) => [`${r.code}:${r.message}`, r])).values()];
}

export async function connectWorker(
  config: WorkerConfig,
  stop: AbortSignal,
  runtime = new WorkerRuntime(config),
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
/** Answer when an approval or caller-tool event cannot reach a decision (cancelled, ended). */
const noAnswer = (event: WorkEvent) =>
  event.type === 'approval'
    ? { decision: 'deny' }
    : event.type === 'client_tool'
      ? { error: 'The caller tool call was interrupted.' }
      : undefined;
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
    handshakeTimeout: 5000,
  });
  const jobs = new Map<string, WorkerJob>();
  const running = new Set<Promise<void>>();
  let ended = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let heartbeat: NodeJS.Timeout | undefined;
      let lastAck = Date.now();
      let leaseMs = 15_000;
      const abort = () => {
        ended = true;
        ws.close();
      };
      stop.addEventListener('abort', abort, { once: true });
      let metadataUpdates = false;
      let welcomed = false;
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
            leaseMs = msg.leaseMs;
            lastAck = Date.now();
            metadataUpdates =
              Array.isArray(msg.features) && msg.features.includes('execution-capabilities-v1');
            const features: unknown[] = Array.isArray(msg.features) ? msg.features : [];
            negotiated.byok = metadataUpdates && features.includes('byok-v1');
            negotiated.sandbox = metadataUpdates && features.includes('sandbox-v1');
            negotiated.providerState = metadataUpdates && features.includes('provider-turn-v1');
            negotiated.clientTools = metadataUpdates && features.includes('client-tools-v1');
            negotiated.imageInput = metadataUpdates && features.includes('image-input-v1');
            negotiated.modelCatalogs = metadataUpdates && features.includes('model-catalog-v1');
            negotiated.agentPolicy = metadataUpdates && features.includes('agent-policy-v1');
            negotiated.toolFreeReasoning =
              metadataUpdates && features.includes('tool-free-reasoning-v1');
            // The hello omitted newer metadata (an older gateway would reject it); report it now.
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
              send(ws, { type: 'result', id: msg.id, leaseId: job.leaseId, result });
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
    ws.terminate();
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.controller.abort();
    }
    // Reusing this runtime or closing its clients before old work exits would oversubscribe it.
    await Promise.allSettled(running);
  }
}
