import https from 'node:https';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Fault, canonical, sha, faultOf } from '../core/util.js';
import {
  sourceConfigSchema,
  type SourceConfig,
  type ModelFacts,
  type SourceReport,
} from '../core/model-sources.js';
import { ModelSources } from '../store/model-sources.js';
import type { Store } from '../store/store.js';
import type { Kernel } from '../kernel/kernel.js';
import { discoveredAgent } from '../fabric/model-pool.js';
import { extractPointerValue } from '../lang/graph.js';
import { checkedLookup } from './checked-lookup.js';
import { checkWebhookUrl } from './webhook-core.js';

const policy = { profile: 'public' as const, allowInsecureHttp: false, allowPrivateNetwork: false };
export function publicSourceURL(value: string) {
  const url = checkWebhookUrl(value, policy);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.search || url.hash)
    throw new Fault(
      'invalid_request',
      'Public model sources require credential-free HTTPS on port 443, without query strings or fragments.',
    );
  return url;
}
export function modelSourceFacts(
  source: SourceConfig['sources'][number],
  json: unknown,
): ModelFacts {
  let value = json;
  if (source.selector) {
    const rows = extractPointerValue(json, source.selector.collection);
    if (!Array.isArray(rows))
      throw new Fault('invalid_request', 'The configured model source collection is not an array.');
    value = rows.find((row) => {
      try {
        return extractPointerValue(row, source.selector!.id) === source.selector!.value;
      } catch {
        return false;
      }
    });
    if (value === undefined)
      throw new Fault('invalid_request', 'The requested model was not found in the public source.');
  }
  const facts: ModelFacts = {};
  for (const key of Object.keys(source.fields) as (keyof ModelFacts)[]) {
    let raw: unknown;
    try {
      raw = extractPointerValue(value, source.fields[key]);
    } catch {
      continue;
    }
    if (key === 'supportsImages') {
      if (typeof raw === 'boolean') facts[key] = raw;
      continue;
    }
    if (typeof raw === 'string' && raw.length < 64 && /^\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(raw))
      raw = Number(raw);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue;
    const numeric = raw * (key === 'contextWindow' ? 1 : source.priceScale);
    if (key === 'contextWindow') {
      if (Number.isInteger(numeric) && numeric > 0 && numeric <= 10000000)
        facts.contextWindow = numeric;
    } else if (numeric <= 1000000) facts[key] = numeric;
  }
  if (!Object.keys(facts).length)
    throw new Fault(
      'invalid_request',
      'No supported numeric or boolean facts were found. Arbitrary source text is never added to planning prompts.',
    );
  return facts;
}
export function fetchPublicModelSource(value: string, signal: AbortSignal): Promise<unknown> {
  const url = publicSourceURL(value);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        lookup: checkedLookup(policy),
        signal,
        agent: false,
        headers: {
          accept: 'application/json,text/plain',
          'accept-encoding': 'identity',
          'user-agent': 'Open-Agent-API-ModelSources',
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          response.resume();
          reject(
            new Fault(
              'upstream_failed',
              'Model source returned a redirect, error or unsupported encoding.',
              502,
            ),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 262144)
            request.destroy(
              new Fault('upstream_failed', 'Public model source exceeded 256KB.', 502),
            );
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
            );
          } catch {
            reject(
              new Fault('upstream_failed', 'Public model sources must be bounded UTF-8 JSON.', 502),
            );
          }
        });
        response.on('error', reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Fault('upstream_failed', 'Public model source timed out.', 502)),
      10000,
    );
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}
export function registerModelSources(
  app: FastifyInstance,
  store: Store,
  kernel: Kernel,
  guard: (request: FastifyRequest) => void,
  enabled: boolean,
  collectorOwner?: string,
) {
  const records = new ModelSources(store),
    pending = new Map<string, Promise<void>>(),
    controllers = new Set<AbortController>();
  let closed = false,
    activeKey = '';
  const parameters = z.object({
    agent: z.string().min(1).max(120),
    route: z.string().min(1).max(200),
  });
  const verify = (owner: string, agent: string, route: string) => {
    const definition = discoveredAgent(kernel.hub, owner, store.bundle(owner, agent).agent);
    const choice = kernel.router.choices(definition).find((r) => r.id === route);
    if (!choice) throw new Fault('invalid_request', 'Unknown model route for public sources.');
    if (choice.model === 'default')
      throw new Fault(
        'invalid_request',
        'Public model facts require a concrete backend model, not an unresolved default.',
      );
    return choice;
  };
  const view = (owner: string, agent: string, route: string) => {
    const value = records.get(owner, agent, route);
    return {
      ...value,
      revision: sha(canonical(value.settings)),
      running: pending.has(`${owner}\n${agent}\n${route}`),
    };
  };
  const refresh = (owner: string, agent: string, route: string): Promise<void> => {
    const key = `${owner}\n${agent}\n${route}`;
    if (pending.has(key)) return pending.get(key)!;
    if (!enabled || closed)
      return Promise.reject(
        new Fault('scope_denied', 'Public source collection is disabled.', 403),
      );
    if (pending.size)
      return Promise.reject(
        new Fault('concurrency_limit', 'Another public model source refresh is running.', 429),
      );
    const work = (async () => {
      activeKey = key;
      const initial = records.get(owner, agent, route);
      if (!initial.settings.enabled)
        throw new Fault('scope_denied', 'Enable source collection before fetching.', 403);
      const revision = sha(canonical(initial.settings));
      const reports: SourceReport[] = [];
      for (const source of initial.settings.sources) {
        if (closed || sha(canonical(records.get(owner, agent, route).settings)) !== revision) break;
        const controller = new AbortController();
        controllers.add(controller);
        try {
          reports.push({
            url: source.url,
            facts: modelSourceFacts(
              source,
              await fetchPublicModelSource(source.url, controller.signal),
            ),
            fetchedAt: Date.now(),
          });
        } catch (error) {
          reports.push({
            ...initial.reports.find((r) => r.url === source.url),
            url: source.url,
            error: faultOf(error).code,
          });
        } finally {
          controllers.delete(controller);
        }
      }
      const current = records.get(owner, agent, route);
      if (sha(canonical(current.settings)) === revision && !closed)
        records.save({ ...current, reports, lastAttempt: Date.now() });
    })().finally(() => {
      pending.delete(key);
      if (activeKey === key) activeKey = '';
    });
    pending.set(key, work);
    return work;
  };
  kernel.router.knowledge = (owner, agent, route, model) =>
    records.knowledge(owner, agent, route, model);
  const timer = setInterval(() => {
    if (!enabled || closed || pending.size || kernel.stats().active || kernel.stats().queued)
      return;
    const due = records
      .enabled()
      .find(
        (r) =>
          (!collectorOwner || r.owner === collectorOwner) && Date.now() - r.lastAttempt >= 86400000,
      );
    if (due) void refresh(due.owner, due.agent, due.route).catch(() => {});
  }, 60000).unref();
  app.addHook('preClose', async () => {
    closed = true;
    clearInterval(timer);
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending.values());
    kernel.router.knowledge = undefined;
  });
  app.get('/v1/local/evaluations/sources', async (request) => {
    guard(request);
    const body = parameters.strict().parse(request.query);
    verify(request.principal.owner, body.agent, body.route);
    return view(request.principal.owner, body.agent, body.route);
  });
  app.post('/v1/local/evaluations/sources', async (request) => {
    guard(request);
    const body = parameters
      .extend({ settings: sourceConfigSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.body);
    const choice = verify(request.principal.owner, body.agent, body.route);
    for (const source of body.settings.sources) publicSourceURL(source.url);
    records.configure(
      request.principal.owner,
      body.agent,
      body.route,
      body.settings,
      body.revision,
      choice.model,
    );
    if (
      !body.settings.enabled &&
      activeKey === `${request.principal.owner}\n${body.agent}\n${body.route}`
    )
      for (const controller of controllers) controller.abort();
    return view(request.principal.owner, body.agent, body.route);
  });
  app.post('/v1/local/evaluations/sources/refresh', async (request) => {
    guard(request);
    const body = parameters.strict().parse(request.body);
    verify(request.principal.owner, body.agent, body.route);
    await refresh(request.principal.owner, body.agent, body.route);
    guard(request);
    return view(request.principal.owner, body.agent, body.route);
  });
}
