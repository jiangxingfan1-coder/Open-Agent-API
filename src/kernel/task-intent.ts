export type TaskIntent = 'coding' | 'reasoning' | 'fast' | 'tool_heavy' | 'general';
export interface IntentProfile {
  primary: TaskIntent;
  confidence: number;
  signals: {
    coding: number;
    reasoning: number;
    fast: number;
    toolHeavy: number;
    longContext: boolean;
    structuredJson: boolean;
  };
}

export function analyzeTaskIntent(input: string, toolsCount = 0): IntentProfile {
  const lower = input.toLowerCase();
  const trimmed = input.trim();
  let coding = input.includes('```') ? 3 : 0;
  for (const keyword of [
    'function',
    'class ',
    'import ',
    'def ',
    'const ',
    'bug',
    'refactor',
    'typescript',
    'python',
    'stack trace',
    'compile',
    'syntaxerror',
    'typeerror',
    'interface ',
  ])
    if (lower.includes(keyword)) coding += 2;
  let reasoning = 0;
  for (const keyword of [
    'think step by step',
    'step by step',
    'reasoning',
    'mathematical proof',
    'proof',
    '推导',
    '证明',
    '深度思考',
    '数学证明',
    'algorithm complexity',
    'formal verification',
    'theorem',
  ])
    if (lower.includes(keyword)) reasoning += 2;
  const fast = trimmed.length > 0 && trimmed.length < 80 && !trimmed.includes('\n') ? 3 : 0;
  const toolHeavy = toolsCount >= 4 ? 4 : toolsCount >= 2 ? 1 : 0;
  let primary: TaskIntent = 'general';
  let confidence = 0.6;
  if (toolsCount >= 4) {
    primary = 'tool_heavy';
    confidence = 0.9;
  } else if (coding >= 2) {
    primary = 'coding';
    confidence = Math.min(0.98, 0.65 + coding * 0.08);
  } else if (reasoning >= 2) {
    primary = 'reasoning';
    confidence = Math.min(0.98, 0.65 + reasoning * 0.08);
  } else if (fast > 0) {
    primary = 'fast';
    confidence = 0.85;
  }
  return {
    primary,
    confidence,
    signals: {
      coding,
      reasoning,
      fast,
      toolHeavy,
      longContext: input.length >= 12_000,
      structuredJson: lower.includes('json schema') || lower.includes('valid json'),
    },
  };
}
export function detectTaskIntent(input: string, toolsCount = 0): TaskIntent {
  return analyzeTaskIntent(input, toolsCount).primary;
}
