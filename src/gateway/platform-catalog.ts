/**
 * 开发者平台：上架项的视图（控制台的上架列表、门户的目录）与「账号密钥能不能调」的判断。
 */
import type { WorkerConfig } from '../config/config.js';
import { Fault } from '../core/util.js';
import { conversionProfile } from '../engines/conformance.js';
import type { Store } from '../store/store.js';
import { hostRefusal, listingAccess, type ListingAccess } from './platform-access.js';
import { toPoints } from './platform-db.js';
import type { ListingRecord, PlatformListings } from './platform-listings.js';
import type { ListedAgentView, ListingView, Price } from './platform-types.js';

export class ListingCatalog {
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    private readonly listings: PlatformListings,
    private readonly level: 'workspace' | 'sandbox',
    private readonly worker?: WorkerConfig,
  ) {}
  agentExists(agentId: string): boolean {
    try {
      this.store.bundle(this.owner, agentId);
      return true;
    } catch {
      return false;
    }
  }
  /** Access of a listing as if its own switch were `hostExecution` (other listings as stored). */
  access(agentId: string, hostExecution: boolean): ListingAccess {
    const others = this.listings.hostIds().filter((id) => id !== agentId);
    const hostIds = hostExecution ? [...others, agentId] : others;
    return listingAccess(this.store, this.owner, agentId, this.level, hostIds, this.worker);
  }
  /** Enabled, and account keys can run it and every delegate it may call. */
  callable(l: ListingRecord): boolean {
    return l.enabled && this.access(l.agentId, l.hostExecution === true).blockedBy.length === 0;
  }
  /**
   * Before a run of an account key starts or resumes: a listed agent that needs host authority
   * runs only while its switch is on (turning it off also stops interrupted runs from resuming).
   */
  assertHostAllowed(agentId: string): void {
    if (!this.listings.find(agentId)) return;
    if (this.access(agentId, false).requiresHost && !this.listings.hostIds().includes(agentId))
      throw new Fault('isolation_required', hostRefusal(agentId), 403);
  }
  price(l: ListingRecord): Price {
    return { perRun: toPoints(l.perRun), per1kTokens: toPoints(l.per1kTokens) };
  }
  view(l: ListingRecord): ListingView {
    return {
      ...this.access(l.agentId, l.hostExecution === true),
      hostExecution: l.hostExecution === true,
      agentId: l.agentId,
      title: l.title,
      summary: l.summary,
      tags: l.tags,
      price: this.price(l),
      enabled: l.enabled,
      updatedAt: l.updatedAt,
      agentExists: this.agentExists(l.agentId),
    };
  }
  listed(l: ListingRecord): ListedAgentView | undefined {
    let agent;
    try {
      agent = this.store.bundle(this.owner, l.agentId).agent;
    } catch {
      return undefined;
    }
    return {
      id: l.agentId,
      title: l.title,
      summary: l.summary,
      tags: l.tags,
      description: agent.description,
      kind: agent.engine === 'kernel' ? 'kernel' : 'external',
      models: ['auto', ...agent.routes.map((r) => r.id)],
      price: this.price(l),
      updatedAt: l.updatedAt,
      conversion: conversionProfile(agent.engine, this.worker),
    };
  }
}
