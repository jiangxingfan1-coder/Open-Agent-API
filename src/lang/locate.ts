import { z } from 'zod';
import { Fault } from '../core/util.js';
import { type Token } from './lexer.js';

// 把编译后期（Zod 契约校验、执行图校验）的报错映射回源码位置。解析时记下每个声明的起始
// token，校验失败时按报错路径找到最贴近的那一个；找不到具体声明就退回所属的 agent / flow。

/** 一个对象块里各个键的位置（键按源码里的写法）。 */
export type KeySites = Map<string, Token>;

export interface FlowSites {
  tok: Token;
  steps: Map<string, Token>;
}

export interface SourceSites {
  agent: Token;
  /** agent 级属性：契约里的字段名 → 声明它的关键字。 */
  props: Map<string, Token>;
  limits?: { tok: Token; keys: KeySites };
  tools: Token[];
  routes: { tok: Token; keys: KeySites }[];
  delegates: { tok: Token; keys: KeySites }[];
  workflows: FlowSites[];
}

export function emptySites(agent: Token): SourceSites {
  return { agent, props: new Map(), tools: [], routes: [], delegates: [], workflows: [] };
}

/** 扫描 `[start, end)` 范围内最外层对象块的键：`{ key = ...  "key": ... }`。 */
export function objectKeySites(tokens: Token[], start: number, end: number): KeySites {
  const keys: KeySites = new Map();
  let depth = 0;
  for (let i = start; i < end; i++) {
    const tok = tokens[i]!;
    if (tok.type === 'LBRACE' || tok.type === 'LBRACKET' || tok.type === 'LPAREN') depth++;
    else if (tok.type === 'RBRACE' || tok.type === 'RBRACKET' || tok.type === 'RPAREN') depth--;
    else if (
      depth === 1 &&
      (tok.type === 'IDENT' || tok.type === 'STRING') &&
      (tokens[i + 1]?.type === 'EQ' || tokens[i + 1]?.type === 'COLON') &&
      !keys.has(tok.value)
    )
      keys.set(tok.value, tok);
  }
  return keys;
}

/** 契约字段名 → 源码里可能的写法（第一个是规范写法）。 */
const SPELLINGS: Record<string, string[]> = {
  maxTurns: ['max_turns', 'maxTurns'],
  maxOutputTokens: ['max_output_tokens', 'maxOutputTokens'],
  timeoutMs: ['timeout_ms', 'timeout', 'timeoutMs', 'wall_ms', 'max_wait'],
  toolConcurrency: ['tool_concurrency', 'toolConcurrency'],
  maxTotalTokens: ['max_total_tokens', 'maxTotalTokens'],
  costTier: ['cost', 'cost_tier', 'costTier'],
  speedTier: ['speed', 'speed_tier', 'speedTier'],
  forwardFiles: ['forward_files', 'forwardFiles'],
  allowGraph: ['allow_graph', 'allowGraph'],
  allowedNodes: ['allowed_nodes', 'allowedNodes'],
  outputSchema: ['output_schema', 'outputSchema'],
};

const spellings = (field: string) => SPELLINGS[field] ?? [field];

/** 在一个块的键里找契约字段；返回位置和源码里的写法。 */
function findKey(keys: KeySites, field: PropertyKey | undefined): [Token, string] | undefined {
  if (typeof field !== 'string') return undefined;
  for (const spelling of spellings(field)) {
    const tok = keys.get(spelling);
    if (tok) return [tok, spelling];
  }
  return undefined;
}

type Path = readonly PropertyKey[];

/** 按 Zod 报错路径找位置和一个按源码写法的可读路径。 */
function locateAgentPath(sites: SourceSites, path: Path): { tok: Token; label: string } {
  const [head, index, field] = path;
  const label = (parts: PropertyKey[]) => parts.map(String).join('.');
  if (head === 'limits' && sites.limits) {
    const hit = findKey(sites.limits.keys, index);
    return hit
      ? { tok: hit[0], label: label(['limits', hit[1], ...path.slice(2)]) }
      : { tok: sites.limits.tok, label: label([...path]) };
  }
  if (typeof index === 'number') {
    const block =
      head === 'routes'
        ? sites.routes[index]
        : head === 'delegates'
          ? sites.delegates[index]
          : undefined;
    if (block) {
      const hit = findKey(block.keys, field);
      return {
        tok: hit?.[0] ?? block.tok,
        label: label([String(head), index, ...(hit ? [hit[1]] : []), ...path.slice(hit ? 3 : 2)]),
      };
    }
    if (head === 'tools' && sites.tools[index])
      return { tok: sites.tools[index], label: label([...path]) };
    if (head === 'workflows' && sites.workflows[index]) {
      const flow = sites.workflows[index];
      return { tok: flow.tok, label: label([...path]) };
    }
  }
  if (typeof head === 'string') {
    const tok = sites.props.get(head);
    if (tok) return { tok, label: label([spellings(head)[0]!, ...path.slice(1)]) };
  }
  return { tok: sites.agent, label: label([...path]) };
}

const sentence = (text: string) => (/[.!?。]$/.test(text) ? text : `${text}.`);

/** 契约校验失败：一句可读的话，带源码位置。 */
export function validationFault(tok: Token, label: string, issue: z.core.$ZodIssue): Fault {
  const detail = sentence(issue.message);
  return new Fault(
    'oaa_validation_error',
    `Line ${tok.line}, Col ${tok.col}: ${label ? `Invalid value for '${label}': ${detail}` : detail}`,
  );
}

/** 运行 `parse`，Zod 报错时按 `locate` 映射成带位置的 `oaa_validation_error`。 */
export function parseLocated<T>(
  parse: () => T,
  locate: (path: Path) => { tok: Token; label: string },
): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof z.ZodError) || !error.issues.length) throw error;
    const issue = error.issues[0]!;
    const { tok, label } = locate(issue.path);
    throw validationFault(tok, label, issue);
  }
}

export const agentLocator = (sites: SourceSites) => (path: Path) => locateAgentPath(sites, path);

/**
 * 执行图校验失败：保留原错误码，在报错前面加上位置。报错里提到的步骤 ID 属于这个 flow 时
 * 指向那个步骤，否则指向 flow 声明。
 */
export function locateGraphFault(fault: Fault, flow: FlowSites): Fault {
  let tok = flow.tok;
  for (const [, name] of fault.message.matchAll(/'([^']+)'/g)) {
    const step = flow.steps.get(name!);
    if (step) {
      tok = step;
      break;
    }
  }
  return new Fault(
    fault.code,
    `Line ${tok.line}, Col ${tok.col}: ${fault.message}`,
    fault.status,
    fault.uncertain,
  );
}
