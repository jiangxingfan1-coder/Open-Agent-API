import { evaluateAst, validateSafeExpression } from './graph.js';
import { Fault } from '../core/util.js';
import { type Token, type TokenType } from './lexer.js';
import { suggestName } from './suggest.js';

/**
 * 一次编译的解析状态：词法单元、当前位置、`let` 常量表与 `type` 别名表。
 * 各个解析函数都接收同一个上下文，按顺序推进 `pos`。
 */
export class ParseContext {
  pos = 0;
  readonly constants = new Map<string, unknown>();
  // `type Name = <类型>`：只在编译期展开，产物里不留痕迹。
  readonly typeAliases = new Map<string, Record<string, unknown>>();
  /** flow 里 `$NAME` 简写生成的引用对象 → 它的 token；flow 解析完后据此把常量名换成值。 */
  readonly shorthandRefs = new WeakMap<object, Token>();
  private expandedNodes = 0;
  private expandedBytes = 0;

  constructor(readonly tokens: Token[]) {}

  /** Bound expanded aliases/constants, not just the much smaller source spelling. */
  expand<T>(value: T, tok: Token): T {
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (++this.expandedNodes > 100_000 || item.depth > 32)
        this.fail(tok, 'Expanded value exceeds compiler complexity limit.');
      if (typeof item.value === 'string') this.expandedBytes += Buffer.byteLength(item.value);
      else if (item.value && typeof item.value === 'object')
        for (const [key, child] of Object.entries(item.value)) {
          this.expandedBytes += Buffer.byteLength(key);
          pending.push({ value: child, depth: item.depth + 1 });
        }
      if (this.expandedBytes > 8 * 1024 * 1024)
        this.fail(tok, 'Expanded value exceeds compiler size limit.');
    }
    return structuredClone(value);
  }

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  next(): Token {
    return this.tokens[Math.min(this.pos++, this.tokens.length - 1)]!;
  }

  fail(tok: Token, message: string): never {
    throw new Fault('oaa_syntax_error', `Line ${tok.line}, Col ${tok.col}: ${message}`);
  }

  assign(target: Record<string, unknown>, key: string, value: unknown, tok: Token): void {
    if (Object.hasOwn(target, key)) this.fail(tok, `Duplicate property '${key}'.`);
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  knownProperties(value: Record<string, unknown>, allowed: string[], tok: Token): void {
    for (const key of Object.keys(value))
      if (!allowed.includes(key))
        this.fail(tok, `Unknown property '${key}'.${suggestName(key, allowed)}`);
  }

  expect(type: TokenType, label?: string): Token {
    const tok = this.next();
    if (tok.type !== type) {
      this.fail(tok, `Expected ${label ?? type}, but got ${tok.type} ('${tok.value}').`);
    }
    return tok;
  }

  match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.pos++;
      return true;
    }
    return false;
  }

  /**
   * 字符串里的 `${常量}` 插值。没声明的名字原样保留（已有测试钉住了这一行为，见 T12 报告），
   * 所以这里不报错。
   */
  interpolate(tok: Token): string {
    return interpolateString(tok.value, this.constants);
  }

  /**
   * 读一个名字（键名、工具名、各种 ID）：字符串或标识符，原样返回。常量只在值的位置展开，
   * 这里不做替换，免得 `let read_file = "write_file"` 这类声明悄悄改掉名字。
   */
  readStringOrIdent(context: string): string {
    const tok = this.next();
    if (tok.type === 'STRING') return this.interpolate(tok);
    if (tok.type === 'IDENT') return tok.value;
    this.fail(tok, `Expected string or identifier for ${context}.`);
  }

  /** 读一个值位置上的字符串或标识符（例如 route 的目标模型）：标识符若是常量名则展开。 */
  readValueText(context: string): string {
    const tok = this.next();
    if (tok.type === 'STRING') return this.interpolate(tok);
    if (tok.type === 'IDENT') {
      if (this.constants.has(tok.value)) return String(this.constants.get(tok.value));
      if (tok.value.startsWith('$') && this.constants.has(tok.value.slice(1))) {
        return String(this.constants.get(tok.value.slice(1)));
      }
      return tok.value;
    }
    this.fail(tok, `Expected string or identifier for ${context}.`);
  }
}

export function interpolateString(raw: string, constants: Map<string, unknown>): string {
  if (!raw.includes('${')) return raw;
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
    if (!constants.has(name)) return full;
    const val = constants.get(name);
    return typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
  });
}

export function normalizeDollarRef(raw: string, localVars: Set<string>): string {
  // e.g. "$input.primary_path" -> "$input#/primary_path"
  // e.g. "$listing.files.0" -> "listing#/files/0"
  // e.g. "$listing#/files" -> "listing#/files"
  const stripped = raw.startsWith('$') ? raw.slice(1) : raw;
  let base = stripped;
  let ptr = '';
  if (stripped.includes('#')) {
    const [b, p] = stripped.split('#');
    base = b!;
    ptr = p ? (p.startsWith('/') ? p : `/${p}`) : '';
  } else if (stripped.includes('.')) {
    const parts = stripped.split('.');
    base = parts[0]!;
    ptr = '/' + parts.slice(1).join('/');
  }
  const isSpecial = base === 'input' || base === 'item' || base === 'index' || localVars.has(base);
  const finalBase = isSpecial
    ? base === 'input'
      ? '$input'
      : base.startsWith('$')
        ? base
        : `$${base}`
    : base;
  return `${finalBase}${ptr ? `#${ptr}` : ''}`;
}

export function parseValue(ctx: ParseContext, depth = 0): unknown {
  if (depth > 32) ctx.fail(ctx.peek(), 'Nested value depth exceeds compiler limit.');
  const tok = ctx.peek();
  if (tok.type === 'STRING') {
    ctx.next();
    return ctx.interpolate(tok);
  }
  if (tok.type === 'NUMBER') {
    ctx.next();
    return Number(tok.value);
  }
  if (tok.type === 'EXPR') {
    ctx.next();
    evaluateAst(tok.value); // Validate AST syntax at compile time
    return { $expr: tok.value };
  }
  if (tok.type === 'IDENT') {
    ctx.next();
    if (tok.value === 'true') return true;
    if (tok.value === 'false') return false;
    if (tok.value === 'null') return null;
    if (ctx.constants.has(tok.value)) {
      return ctx.expand(ctx.constants.get(tok.value), tok);
    }
    if (tok.value.startsWith('$') && ctx.constants.has(tok.value.slice(1))) {
      return ctx.expand(ctx.constants.get(tok.value.slice(1)), tok);
    }
    return tok.value;
  }
  if (tok.type === 'LBRACKET') {
    ctx.next();
    const arr: unknown[] = [];
    while (ctx.peek().type !== 'RBRACKET' && ctx.peek().type !== 'EOF') {
      arr.push(parseValue(ctx, depth + 1));
      ctx.match('COMMA');
    }
    ctx.expect('RBRACKET', ']');
    return arr;
  }
  if (tok.type === 'LBRACE') {
    ctx.next();
    const obj: Record<string, unknown> = {};
    while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
      const key = ctx.readStringOrIdent('object key');
      if (!ctx.match('EQ') && !ctx.match('COLON')) {
        if (ctx.peek().type !== 'LBRACE') {
          ctx.fail(ctx.peek(), `Expected '=' or ':' after key '${key}'.`);
        }
      }
      ctx.assign(obj, key, parseValue(ctx, depth + 1), tok);
      ctx.match('COMMA');
    }
    ctx.expect('RBRACE', '}');
    return obj;
  }
  ctx.fail(tok, `Unexpected token '${tok.value}' while parsing value.`);
}

// Parse value inside a `flow` step (supports $refs, $(expr), "{{template}}", arrays, objects)
export function parseFlowValue(ctx: ParseContext, localVars: Set<string>, depth = 0): unknown {
  if (depth > 32) ctx.fail(ctx.peek(), 'Flow expression nesting exceeds limit.');
  const tok = ctx.peek();
  if (tok.type === 'EXPR') {
    ctx.next();
    validateSafeExpression(tok.value);
    return { $expr: tok.value };
  }
  if (tok.type === 'IDENT' && tok.value === 'literal' && ctx.peek(1).type === 'LPAREN') {
    ctx.next();
    ctx.next();
    const value = parseValue(ctx, depth + 1);
    ctx.expect('RPAREN', ')');
    if (typeof value !== 'string') ctx.fail(tok, 'literal(...) requires a string.');
    return value;
  }
  if (tok.type === 'IDENT' && tok.value.startsWith('$')) {
    ctx.next();
    const refStr = normalizeDollarRef(tok.value, localVars);
    if (
      ctx.peek().type === 'IDENT' &&
      ctx.peek().value === 'default' &&
      ctx.peek(1).type === 'EQ'
    ) {
      ctx.next();
      ctx.next();
      const withDefault = { $ref: refStr, $default: parseValue(ctx, depth + 1) };
      ctx.shorthandRefs.set(withDefault, tok);
      return withDefault;
    }
    const ref = { $ref: refStr };
    ctx.shorthandRefs.set(ref, tok);
    return ref;
  }
  if (tok.type === 'STRING') {
    ctx.next();
    const interpolated = ctx.interpolate(tok);
    if (/\{\{[^}]+\}\}/.test(interpolated)) {
      const normalizedTpl = interpolated.replace(
        /\{\{(\$?[A-Za-z0-9_.-]+(?:#[^}]*)?)\}\}/g,
        (_m, rawRef: string) => {
          if (rawRef.includes('.') && !rawRef.includes('#')) {
            return `{{${normalizeDollarRef(rawRef, localVars)}}}`;
          }
          if (
            rawRef.startsWith('$') &&
            !rawRef.startsWith('$input') &&
            !rawRef.startsWith('$item') &&
            !rawRef.startsWith('$index')
          ) {
            const clean = rawRef.slice(1);
            if (!localVars.has(clean.split('#')[0]!)) return `{{${clean}}}`;
          }
          return `{{${rawRef}}}`;
        },
      );
      return { $template: normalizedTpl };
    }
    return interpolated;
  }
  if (tok.type === 'LBRACKET') {
    ctx.next();
    const arr: unknown[] = [];
    while (ctx.peek().type !== 'RBRACKET' && ctx.peek().type !== 'EOF') {
      arr.push(parseFlowValue(ctx, localVars, depth + 1));
      ctx.match('COMMA');
    }
    ctx.expect('RBRACKET', ']');
    return arr;
  }
  if (tok.type === 'LBRACE') {
    ctx.next();
    const obj: Record<string, unknown> = {};
    while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
      const k = ctx.readStringOrIdent('flow object key');
      if (!ctx.match('EQ') && !ctx.match('COLON')) {
        if (ctx.peek().type !== 'LBRACE') {
          ctx.fail(ctx.peek(), `Expected '=' or ':' after key '${k}'.`);
        }
      }
      // Descriptor strings and defaults are data in the JSON graph ABI, not another
      // layer of DSL interpolation/reference syntax.
      const value = ['$ref', '$expr', '$template', '$default'].includes(k)
        ? parseValue(ctx, depth + 1)
        : parseFlowValue(ctx, localVars, depth + 1);
      ctx.assign(obj, k, value, tok);
      ctx.match('COMMA');
    }
    ctx.expect('RBRACE', '}');
    return obj;
  }
  return parseValue(ctx, depth + 1);
}
