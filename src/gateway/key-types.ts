import type { ConnectionDefaults } from '../core/agent-access.js';
import type { KeyQuota, ExecutionLevel, RunStatus } from '../core/contracts.js';
import type { KeyUsageView } from './key-usage.js';

export type StoredKey = {
  localConnectionId?: string;
  connection?: ConnectionDefaults;
  id: string;
  name: string;
  owner: string;
  hash: string;
  agents: string[];
  scopes: string[];
  revoked: boolean;
  createdAt: number;
  quota?: KeyQuota;
  dataScope?: 'own' | 'owner';
  execution?: ExecutionLevel;
  accountId?: string;
};
export type AccountKeyView = {
  id: string;
  name: string;
  createdAt: number;
  revoked: boolean;
  usage: KeyUsageView;
};
export interface AccountKeyPolicy {
  agents(): string[];
  hostAgents(): string[];
  readonly execution: 'workspace' | 'sandbox';
  readonly quota: KeyQuota;
  assertActive(accountId: string): void;
  checkRun(accountId: string, agent: string): void;
  beginRun(accountId: string, runId: string, agent: string): void;
  settleRun(runId: string, status: RunStatus, tokens: number): void;
  reopenRun(runId: string): void;
}
