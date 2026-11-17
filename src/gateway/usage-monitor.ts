import path from 'node:path';
import {
  UsageConfiguration,
  usageCollectorPath,
  defaultQuotaCache,
} from '../config/usage-monitor.js';
import type { UsageSettings, CollectedUsage } from '../core/usage-monitor.js';
import { collectUsageSource, type UsageSourceState } from '../engines/usage-collectors.js';
import { parseCodexBar, parseCcusage } from '../engines/usage-parsers.js';
import { canonical, Fault, sha } from '../core/util.js';

const initial = (): UsageSourceState => ({
  status: 'disabled',
  updated_at: null,
  error: null,
  data: null,
});
export class UsageMonitor {
  onChange?: () => void;
  readonly ready: Promise<void>;
  readonly config: UsageConfiguration;
  private settings!: UsageSettings;
  private sources = { codexbar: initial(), ccusage: initial() };
  private controller = new AbortController();
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private lastAttempt = 0;
  private closed = false;
  private control: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.config = new UsageConfiguration(dataDir);
    this.ready = this.config.read().then((settings) => {
      this.settings = settings;
      this.schedule();
    });
    void this.ready.then(() => this.refresh()).catch(() => {});
  }
  private schedule() {
    clearInterval(this.timer);
    for (const key of ['codexbar', 'ccusage'] as const)
      if (!this.settings[key].enabled) this.sources[key] = initial();
      else if (this.sources[key].status === 'disabled') this.sources[key].status = 'unavailable';
    if (!this.closed && (this.settings.codexbar.enabled || this.settings.ccusage.enabled))
      this.timer = setInterval(() => void this.refresh().catch(() => {}), 300_000).unref();
  }
  async configure(value: unknown, revision: string, revalidate: () => void = () => {}) {
    await this.ready;
    const work = this.control
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Fault('shutting_down', 'Usage monitor is closed.', 503);
        if (revision !== sha(canonical(this.settings)))
          throw new Fault(
            'version_conflict',
            'Usage settings changed. Refresh before saving.',
            409,
          );
        this.controller.abort();
        await this.pending?.catch(() => {});
        try {
          if (this.closed) throw new Fault('shutting_down', 'Usage monitor is closed.', 503);
          revalidate();
          this.settings = await this.config.write(value);
        } finally {
          this.controller = new AbortController();
        }
        this.lastAttempt = 0;
        this.sources = { codexbar: initial(), ccusage: initial() };
        this.schedule();
        this.onChange?.();
        return this.view();
      });
    this.control = work;
    return work;
  }
  async view() {
    await this.ready;
    const sources = structuredClone(this.sources),
      now = Date.now();
    for (const source of Object.values(sources))
      for (const account of source.data?.accounts ?? []) {
        if (
          account.status !== 'unavailable' &&
          ((source.error &&
            (!source.failed_providers || source.failed_providers.includes(account.provider))) ||
            account.observed_at === null ||
            now - account.observed_at > 900_000 ||
            account.windows.some((w) => w.resets_at !== null && w.resets_at <= now))
        )
          account.status = 'stale';
        const failed =
          !!source.error &&
          (!source.failed_providers || source.failed_providers.includes(account.provider));
        for (const point of [account.balance, account.budget])
          if (point && (failed || point.observed_at === null || now - point.observed_at > 900_000))
            point.stale = true;
        if (
          account.budget?.resets_at !== null &&
          account.budget?.resets_at !== undefined &&
          account.budget.resets_at <= now
        )
          account.budget.stale = true;
      }
    return {
      settings: structuredClone(this.settings),
      revision: sha(canonical(this.settings)),
      sources,
      available: {
        codexbar: usageCollectorPath('codexbar'),
        ccusage: usageCollectorPath('ccusage'),
      },
      quota_cache: defaultQuotaCache(),
      refresh_seconds: 300,
    };
  }
  async refresh() {
    await this.ready;
    if (this.closed) return;
    if (this.pending) return this.pending;
    if (Date.now() - this.lastAttempt < 30_000) return;
    this.lastAttempt = Date.now();
    const settings = this.settings,
      signal = this.controller.signal;
    const work = async () => {
      for (const source of ['codexbar', 'ccusage'] as const) {
        if (!settings[source].enabled || signal.aborted) continue;
        try {
          const data = await collectUsageSource(
            source,
            settings,
            path.join(this.config.directory, 'collector'),
            signal,
          );
          if (signal.aborted) return;
          const failed = data.accounts
            .filter((a) => a.status === 'unavailable')
            .map((a) => a.provider);
          const previous = this.sources[source].data;
          if (source === 'codexbar' && previous)
            data.accounts = data.accounts.flatMap((account) => {
              if (account.status !== 'unavailable') return [account];
              const old = previous.accounts.filter(
                (a) => a.provider === account.provider && a.status !== 'unavailable',
              );
              return old.length ? old.map((a) => ({ ...a, status: 'stale' as const })) : [account];
            });
          this.sources[source] = {
            status:
              failed.length || data.partial
                ? 'error'
                : source === 'codexbar' && !data.accounts.some((a) => a.status !== 'unavailable')
                  ? 'unavailable'
                  : 'ready',
            updated_at: Date.now(),
            error: failed.length || data.partial ? 'process_failed' : null,
            ...(failed.length ? { failed_providers: failed } : {}),
            data,
          };
        } catch {
          if (signal.aborted) return;
          this.sources[source] = {
            ...this.sources[source],
            status: 'error',
            error: 'process_failed',
            failed_providers: undefined,
          };
        }
      }
    };
    this.pending = work().finally(() => {
      this.pending = undefined;
      this.onChange?.();
    });
    return this.pending;
  }
  async import(source: 'codexbar' | 'ccusage', value: unknown) {
    await this.ready;
    const data: CollectedUsage = source === 'codexbar' ? parseCodexBar(value) : parseCcusage(value);
    this.sources[source] = { status: 'ready', updated_at: Date.now(), error: null, data };
    this.onChange?.();
    return this.view();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller.abort();
    await this.pending?.catch(() => {});
  }
}
