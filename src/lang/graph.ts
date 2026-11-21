import { GRAPH_LIMITS } from '../core/limits.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { graphSchema, publishedGraphSchema, type GraphStep } from './graph-schema.js';
export { graphSchema, type GraphStep } from './graph-schema.js';
import type {
  AgentDefinition,
  DelegateBinding,
  Effect,
  ToolBinding,
  WorkflowDefinition,
} from '../core/contracts.js';
import { Fault, checkAbort, faultOf, sleep } from '../core/util.js';
import {
  ApprovalSuspension,
  SchedulingSuspension,
  collectSuspensions,
} from '../core/suspension.js';
import { JsonSchemas } from '../core/schemas.js';

export function graphEffect(
  steps: readonly { tool?: unknown; fallback?: unknown }[],
  effects: Map<string, Effect>,
): Effect {
  let effect: Effect = 'read';
  for (const step of steps) {
    const fallback = step.fallback as { tool?: unknown } | undefined;
    const names = [step.tool, ...(fallback?.tool === undefined ? [] : [fallback.tool])];
    for (const name of names) {
      const current = name === '$transform' ? 'read' : (effects.get(String(name)) ?? 'unknown');
      if (current === 'unknown') return 'unknown';
      // Individually idempotent writes do not imply an idempotent compound workflow.
      if (current !== 'read') effect = 'write';
    }
  }
  return effect;
}

export function graphToolEffects(agent: AgentDefinition): Map<string, Effect> {
  const effects = new Map<string, Effect>([
    ...agent.tools.map((tool) => [tool.name, tool.capability.effect] as const),
    ...(agent.delegates ?? []).map((delegate) => [delegate.name, 'unknown' as const] as const),
  ]);
  // Bundle validation requires workflows to refer only to earlier definitions.
  for (const workflow of agent.workflows ?? [])
    effects.set(workflow.name, graphEffect(workflow.steps, effects));
  return effects;
}

export interface CompiledGraphPlan {
  steps: GraphStep[];
  layers: string[][];
  criticalPathDepth: number;
  maxParallelWidth: number;
}

function pointerTarget(baseObj: unknown, pointer?: string): unknown {
  let result = baseObj;
  for (const raw of pointer ? pointer.slice(1).split('/') : []) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      result === null ||
      typeof result !== 'object'
    )
      throw new Fault('invalid_reference', `Unknown JSON pointer component: ${part}`);
    if (Array.isArray(result)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= result.length)
        throw new Fault('invalid_reference', `Array index out of bounds: ${part}`);
      result = result[idx];
    } else {
      if (!Object.hasOwn(result, part))
        throw new Fault('invalid_reference', `Unknown JSON pointer component: ${part}`);
      result = (result as Record<string, unknown>)[part];
    }
  }
  return result;
}
export function extractPointerValue(baseObj: unknown, pointer?: string): unknown {
  return structuredClone(pointerTarget(baseObj, pointer));
}

// ---------------------------------------------------------------------------
// OAA-VM v2: 纯自研词法 + Pratt 算符优先安全 AST 表达式求值引擎 (Zero-eval)
// ---------------------------------------------------------------------------

type ExprTokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOL'
  | 'NULL'
  | 'REF'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'QUESTION'
  | 'COLON'
  | 'EOF';

interface ExprToken {
  type: ExprTokenType;
  value: string;
}

const SAFE_FUNCTIONS = new Set([
  'len',
  'includes',
  'startsWith',
  'endsWith',
  'lower',
  'upper',
  'trim',
  'min',
  'max',
  'round',
  'abs',
  'coalesce',
  'keys',
  'has',
  'join',
  'split',
  'slice',
  'pluck',
  'compact',
  'unique',
  'sum',
  'avg',
  'json',
]);

function tokenizeExpr(expr: string): ExprToken[] {
  if (expr.length > 8192) {
    throw new Fault('invalid_expression', 'Expression exceeds 8 KiB limit.');
  }
  const tokens: ExprToken[] = [];
  let i = 0;

  while (i < expr.length) {
    if (tokens.length > 512) {
      throw new Fault('invalid_expression', 'Expression exceeds token complexity limit.');
    }
    const ch = expr[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // String literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let s = '';
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          i++;
          const esc = expr[i]!;
          s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        } else {
          s += expr[i];
        }
        i++;
      }
      if (i >= expr.length) {
        throw new Fault('invalid_expression', 'Unterminated string literal in expression.');
      }
      i++;
      tokens.push({ type: 'STRING', value: s });
      continue;
    }

    // Numbers
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i]!)) {
        num += expr[i];
        i++;
      }
      const parsed = Number(num);
      if (Number.isNaN(parsed)) {
        throw new Fault('invalid_expression', `Invalid number '${num}' in expression.`);
      }
      tokens.push({ type: 'NUMBER', value: num });
      continue;
    }

    // Two-character operators
    const two = expr.slice(i, i + 2);
    if (['??', '||', '&&', '==', '!=', '>=', '<='].includes(two)) {
      tokens.push({ type: 'OP', value: two });
      i += 2;
      continue;
    }

    // Single-character punctuation & operators
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ch });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ type: 'LBRACKET', value: ch });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: 'RBRACKET', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ch });
      i++;
      continue;
    }
    if (ch === '?') {
      tokens.push({ type: 'QUESTION', value: ch });
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'COLON', value: ch });
      i++;
      continue;
    }
    if (['>', '<', '+', '-', '*', '/', '%', '!'].includes(ch)) {
      tokens.push({ type: 'OP', value: ch });
      i++;
      continue;
    }

    // Identifiers & Step/Local References (e.g. step1#/a/b, step1.a.b, $item#/id, len)
    if (/[A-Za-z_$]/.test(ch)) {
      let ref = '';
      while (i < expr.length && /[A-Za-z0-9_$-]/.test(expr[i]!)) {
        ref += expr[i];
        i++;
      }
      if (expr[i] === '#') {
        ref += '#';
        i++;
        while (i < expr.length && /[A-Za-z0-9_.~/-]/.test(expr[i]!)) {
          ref += expr[i];
          i++;
        }
      } else if (expr[i] === '.' && /[A-Za-z0-9_]/.test(expr[i + 1] ?? '')) {
        let dotPath = '';
        while (expr[i] === '.' && /[A-Za-z0-9_]/.test(expr[i + 1] ?? '')) {
          i++; // skip '.'
          let seg = '';
          while (i < expr.length && /[A-Za-z0-9_-]/.test(expr[i]!)) {
            seg += expr[i];
            i++;
          }
          dotPath += `/${seg}`;
        }
        ref += `#${dotPath}`;
      }
      if (ref === 'true' || ref === 'false') {
        tokens.push({ type: 'BOOL', value: ref });
      } else if (ref === 'null' || ref === 'undefined') {
        tokens.push({ type: 'NULL', value: 'null' });
      } else if (ref === 'in') {
        tokens.push({ type: 'OP', value: 'in' });
      } else {
        tokens.push({ type: 'REF', value: ref });
      }
      continue;
    }

    throw new Fault('invalid_expression', `Unexpected token '${ch}' in expression.`);
  }

  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

type AstNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'array'; items: AstNode[] }
  | { kind: 'ref'; raw: string }
  | { kind: 'unary'; op: string; arg: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'ternary'; cond: AstNode; consequent: AstNode; alternate: AstNode }
  | { kind: 'call'; name: string; args: AstNode[] };

const PRECEDENCE: Record<string, number> = {
  '??': 15,
  '||': 20,
  '&&': 30,
  '==': 40,
  '!=': 40,
  in: 45,
  '<': 50,
  '<=': 50,
  '>': 50,
  '>=': 50,
  '+': 60,
  '-': 60,
  '*': 70,
  '/': 70,
  '%': 70,
};

const exprAstCache = new Map<string, AstNode>();

function parseExprAst(expr: string): AstNode {
  const cached = exprAstCache.get(expr);
  if (cached) {
    exprAstCache.delete(expr);
    exprAstCache.set(expr, cached);
    return cached;
  }
  const tokens = tokenizeExpr(expr);
  let pos = 0;
  const peek = () => tokens[Math.min(pos, tokens.length - 1)]!;
  const next = () => tokens[Math.min(pos++, tokens.length - 1)]!;

  function parseExpression(minPrec: number, depth: number): AstNode {
    if (depth > 32) {
      throw new Fault('invalid_expression', 'Expression nesting depth exceeds limit.');
    }
    let left = parsePrimary(depth + 1);

    while (true) {
      const tok = peek();
      if (tok.type === 'QUESTION' && minPrec <= 10) {
        next();
        const consequent = parseExpression(0, depth + 1);
        const colon = next();
        if (colon.type !== 'COLON') {
          throw new Fault('invalid_expression', "Expected ':' in ternary expression.");
        }
        const alternate = parseExpression(10, depth + 1);
        left = { kind: 'ternary', cond: left, consequent, alternate };
        continue;
      }
      if (tok.type === 'OP' && tok.value in PRECEDENCE) {
        const prec = PRECEDENCE[tok.value]!;
        if (prec < minPrec) break;
        next();
        const right = parseExpression(prec + 1, depth + 1);
        left = { kind: 'binary', op: tok.value, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  function parsePrimary(depth: number): AstNode {
    const tok = next();
    if (tok.type === 'NUMBER') return { kind: 'literal', value: Number(tok.value) };
    if (tok.type === 'STRING') return { kind: 'literal', value: tok.value };
    if (tok.type === 'BOOL') return { kind: 'literal', value: tok.value === 'true' };
    if (tok.type === 'NULL') return { kind: 'literal', value: null };

    if (tok.type === 'OP' && (tok.value === '!' || tok.value === '-' || tok.value === '+')) {
      const arg = parseExpression(80, depth + 1);
      return { kind: 'unary', op: tok.value, arg };
    }

    if (tok.type === 'LPAREN') {
      const inner = parseExpression(0, depth + 1);
      const close = next();
      if (close.type !== 'RPAREN') {
        throw new Fault('invalid_expression', "Expected closing ')' in expression.");
      }
      return inner;
    }

    if (tok.type === 'LBRACKET') {
      const items: AstNode[] = [];
      if (peek().type !== 'RBRACKET') {
        while (true) {
          items.push(parseExpression(0, depth + 1));
          if (peek().type === 'COMMA') {
            next();
            if (peek().type === 'RBRACKET') break;
            continue;
          }
          break;
        }
      }
      if (next().type !== 'RBRACKET') {
        throw new Fault('invalid_expression', "Expected closing ']' in array expression.");
      }
      return { kind: 'array', items };
    }

    if (tok.type === 'REF') {
      if (peek().type === 'LPAREN') {
        if (!SAFE_FUNCTIONS.has(tok.value)) {
          throw new Fault('invalid_expression', `Unsupported expression function: ${tok.value}`);
        }
        next(); // consume '('
        const args: AstNode[] = [];
        if (peek().type !== 'RPAREN') {
          while (true) {
            args.push(parseExpression(0, depth + 1));
            if (peek().type === 'COMMA') {
              next();
              continue;
            }
            break;
          }
        }
        if (next().type !== 'RPAREN') {
          throw new Fault('invalid_expression', `Expected ')' after arguments to ${tok.value}.`);
        }
        return { kind: 'call', name: tok.value, args };
      }
      return { kind: 'ref', raw: tok.value };
    }

    throw new Fault('invalid_expression', `Unexpected expression token '${tok.value}'.`);
  }

  const ast = parseExpression(0, 0);
  if (peek().type !== 'EOF') {
    throw new Fault('invalid_expression', `Trailing token '${peek().value}' in expression.`);
  }
  exprAstCache.set(expr, ast);
  if (exprAstCache.size > 512) {
    exprAstCache.delete(exprAstCache.keys().next().value!);
  }
  return ast;
}

function evalBuiltinCall(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'len': {
      const v = args[0];
      if (typeof v === 'string' || Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
      return 0;
    }
    case 'includes': {
      const [haystack, needle] = args;
      if (typeof haystack === 'string') return haystack.includes(String(needle ?? ''));
      if (Array.isArray(haystack)) return haystack.includes(needle);
      return false;
    }
    case 'startsWith':
      return typeof args[0] === 'string' && args[0].startsWith(String(args[1] ?? ''));
    case 'endsWith':
      return typeof args[0] === 'string' && args[0].endsWith(String(args[1] ?? ''));
    case 'lower':
      return typeof args[0] === 'string' ? args[0].toLowerCase() : '';
    case 'upper':
      return typeof args[0] === 'string' ? args[0].toUpperCase() : '';
    case 'trim':
      return typeof args[0] === 'string' ? args[0].trim() : '';
    case 'min': {
      const nums = args.map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? Math.min(...nums) : null;
    }
    case 'max': {
      const nums = args.map(Number).filter((n) => !Number.isNaN(n));
      return nums.length ? Math.max(...nums) : null;
    }
    case 'round':
      return typeof args[0] === 'number' ? Math.round(args[0]) : Number.NaN;
    case 'abs':
      return typeof args[0] === 'number' ? Math.abs(args[0]) : Number.NaN;
    case 'coalesce':
      for (const item of args) {
        if (item !== null && item !== undefined) return item;
      }
      return null;
    case 'keys':
      return args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
        ? Object.keys(args[0] as Record<string, unknown>)
        : [];
    case 'has':
      return (
        Boolean(args[0]) &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0]) &&
        typeof args[1] === 'string' &&
        !['__proto__', 'prototype', 'constructor'].includes(args[1]) &&
        Object.hasOwn(args[0] as object, args[1])
      );
    case 'join': {
      const [arr, sep] = args;
      if (!Array.isArray(arr)) return '';
      const out = arr
        .map((x) => (x === null || x === undefined ? '' : String(x)))
        .join(String(sep ?? ','));
      if (out.length > 65536) {
        throw new Fault('expression_budget_exceeded', 'Joined string exceeds 64 KiB.');
      }
      return out;
    }
    case 'split': {
      const [str, sep] = args;
      if (typeof str !== 'string') return [];
      return str.split(String(sep ?? ',')).slice(0, 256);
    }
    case 'slice': {
      const [target, start, end] = args;
      const s = Number(start ?? 0);
      const e = end === undefined ? undefined : Number(end);
      if (Array.isArray(target) || typeof target === 'string') {
        return target.slice(
          Number.isNaN(s) ? 0 : s,
          e !== undefined && !Number.isNaN(e) ? e : undefined,
        );
      }
      return [];
    }
    case 'pluck': {
      const [arr, key] = args;
      if (
        !Array.isArray(arr) ||
        typeof key !== 'string' ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        return [];
      return arr.map((item) =>
        item && typeof item === 'object' && Object.hasOwn(item as object, key)
          ? (item as Record<string, unknown>)[key]
          : null,
      );
    }
    case 'compact':
      return Array.isArray(args[0])
        ? args[0].filter((x) => x !== null && x !== undefined && x !== false && x !== '')
        : [];
    case 'unique':
      return Array.isArray(args[0]) ? [...new Set(args[0])] : [];
    case 'sum':
      return Array.isArray(args[0])
        ? args[0].reduce((acc: number, v) => acc + (Number(v) || 0), 0)
        : 0;
    case 'avg':
      return Array.isArray(args[0]) && args[0].length > 0
        ? args[0].reduce((acc: number, v) => acc + (Number(v) || 0), 0) / args[0].length
        : 0;
    case 'json':
      return JSON.stringify(args[0] ?? null);
    default:
      throw new Fault('invalid_expression', `Unknown safe function: ${name}`);
  }
}

function evalAstNode(
  node: AstNode,
  scope: Map<string, unknown>,
  budget: { steps: number },
  bareIdentAsLiteral = false,
): unknown {
  if (++budget.steps > 1024) {
    throw new Fault('expression_budget_exceeded', 'Expression evaluation exceeded step budget.');
  }
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'array':
      return node.items.map((item) => evalAstNode(item, scope, budget, bareIdentAsLiteral));
    case 'ref': {
      const [name, pointer] = node.raw.split('#');
      if (!scope.has(name!)) {
        if (bareIdentAsLiteral && pointer === undefined) return node.raw;
        return null;
      }
      try {
        return extractPointerValue(scope.get(name!), pointer);
      } catch {
        return null;
      }
    }
    case 'unary': {
      const v = evalAstNode(node.arg, scope, budget, bareIdentAsLiteral);
      if (node.op === '!') return !v;
      if (node.op === '-') return -Number(v);
      return +Number(v);
    }
    case 'ternary': {
      const cond = evalAstNode(node.cond, scope, budget, bareIdentAsLiteral);
      return cond
        ? evalAstNode(node.consequent, scope, budget, bareIdentAsLiteral)
        : evalAstNode(node.alternate, scope, budget, bareIdentAsLiteral);
    }
    case 'call': {
      const evaluated = node.args.map((a) => evalAstNode(a, scope, budget, bareIdentAsLiteral));
      return evalBuiltinCall(node.name, evaluated);
    }
    case 'binary': {
      // Short-circuit logical operators
      if (node.op === '??')
        return (
          evalAstNode(node.left, scope, budget, bareIdentAsLiteral) ??
          evalAstNode(node.right, scope, budget, bareIdentAsLiteral)
        );
      if (node.op === '||') {
        const l = evalAstNode(node.left, scope, budget, bareIdentAsLiteral);
        return l ? true : Boolean(evalAstNode(node.right, scope, budget, bareIdentAsLiteral));
      }
      if (node.op === '&&') {
        const l = evalAstNode(node.left, scope, budget, bareIdentAsLiteral);
        return !l ? false : Boolean(evalAstNode(node.right, scope, budget, bareIdentAsLiteral));
      }
      const left = evalAstNode(node.left, scope, budget, bareIdentAsLiteral);
      const right = evalAstNode(node.right, scope, budget, bareIdentAsLiteral);
      switch (node.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case 'in': {
          if (Array.isArray(right)) return right.includes(left);
          if (typeof right === 'string') return right.includes(String(left ?? ''));
          if (right && typeof right === 'object') {
            return (
              typeof left === 'string' &&
              !['__proto__', 'prototype', 'constructor'].includes(left) &&
              Object.hasOwn(right, left)
            );
          }
          return false;
        }
        case '>=':
          return Number(left) >= Number(right);
        case '<=':
          return Number(left) <= Number(right);
        case '>':
          return Number(left) > Number(right);
        case '<':
          return Number(left) < Number(right);
        case '+': {
          if (typeof left === 'string' || typeof right === 'string') {
            const out = String(left ?? '') + String(right ?? '');
            if (out.length > 65536) {
              throw new Fault('expression_budget_exceeded', 'Computed string exceeds 64 KiB.');
            }
            return out;
          }
          return Number(left) + Number(right);
        }
        case '-':
          return Number(left) - Number(right);
        case '*':
          return Number(left) * Number(right);
        case '/': {
          const denom = Number(right);
          return denom === 0 ? null : Number(left) / denom;
        }
        case '%': {
          const denom = Number(right);
          return denom === 0 ? null : Number(left) % denom;
        }
        default:
          throw new Fault('invalid_expression', `Unsupported operator '${node.op}'.`);
      }
    }
  }
}

export function evaluateAst(expr: string): unknown {
  const s = expr.trim();
  if (!s) return '';
  const ast = parseExprAst(s);
  return evalAstNode(ast, new Map(), { steps: 0 }, true);
}

export function evaluateSafeExpr(expr: string, results: Map<string, unknown>): unknown {
  const s = expr.trim();
  if (!s) return null;
  const ast = parseExprAst(s);
  return evalAstNode(ast, results, { steps: 0 }, false);
}

export function validateSafeExpression(expr: string): void {
  parseExprAst(expr);
}

function extractExprStepIds(
  expr: string,
  localVars: ReadonlySet<string>,
  includeUnboundLocals = false,
): string[] {
  const tokens = tokenizeExpr(expr);
  const deps: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.type !== 'REF') continue;
    // Skip function call names followed by '('
    if (tokens[i + 1]?.type === 'LPAREN') continue;
    const base = tok.value.split('#')[0]!;
    if ((!includeUnboundLocals && base.startsWith('$')) || localVars.has(base)) continue;
    deps.push(base);
  }
  return deps;
}

function references(
  value: unknown,
  localVars: ReadonlySet<string> = new Set(),
  includeUnboundLocals = false,
): string[] {
  if (Array.isArray(value))
    return value.flatMap((v) => references(v, localVars, includeUnboundLocals));
  if (!value || typeof value !== 'object') return [];
  const o = value as Record<string, unknown>;
  if ('$ref' in o) {
    const keys = Object.keys(o);
    const validShape = keys.length === 1 || (keys.length === 2 && '$default' in o);
    if (
      !validShape ||
      typeof o.$ref !== 'string' ||
      !/^\$?[A-Za-z0-9_-]+(?:#(?:\/.*)?)?$/.test(o.$ref)
    )
      throw new Fault(
        'invalid_reference',
        'References must be {"$ref":"stepId#/field"} or {"$ref":"stepId"}.',
      );
    const base = o.$ref.split('#')[0]!;
    if ((!includeUnboundLocals && base.startsWith('$')) || localVars.has(base)) return [];
    return [base];
  }
  if ('$template' in o) {
    if (typeof o.$template !== 'string')
      throw new Fault('invalid_reference', 'Templates must have a string $template.');
    const matches = [...o.$template.matchAll(/\{\{(\$?[A-Za-z0-9_-]+(?:#[^}]*)?)\}\}/g)];
    return matches
      .map((m) => m[1]!.split('#')[0]!)
      .filter((id) => (includeUnboundLocals || !id.startsWith('$')) && !localVars.has(id));
  }
  if ('$expr' in o) {
    if (typeof o.$expr !== 'string')
      throw new Fault('invalid_reference', 'Expressions must have a string $expr.');
    // Validate expression syntax at compile/parse time
    parseExprAst(o.$expr);
    return extractExprStepIds(o.$expr, localVars, includeUnboundLocals);
  }
  return Object.values(o).flatMap((v) => references(v, localVars, includeUnboundLocals));
}

export function validateGraphOutput(
  output: unknown,
  steps: GraphStep[],
  bindings: ReadonlySet<string> = new Set(),
): void {
  const names = new Set(steps.map((step) => step.id));
  const missing = references(output, bindings, true).find((name) => !names.has(name));
  if (missing !== undefined)
    throw new Fault(
      'invalid_graph_output',
      `Graph output references an unavailable binding: ${missing}`,
    );
}

export function projectGraphOutput(
  output: unknown,
  results: Record<string, unknown>,
  bindings: Record<string, unknown> = {},
): unknown {
  if (output === undefined) return results;
  return resolveReferences(
    output,
    new Map([...Object.entries(bindings), ...Object.entries(results)]),
  );
}

export function parseGraph(
  value: unknown,
  allowedTools: Set<string>,
  toolEffects?: Map<string, Effect>,
  bindings: ReadonlySet<string> = new Set(),
): GraphStep[] {
  return checkGraph(graphSchema.parse(value), allowedTools, toolEffects, bindings);
}

export function parsePublishedGraph(
  value: unknown,
  allowedTools: Set<string>,
  toolEffects?: Map<string, Effect>,
): GraphStep[] {
  const graph = publishedGraphSchema.parse(value);
  if (
    graph.steps.reduce((n, step) => n + (step.foreach?.max_items ?? 1), 0) >
    GRAPH_LIMITS.expandedItems
  )
    throw new Fault(
      'invalid_graph',
      `Published graph expands beyond ${GRAPH_LIMITS.expandedItems} primary items.`,
    );
  return checkGraph(graph, allowedTools, toolEffects, new Set(['input', '$input']));
}

function checkGraph(
  { steps, output }: { steps: GraphStep[]; output?: unknown },
  allowedTools: Set<string>,
  toolEffects: Map<string, Effect> | undefined,
  bindings: ReadonlySet<string>,
): GraphStep[] {
  if (new Set(steps.map((s) => s.id)).size !== steps.length)
    throw new Fault('invalid_graph', 'Graph step IDs must be unique.');
  // Expanded IDs are durable checkpoint identities, not just display labels.
  const invocationIds = new Set(steps.map((s) => s.id));
  const reserve = (id: string) => {
    if (invocationIds.has(id))
      throw new Fault('invalid_graph', `Expanded graph step ID collision: ${id}`);
    invocationIds.add(id);
  };
  for (const step of steps) {
    if (step.foreach) {
      for (let i = 0; i < step.foreach.max_items; i++) {
        const id = `${step.id}_${i}`;
        reserve(id);
        if (step.fallback?.tool) reserve(`${id}_fallback`);
      }
    } else if (step.fallback?.tool) reserve(`${step.id}_fallback`);
  }
  const map = new Map(steps.map((s) => [s.id, s]));
  for (const s of steps) {
    const isTransform = s.tool === '$transform';
    if ((!isTransform && !allowedTools.has(s.tool)) || s.tool === 'execute_graph')
      throw new Fault('invalid_graph', `Unregistered tool: ${s.tool}`);

    const localVars = new Set<string>();
    const foreachDeps: string[] = [];
    if (s.foreach) {
      if (!/^\$?[A-Za-z0-9_-]+(?:#(?:\/.*)?)?$/.test(s.foreach.$ref)) {
        throw new Fault('invalid_reference', 'foreach.$ref must reference an upstream step.');
      }
      const foreachBase = s.foreach.$ref.split('#')[0]!;
      if (!foreachBase.startsWith('$')) foreachDeps.push(foreachBase);
      localVars.add(s.foreach.as);
      localVars.add(`$${s.foreach.as}`);
      localVars.add('$item');
      localVars.add('$index');
      if (s.foreach.where !== undefined) {
        if (s.foreach.as === 'index')
          throw new Fault(
            'invalid_graph',
            `Step '${s.id}': filtered foreach reserves 'index'; choose another item alias.`,
          );
        foreachDeps.push(...references(s.foreach.where, localVars, true));
      }
    }

    if (s.retry || s.timeout_ms !== undefined) {
      if (isTransform)
        throw new Fault(
          'invalid_graph',
          `Step '${s.id}' is a pure transform; retry and timeout apply only to tool calls.`,
        );
      if (toolEffects) {
        const eff = toolEffects.get(s.tool) ?? 'unknown';
        if (eff === 'write' || eff === 'unknown')
          throw new Fault(
            'unsafe_graph_retry',
            `Retry and timeout cannot be used on non-idempotent '${eff}' tool '${s.tool}': repeating or abandoning it could duplicate or hide a side effect.`,
          );
      }
    }
    const fallbackDeps: string[] = [];
    if (s.fallback) {
      if (toolEffects && !isTransform) {
        const eff = toolEffects.get(s.tool) ?? 'unknown';
        if (eff === 'write' || eff === 'unknown') {
          throw new Fault(
            'unsafe_graph_fallback',
            `Fallback cannot mask non-idempotent '${eff}' tool '${s.tool}'.`,
          );
        }
      }
      if (s.fallback.tool) {
        if (
          (s.fallback.tool !== '$transform' && !allowedTools.has(s.fallback.tool)) ||
          s.fallback.tool === 'execute_graph'
        ) {
          throw new Fault('invalid_graph', `Unregistered tool: ${s.fallback.tool}`);
        }
        if (toolEffects && s.fallback.tool !== '$transform') {
          const fbEff = toolEffects.get(s.fallback.tool) ?? 'unknown';
          if (fbEff === 'write' || fbEff === 'unknown') {
            throw new Fault(
              'unsafe_graph_fallback',
              `Fallback tool '${s.fallback.tool}' must have read or idempotent-write effect.`,
            );
          }
        }
      }
      if (s.fallback.arguments) fallbackDeps.push(...references(s.fallback.arguments, localVars));
      if (s.fallback.value !== undefined)
        fallbackDeps.push(...references(s.fallback.value, localVars));
    }

    const whenRefs = s.when !== undefined ? references(s.when) : [];
    // `when` 在循环开始之前对整个步骤判断一次，所以用不了循环变量；直接说清楚，而不是让它
    // 落到下面「引用了不存在的步骤」那条笼统的报错里。
    if (s.foreach) {
      const loopNames = new Set([s.foreach.as, 'item', 'index']);
      const misuse = whenRefs.find((ref) => loopNames.has(ref.replace(/^\$/, '')));
      if (misuse !== undefined)
        throw new Fault(
          'invalid_graph',
          `Step '${s.id}': 'when' is checked once before the loop starts, so it cannot use the loop variable '${misuse.replace(/^\$/, '')}'. Use foreach with 'where' to select individual items.`,
        );
    }
    s.depends_on = [
      ...new Set([
        ...s.depends_on,
        ...foreachDeps,
        ...references(s.arguments, localVars),
        ...whenRefs,
        ...fallbackDeps,
      ]),
      // 流程语境下的绑定（`$input` 与等价的 `input`）不是步骤，不产生依赖；与步骤同名时步骤优先，
      // 保持已发布定义的含义。execute_graph 没有绑定，这里什么也不滤掉。
    ].filter((d) => map.has(d) || !bindings.has(d));
    const missing = s.depends_on.find((d) => !map.has(d));
    if (missing !== undefined)
      throw new Fault(
        'invalid_graph',
        `Graph references a missing step: step '${s.id}' refers to '${missing}', which is not a step in this graph.`,
      );
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(s: GraphStep): void {
    if (visiting.has(s.id)) throw new Fault('invalid_graph', 'Graph contains a dependency cycle.');
    if (visited.has(s.id)) return;
    visiting.add(s.id);
    s.depends_on.forEach((d) => visit(map.get(d)!));
    visiting.delete(s.id);
    visited.add(s.id);
  }
  steps.forEach(visit);
  validateGraphOutput(output, steps, bindings);
  return steps;
}

export function compileGraphPlan(steps: GraphStep[]): CompiledGraphPlan {
  const depthMap = new Map<string, number>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  function computeDepth(id: string): number {
    const cached = depthMap.get(id);
    if (cached !== undefined) return cached;
    const step = stepMap.get(id)!;
    if (!step.depends_on.length) {
      depthMap.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...step.depends_on.map(computeDepth));
    depthMap.set(id, d);
    return d;
  }

  for (const s of steps) computeDepth(s.id);
  const maxDepth = steps.length ? Math.max(...depthMap.values()) : 0;
  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const s of steps) {
    layers[depthMap.get(s.id)!]!.push(s.id);
  }
  return {
    steps,
    layers,
    criticalPathDepth: layers.length,
    maxParallelWidth: layers.reduce((m, l) => Math.max(m, l.length), 0),
  };
}

const defaultWorkflowSchemas = new JsonSchemas();

export interface ValidateWorkflowsOptions {
  schemas?: JsonSchemas;
  normalizeSteps?: boolean;
  compilePlans?: boolean;
}

export interface ValidateWorkflowsResult {
  effects: Map<string, Effect>;
  workflowPlans: Record<string, CompiledGraphPlan>;
}

export function validateWorkflows(
  target: {
    tools: readonly ToolBinding[];
    delegates?: readonly DelegateBinding[];
    workflows?: WorkflowDefinition[];
  },
  options: ValidateWorkflowsOptions = {},
): ValidateWorkflowsResult {
  const allowed = new Set<string>([
    ...target.tools.map((t) => t.name),
    ...(target.delegates ?? []).map((d) => d.name),
  ]);
  const effects = new Map<string, Effect>([
    ...target.tools.map((t) => [t.name, t.capability.effect] as const),
    ...(target.delegates ?? []).map((d) => [d.name, 'unknown' as Effect] as const),
  ]);
  const workflowPlans: Record<string, CompiledGraphPlan> = {};
  const schemaCompiler = options.schemas ?? defaultWorkflowSchemas;

  for (const wf of target.workflows ?? []) {
    schemaCompiler.compile(wf.inputSchema);
    if (wf.outputSchema) schemaCompiler.compile(wf.outputSchema);
    const steps = parsePublishedGraph({ steps: wf.steps, output: wf.output }, allowed, effects);
    if (options.normalizeSteps) {
      wf.steps = steps as unknown as Record<string, unknown>[];
    }
    if (options.compilePlans) {
      workflowPlans[wf.name] = compileGraphPlan(steps);
    }
    allowed.add(wf.name);
    effects.set(wf.name, graphEffect(steps, effects));
  }

  return { effects, workflowPlans };
}

export function resolveReferences(value: unknown, results: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, results));
  if (!value || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if ('$ref' in o) {
    const [name, pointer] = (o.$ref as string).split('#');
    if (!results.has(name!)) {
      if ('$default' in o) return structuredClone(o.$default);
      throw new Fault('invalid_reference', 'Referenced step has not completed.');
    }
    try {
      return extractPointerValue(results.get(name!), pointer);
    } catch (e) {
      if ('$default' in o) return structuredClone(o.$default);
      throw e;
    }
  }
  if ('$template' in o && typeof o.$template === 'string') {
    return o.$template.replaceAll(/\{\{(\$?[A-Za-z0-9_-]+(?:#[^}]*)?)\}\}/g, (_match, ref) => {
      const [name, pointer] = (ref as string).split('#');
      if (!results.has(name!))
        throw new Fault('invalid_reference', 'Referenced step has not completed.');
      const val = extractPointerValue(results.get(name!), pointer);
      return typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
    });
  }
  if ('$expr' in o && typeof o.$expr === 'string') {
    return evaluateSafeExpr(o.$expr, results);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveReferences(v, results)]));
}

async function runSingleInvocation(
  step: GraphStep,
  scope: Map<string, unknown>,
  signal: AbortSignal,
  execute: GraphLeafExecutor,
): Promise<unknown> {
  const resolvedArgs = resolveReferences(step.arguments, scope) as Record<string, unknown>;
  // 这几类情况既不能重试也不能用回退值掩盖：等待审批、让出运行槽、整个运行被中止、
  // 副作用结果未知。
  const final = (err: unknown) =>
    err instanceof ApprovalSuspension ||
    err instanceof SchedulingSuspension ||
    signal.aborted ||
    faultOf(err).uncertain === true;
  const attempts = 1 + (step.retry?.attempts ?? 0);
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (step.tool === '$transform') return resolvedArgs;
      return await invokeWithTimeout(step, resolvedArgs, signal, execute);
    } catch (err) {
      if (final(err)) throw err;
      failure = err;
      if (attempt + 1 < attempts && step.retry?.backoff_ms)
        await sleep(step.retry.backoff_ms, signal);
    }
  }
  {
    const err = failure;
    if (!step.fallback) throw err;
    if (step.fallback.tool) {
      const fbArgs = resolveReferences(step.fallback.arguments ?? {}, scope) as Record<
        string,
        unknown
      >;
      if (step.fallback.tool === '$transform') return fbArgs;
      return await execute(
        { ...step, id: `${step.id}_fallback`, tool: step.fallback.tool },
        fbArgs,
        signal,
      );
    }
    return resolveReferences(step.fallback.value, scope);
  }
}

/** 执行一个叶子步骤。第三个参数是这一次尝试的中止信号：整个运行中止或本步骤超时都会触发。 */
export type GraphLeafExecutor = (
  step: GraphStep,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

async function invokeWithTimeout(
  step: GraphStep,
  args: Record<string, unknown>,
  signal: AbortSignal,
  execute: GraphLeafExecutor,
): Promise<unknown> {
  if (step.timeout_ms === undefined) return execute(step, args, signal);
  const attempt = new AbortController();
  const forward = () => attempt.abort();
  signal.addEventListener('abort', forward, { once: true });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    attempt.abort();
  }, step.timeout_ms);
  try {
    return await execute(step, args, attempt.signal);
  } catch (err) {
    // 超时把这次尝试中止了：报成明确的超时，而不是笼统的「已取消」。
    if (
      expired &&
      !signal.aborted &&
      !(err instanceof ApprovalSuspension) &&
      !(err instanceof SchedulingSuspension) &&
      !faultOf(err).uncertain
    )
      throw new Fault(
        'step_timeout',
        `Step '${step.id}' exceeded its ${step.timeout_ms} ms timeout.`,
        504,
      );
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
  }
}

export async function executeGraph(
  steps: GraphStep[],
  concurrency: number,
  signal: AbortSignal,
  execute: GraphLeafExecutor,
  boundary?: (pendingApprovals: string[]) => void,
  initialScope?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Fault('invalid_concurrency', 'Graph concurrency must be a positive integer.');
  checkAbort(signal);
  type State = {
    step: GraphStep;
    waiting: number;
    dependents: State[];
    initialized: boolean;
    blocked: boolean;
    next: number;
    completed: number;
    items?: unknown[];
    selected?: number[];
    mapped?: unknown[];
  };
  type Completion = {
    state: State;
    index: number;
    outcome: PromiseSettledResult<unknown>;
  };
  const results = new Map<string, unknown>(Object.entries(initialScope ?? {}));
  const itemScope = (as: string, item: unknown, index: number) => {
    const scope = new Map(results);
    scope.set('$item', item);
    scope.set('$index', index);
    scope.set(as, item);
    scope.set(`$${as}`, item);
    return scope;
  };
  const states = new Map<string, State>(
    steps.map((step) => [
      step.id,
      {
        step,
        waiting: new Set(step.depends_on).size,
        dependents: [],
        initialized: false,
        blocked: false,
        next: 0,
        completed: 0,
      },
    ]),
  );
  for (const state of states.values()) {
    for (const dep of new Set(state.step.depends_on)) {
      const parent = states.get(dep);
      if (!parent) throw new Fault('invalid_graph', 'Graph references a missing step.');
      parent.dependents.push(state);
    }
  }
  const ready = [...states.values()].filter((state) => state.waiting === 0);
  const completions: Completion[] = [];
  let wake: ((result: Completion) => void) | undefined;
  let active = 0;
  // Each leaf publishes one completion. Slow siblings do not acquire a new reaction every turn.
  const publish = (result: Completion) => {
    if (!wake) completions.push(result);
    else {
      const resume = wake;
      wake = undefined;
      resume(result);
    }
  };
  const failures: PromiseRejectedResult[] = [];
  const approvals = new Set<string>();
  let remaining = steps.length;
  let stopping = false;
  let filterUntil: number | undefined;
  const complete = (state: State, value: unknown) => {
    results.set(state.step.id, value);
    delete state.items;
    delete state.selected;
    remaining--;
    for (const dependent of state.dependents) {
      if (--dependent.waiting === 0) ready.push(dependent);
    }
  };
  const fail = (reason: unknown) => {
    failures.push({ status: 'rejected', reason });
    if (reason instanceof ApprovalSuspension) {
      reason.approvalIds.forEach((id) => approvals.add(id));
    } else stopping = true;
  };

  while (ready.length || active) {
    try {
      checkAbort(signal);
      while (!stopping && active < concurrency && ready.length) {
        const state = ready.shift()!;
        if (state.blocked) continue;
        const step = state.step;
        if (!state.initialized) {
          state.initialized = true;
          if (step.when !== undefined && !resolveReferences(step.when, results)) {
            complete(state, { skipped: true });
            continue;
          }
          if (step.foreach) {
            const [source, pointer] = step.foreach.$ref.split('#');
            if (!results.has(source!))
              throw new Fault('invalid_reference', 'Referenced foreach source has not completed.');
            const items = pointerTarget(results.get(source!), pointer);
            if (!Array.isArray(items))
              throw new Fault(
                'invalid_reference',
                `foreach source '${step.foreach.$ref}' is not an array.`,
              );
            if (items.length > step.foreach.max_items)
              throw new Fault(
                'foreach_limit_exceeded',
                `foreach array length (${items.length}) exceeds max_items (${step.foreach.max_items}).`,
              );
            state.items = structuredClone(items) as unknown[];
            if (step.foreach.where !== undefined) {
              // Validate all predicates before dispatching any side effect of this map.
              state.selected = [];
              filterUntil ??= performance.now() + 4;
              for (const [index, item] of state.items.entries()) {
                // Even an all-false graph must let cancellation and active siblings run.
                if (performance.now() >= filterUntil) {
                  await yieldTurn();
                  checkAbort(signal);
                  if (stopping) break;
                  filterUntil = performance.now() + 4;
                }
                if (resolveReferences(step.foreach.where, itemScope(step.foreach.as, item, index)))
                  state.selected.push(index);
              }
              if (stopping) break;
            }
            state.mapped = new Array(state.selected?.length ?? items.length);
            if (!state.mapped.length) {
              complete(state, []);
              continue;
            }
          }
        }
        const slot = state.next++,
          index = state.selected?.[slot] ?? slot;
        let scope = results;
        let invocation = step;
        if (step.foreach) {
          scope = itemScope(step.foreach.as, state.items![index], index);
          invocation = { ...step, id: `${step.id}_${index}` };
          // One item per visit keeps sibling maps inside the same concurrency budget.
          if (state.next < state.mapped!.length) ready.push(state);
        }
        active++;
        void runSingleInvocation(invocation, scope, signal, execute).then(
          (value) => publish({ state, index: slot, outcome: { status: 'fulfilled', value } }),
          (reason) => {
            // Fence admissions immediately, before the consumer drains a successful sibling.
            state.blocked = true;
            fail(reason);
            publish({ state, index: slot, outcome: { status: 'rejected', reason } });
          },
        );
      }
    } catch (error) {
      fail(error);
    }
    if (!active) break;
    const { state, index, outcome } = await (completions.shift() ??
      new Promise<Completion>((resolve) => {
        wake = resolve;
      }));
    active--;
    if (outcome.status === 'fulfilled') {
      if (state.mapped) {
        state.mapped[index] = outcome.value;
        if (++state.completed === state.mapped.length) complete(state, state.mapped);
      } else complete(state, outcome.value);
    }

    // A boundary may stop admission immediately, but never returns while siblings are active.
    if (boundary && !stopping && ready.some((state) => !state.blocked)) {
      try {
        boundary([...approvals]);
      } catch (error) {
        fail(error);
        stopping = true;
      }
    }
  }
  const pendingApprovals = collectSuspensions(failures);
  checkAbort(signal);
  if (pendingApprovals.length) throw new ApprovalSuspension(pendingApprovals);
  if (remaining) throw new Fault('invalid_graph', 'No executable graph step remains.');
  return Object.fromEntries(steps.map((s) => [s.id, results.get(s.id)]));
}
