import type { Effect } from './contracts.js';

export type HandoffArtifactRef = {
  id: string;
  name: string;
  sha256: string;
};

export type HandoffStepSummary = {
  name: string;
  effect: Effect;
  summary?: string;
};

export type StructuredHandoff = {
  fromAgent: string;
  previousRunId?: string;
  lastStepSummary?: string;
  steps: readonly HandoffStepSummary[];
  artifacts: readonly HandoffArtifactRef[];
};
