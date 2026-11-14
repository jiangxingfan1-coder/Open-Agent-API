/** 编辑距离（Levenshtein），只用于给拼错的关键字找最接近的候选。 */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** 拼错时的修复建议：距离足够近才给，避免误导。返回值以空格开头，可直接接在报错后面。 */
export function suggestName(value: string, candidates: Iterable<string>): string {
  const wanted = value.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // 常见的手误是漏字、多字或相邻两个字母写反（算两步），短词只容一步。
  const tolerance = wanted.length <= 3 ? 1 : wanted.length <= 8 ? 2 : 3;
  return best !== undefined && bestDistance > 0 && bestDistance <= tolerance
    ? ` Did you mean '${best}'?`
    : '';
}

export const AGENT_STATEMENTS = [
  'let',
  'type',
  'use',
  'route',
  'tool',
  'delegate',
  'flow',
  'workflow',
  'limits',
  'output_schema',
  'instructions',
  'description',
  'engine',
  'provider',
  'model',
  'allow_graph',
  'approvals',
  'allowed_nodes',
  'files',
  'skills',
];
export const FLOW_STATEMENTS = [
  'step',
  'params',
  'input_schema',
  'description',
  'return',
  'output_schema',
];
export const TYPE_NAMES = [
  'string',
  'int',
  'integer',
  'number',
  'float',
  'bool',
  'boolean',
  'object',
  'json',
  'any',
];
export const ROUTE_ATTRIBUTES = ['priority', 'cost', 'speed', 'tags'];
