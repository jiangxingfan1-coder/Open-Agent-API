import type { ModelPerformance } from '../core/model-evaluation.js';

export function measuredRouteScore(
  {
    performance,
    strategy,
    intent,
    topologyPenalty,
    priority,
    costTier,
    now,
  }: {
    performance: ModelPerformance | undefined;
    strategy: string;
    intent: string;
    topologyPenalty: number;
    priority: number;
    costTier: number | undefined;
    now: number;
  },
  observedMs: number | undefined,
): number | undefined {
  if (!performance || performance.samples < 4 || now - performance.observedAt >= 7 * 86_400_000)
    return undefined;
  const dimension =
    intent === 'coding'
      ? 'coding'
      : intent === 'reasoning'
        ? 'reasoning'
        : intent === 'tool_heavy'
          ? 'tool_calling'
          : undefined;
  const quality = (dimension && performance.dimensions[dimension]?.score) ?? performance.score;
  const weight = strategy === 'quality' ? 100_000 : strategy === 'speed' ? 5000 : 30_000;
  return (
    (1 - quality) * weight +
    (observedMs ?? performance.averageMs) * (strategy === 'speed' ? 5 : 1) +
    topologyPenalty +
    priority * 10 +
    (strategy === 'cost' ? ((costTier ?? 3) - 1) * 15_000 : 0)
  );
}
