import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { gatewaySchema, workerSchema, type GatewayConfig } from '../config/config.js';
import { discoverAcpAgents, discoveredAdapterEntry } from '../config/agent-presets.js';
import { WorkerRuntime, type Executor } from '../fabric/worker.js';
import type { Store } from '../store/store.js';
import type { Auth } from './auth.js';
import type { NodeHub } from '../fabric/network.js';
import type { Catalog } from './catalog.js';
import type { Principal } from '../core/contracts.js';
import { bi, requestLocale } from '../core/locale.js';
import { Fault, writePrivate } from '../core/util.js';
import { providerStatuses } from '../providers/provider-status.js';
import {
  checkLocalBackend,
  listLocalBackends,
  presetCatalog,
  setLocalBackend,
  parseBackendEngine,
  type HandshakeRecord,
} from '../fabric/local-backends.js';

/**
 * 本机智能体的管理接口：列出、开关、握手检查，以及一键启用已安装的预设。
 * 这些都是 owner 管理员的显式操作；网关不会自己发现后自动启用，也不会调用模型。
 */
export function registerLocalBackendRoutes(
  app: FastifyInstance,
  context: {
    auth: Auth;
    config: GatewayConfig;
    store: Store;
    hub: NodeHub;
    catalog: Catalog;
    handshakes: Map<string, HandshakeRecord>;
    localExecutor?: Executor;
    /** 网关配置文件路径；提供后，一键启用会把新增条目写回该文件。 */
    configFile?: string;
  },
): void {
  const { auth, config, store, hub, catalog, handshakes, localExecutor } = context;
  const options = { configFile: context.configFile };
  if (localExecutor instanceof WorkerRuntime) {
    let projectRevision = JSON.stringify(localExecutor.projects.advertised());
    localExecutor.projects.onChange = () => {
      const next = JSON.stringify(localExecutor.projects.advertised());
      if (next === projectRevision) return;
      projectRevision = next;
      hub.notifyChange(config.localWorker!.owner);
      catalog.invalidate();
    };
    void localExecutor.projects.ready.then(() => localExecutor.projects.onChange?.());
  }
  if (localExecutor instanceof WorkerRuntime)
    localExecutor.modelCatalogs.onChange = () => {
      hub.notifyChange(config.localWorker!.owner);
      catalog.invalidate();
    };
  if (localExecutor instanceof WorkerRuntime && config.localWorker) {
    const engines = new Set(
      store
        .agentDefinitions(config.localWorker.owner, ['*'])
        .filter(
          (b) =>
            b.agent.modelPolicy?.mode === 'discover' ||
            (b.agent.engine === 'antigravity' && b.agent.access),
        )
        .map((b) => b.agent.engine),
    );
    for (const engine of engines) void localExecutor.modelCatalogs.refresh(engine).catch(() => {});
  }
  app.get('/v1/local/backends', async (req) => {
    auth.requireNodeAdmin(req.principal);
    // 预设说明按请求的语言（Accept-Language，缺省为进程默认语言）。
    const locale = requestLocale(req.headers['accept-language']);
    if (!config.localWorker || config.localWorker.owner !== req.principal.owner)
      return { data: [], presets: await presetCatalog(undefined, locale) };
    return {
      data: listLocalBackends(config.localWorker, handshakes).map((backend) => ({
        ...backend,
        ...(localExecutor instanceof WorkerRuntime
          ? { model_catalog: localExecutor.modelCatalogs.snapshot()[String(backend.engine)] }
          : {}),
      })),
      presets: await presetCatalog(config.localWorker, locale),
      // Model providers of the built-in kernel, as this gateway process sees them (no keys).
      providers: providerStatuses(config.localWorker),
    };
  });
  const localBackendOwner = (principal: Principal) => {
    auth.require(principal, 'admin');
    if (
      !principal.agents.includes('*') ||
      !config.localWorker ||
      config.localWorker.owner !== principal.owner
    )
      throw new Fault('scope_denied', 'Host adapter management requires the owner admin key.', 403);
    return config.localWorker;
  };
  const toggleLocalBackend = async (req: FastifyRequest, engine: string) => {
    const worker = localBackendOwner(req.principal);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const result = await setLocalBackend(
      store.db,
      req.principal.owner,
      worker,
      localExecutor,
      engine,
      enabled,
    );
    hub.notifyChange(req.principal.owner);
    catalog.invalidate();
    return result;
  };
  app.get('/v1/local/backends/:engine/models', async (req) => {
    localBackendOwner(req.principal);
    const engine = parseBackendEngine((req.params as { engine: string }).engine).engine;
    if (!(localExecutor instanceof WorkerRuntime))
      throw new Fault('worker_required', 'A local worker is required.', 409);
    const force = (req.query as { refresh?: string }).refresh === 'true';
    return localExecutor.modelCatalogs.refresh(engine, force);
  });
  app.get('/v1/local/projects', async (req) => {
    localBackendOwner(req.principal);
    if (!(localExecutor instanceof WorkerRuntime))
      throw new Fault('worker_required', 'A local worker is required.', 409);
    return { data: await localExecutor.projects.list() };
  });
  app.post('/v1/local/projects', async (req) => {
    localBackendOwner(req.principal);
    const body = z
      .object({
        agent: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/),
        path: z.string().max(4096).nullable(),
      })
      .strict()
      .parse(req.body);
    if (!(localExecutor instanceof WorkerRuntime))
      throw new Fault('worker_required', 'A local worker is required.', 409);
    await localExecutor.projects.bind(
      body.agent,
      body.path,
      () =>
        Number(
          store
            .prepare(
              "SELECT count(*) AS n FROM runs WHERE owner=? AND agent_id=? AND status IN ('queued','in_progress','requires_action')",
            )
            .get(req.principal.owner, body.agent)!.n,
        ) === 0,
    );
    return { agent: body.agent, bound: body.path !== null };
  });
  // `:engine` is a native name or a URL-encoded `adapter%2F<name>`; the unencoded form is also accepted.
  app.post('/v1/local/backends/:engine', async (req) =>
    toggleLocalBackend(req, (req.params as { engine: string }).engine),
  );
  app.post('/v1/local/backends/adapter/:name', async (req) =>
    toggleLocalBackend(req, `adapter/${(req.params as { name: string }).name}`),
  );
  // 一键启用已安装的智能体：把「写入配置 → 重启 → 打开开关」合成一步，且不需要重启。
  // 仍然是 owner 管理员的显式操作；不会自动发现后自动启用，也不执行任何模型调用。
  app.post('/v1/local/presets/:id/enable', async (req) => {
    const worker = localBackendOwner(req.principal);
    const id = z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .parse((req.params as { id: string }).id);
    let name = Object.entries(worker.adapters).find(
      ([key, a]) => a.transport === 'acp' && (a.preset ?? key) === id,
    )?.[0];
    let configured: 'existing' | 'added' = 'existing';
    let persisted = false;
    if (!name) {
      if (Object.hasOwn(worker.adapters, id))
        throw new Fault(
          'backend_conflict',
          bi(
            '本机配置里已经有一个同名但不同类型的适配器，无法自动添加。请先在配置文件里改名或删除它。',
            'The local configuration already has a different kind of adapter with this name, so it cannot be added automatically. Rename or remove it in the configuration file first.',
          ),
          409,
        );
      const found = (await discoverAcpAgents()).find((f) => f.preset.id === id);
      if (!found)
        throw new Fault(
          'backend_unavailable',
          bi(
            '这台电脑上没有找到这个智能体的程序。请先安装它，然后再回来启用。',
            "This agent's program was not found on this computer. Install it first, then come back to enable it.",
          ),
          409,
        );
      const raw = discoveredAdapterEntry(found);
      const entry = workerSchema.shape.adapters.parse({ [id]: raw })[id]!;
      if (options.configFile) {
        // 与 `oaa doctor --write` 相同：以停用状态写入配置文件，启用状态记在数据库里。
        const file = JSON.parse(await readFile(options.configFile, 'utf8')) as {
          localWorker?: { adapters?: Record<string, unknown> };
        };
        if (!file.localWorker)
          throw new Fault(
            'worker_required',
            bi(
              '配置文件里没有本机执行机器（localWorker），无法添加智能体。',
              'The configuration file has no local worker (localWorker), so the agent cannot be added.',
            ),
            409,
          );
        const adapters = (file.localWorker.adapters ??= {});
        if (!Object.hasOwn(adapters, id)) {
          adapters[id] = raw;
          gatewaySchema.parse(file);
          await writePrivate(
            path.dirname(options.configFile),
            path.basename(options.configFile),
            JSON.stringify(file, null, 2) + '\n',
          );
        }
        persisted = true;
      }
      worker.adapters[id] = entry;
      if (
        localExecutor instanceof WorkerRuntime &&
        localExecutor.config !== worker &&
        !localExecutor.config.adapters[id]
      )
        localExecutor.config.adapters[id] = { ...entry };
      name = id;
      configured = 'added';
    }
    const result = await setLocalBackend(
      store.db,
      req.principal.owner,
      worker,
      localExecutor,
      `adapter/${name}`,
      true,
    );
    hub.notifyChange(req.principal.owner);
    catalog.invalidate();
    return { ...result, preset: id, configured, persisted };
  });
  const checkBackend = async (req: FastifyRequest, engine: string) =>
    checkLocalBackend(localBackendOwner(req.principal), engine, handshakes);
  app.post('/v1/local/backends/:engine/check', async (req) =>
    checkBackend(req, (req.params as { engine: string }).engine),
  );
  app.post('/v1/local/backends/adapter/:name/check', async (req) =>
    checkBackend(req, `adapter/${(req.params as { name: string }).name}`),
  );
}
