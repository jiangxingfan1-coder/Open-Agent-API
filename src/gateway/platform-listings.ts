/**
 * 开发者平台：智能体上架与定价。
 *
 * 价格以微点数存储；`enabledIds()` 是内存快照，账号密钥的 `agents` 取自它，上架变化时刷新并通知。
 */
import type { DatabaseSync } from 'node:sqlite';
import { prepared } from './platform-db.js';
import { Fault } from '../core/util.js';

export type ListingRecord = {
  agentId: string;
  title: string;
  summary: string;
  tags: string[];
  /** Micro-points per run. */
  perRun: number;
  /** Micro-points per 1,000 tokens. */
  per1kTokens: number;
  enabled: boolean;
  /**
   * The owner's explicit choice to let account keys run this agent with `host` authority (it is
   * an external agent or uses host tools). Absent in rows written before the switch: false.
   */
  hostExecution?: boolean;
  updatedAt: number;
};
export type ListingPatch = {
  title?: string;
  summary?: string;
  tags?: string[];
  perRun?: number;
  per1kTokens?: number;
  enabled?: boolean;
  hostExecution?: boolean;
};

/** Largest price (micro-points): 1,000 points, so per-token charges stay exact integers. */
const MAX_PRICE = 1_000 * 1_000_000;

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max)
    throw new Fault('invalid_request', `${field} must be at most ${max} characters.`, 400);
  return trimmed;
}
function price(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE)
    throw new Fault('invalid_request', `${field} must be between 0 and 1000 points.`, 400);
  return value;
}

export class PlatformListings {
  private enabled: string[] = [];
  private host: string[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
    private readonly changed: () => void,
  ) {
    this.refresh();
  }
  private refresh(): void {
    const enabled = this.list().filter((l) => l.enabled);
    this.enabled = enabled.map((l) => l.agentId);
    this.host = enabled.filter((l) => l.hostExecution === true).map((l) => l.agentId);
  }
  /** IDs of enabled listings (snapshot; a fresh array each call). */
  enabledIds(): string[] {
    return [...this.enabled];
  }
  /** IDs of enabled listings opted into host execution (snapshot; a fresh array each call). */
  hostIds(): string[] {
    return [...this.host];
  }
  list(): ListingRecord[] {
    return prepared(
      this.db,
      'SELECT payload FROM platform_listings WHERE owner=? ORDER BY agent_id',
    )
      .all(this.owner)
      .map((row) => JSON.parse(String(row.payload)) as ListingRecord);
  }
  find(agentId: string): ListingRecord | undefined {
    const row = prepared(
      this.db,
      'SELECT payload FROM platform_listings WHERE owner=? AND agent_id=?',
    ).get(this.owner, agentId);
    return row ? (JSON.parse(String(row.payload)) as ListingRecord) : undefined;
  }
  /** Creates or updates a listing (the caller checks that the agent exists). */
  upsert(agentId: string, patch: ListingPatch): ListingRecord {
    const prior = this.find(agentId);
    const tags = patch.tags ?? prior?.tags ?? [];
    if (tags.length > 10 || tags.some((t) => !t.trim() || t.trim().length > 32))
      throw new Fault('invalid_request', 'tags: at most 10 tags of 1-32 characters.', 400);
    const next: ListingRecord = {
      agentId,
      title: text(patch.title ?? prior?.title ?? agentId, 'title', 120) || agentId,
      summary: text(patch.summary ?? prior?.summary ?? '', 'summary', 500),
      tags: [...new Set(tags.map((t) => t.trim()))],
      perRun: price(patch.perRun ?? prior?.perRun ?? 0, 'price.per_run'),
      per1kTokens: price(patch.per1kTokens ?? prior?.per1kTokens ?? 0, 'price.per_1k_tokens'),
      enabled: patch.enabled ?? prior?.enabled ?? true,
      hostExecution: patch.hostExecution ?? prior?.hostExecution ?? false,
      updatedAt: Date.now(),
    };
    prepared(
      this.db,
      'INSERT INTO platform_listings(owner,agent_id,payload) VALUES(?,?,?) ON CONFLICT(owner,agent_id) DO UPDATE SET payload=excluded.payload',
    ).run(this.owner, agentId, JSON.stringify(next));
    this.refresh();
    this.changed();
    return next;
  }
  remove(agentId: string): void {
    if (!this.find(agentId))
      throw new Fault('listing_not_found', 'This agent has no listing.', 404);
    prepared(this.db, 'DELETE FROM platform_listings WHERE owner=? AND agent_id=?').run(
      this.owner,
      agentId,
    );
    this.refresh();
    this.changed();
  }
}
