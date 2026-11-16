import { type Token } from './lexer.js';
import { parseValue, type ParseContext } from './parser.js';
import { suggestName, TYPE_NAMES } from './suggest.js';

// Parse Type-DSL specification (e.g. string("desc", min=1, max=100)[], "a" | "b", int(default=10), { ... })
export function parseTypeSpec(
  ctx: ParseContext,
  depth = 0,
): { schema: Record<string, unknown>; hasDefault: boolean } {
  if (depth > 16) ctx.fail(ctx.peek(), 'Type specification nesting exceeds compiler limit.');
  let baseSchema: Record<string, unknown>;
  let hasDefault = false;

  const first = ctx.peek();
  // Union literal enum: "fast" | "balanced" | "deep"
  if (first.type === 'STRING' || first.type === 'NUMBER') {
    const literals: (string | number)[] = [];
    const isNum = first.type === 'NUMBER';
    literals.push(isNum ? Number(ctx.next().value) : ctx.interpolate(ctx.next()));
    while (ctx.match('PIPE')) {
      const litTok = ctx.next();
      if (litTok.type !== 'STRING' && litTok.type !== 'NUMBER') {
        ctx.fail(litTok, 'Expected string or number literal in union type.');
      }
      if ((litTok.type === 'NUMBER') !== isNum)
        ctx.fail(litTok, 'A union type cannot mix string and number literals.');
      literals.push(litTok.type === 'NUMBER' ? Number(litTok.value) : ctx.interpolate(litTok));
    }
    baseSchema = {
      type: isNum ? 'number' : 'string',
      enum: literals,
    };
  } else if (first.type === 'LBRACE') {
    baseSchema = parseTypeDslBlock(ctx, depth + 1);
  } else if (first.type === 'IDENT') {
    const typeIdent = ctx.next().value.toLowerCase();
    if (typeIdent === 'string' || typeIdent === 'str') baseSchema = { type: 'string' };
    else if (typeIdent === 'int' || typeIdent === 'integer') baseSchema = { type: 'integer' };
    else if (typeIdent === 'number' || typeIdent === 'float') baseSchema = { type: 'number' };
    else if (typeIdent === 'bool' || typeIdent === 'boolean') baseSchema = { type: 'boolean' };
    else if (typeIdent === 'object' || typeIdent === 'json') baseSchema = { type: 'object' };
    else if (typeIdent === 'any') baseSchema = {};
    else if (ctx.typeAliases.has(first.value))
      baseSchema = ctx.expand(ctx.typeAliases.get(first.value)!, first);
    else
      ctx.fail(
        first,
        `Unknown type '${first.value}' in schema DSL.${suggestName(first.value, [...TYPE_NAMES, ...ctx.typeAliases.keys()])}`,
      );

    // Optional facet modifiers: string("Description", min=1, max=200, pattern="...", default="...")
    if (ctx.match('LPAREN')) {
      while (ctx.peek().type !== 'RPAREN' && ctx.peek().type !== 'EOF') {
        if (
          ctx.peek().type === 'STRING' &&
          ctx.peek(1).type !== 'EQ' &&
          ctx.peek(1).type !== 'COLON'
        ) {
          baseSchema.description = ctx.interpolate(ctx.next());
        } else {
          const facetTok = ctx.peek();
          const facetKey = ctx.readStringOrIdent('type constraint');
          ctx.expect('EQ', '=');
          const facetVal = parseValue(ctx, depth + 1);
          applyFacet(ctx, baseSchema, first.value, facetTok, facetKey, facetVal);
          if (facetKey === 'default') hasDefault = true;
        }
        ctx.match('COMMA');
      }
      ctx.expect('RPAREN', ')');
    }
  } else {
    ctx.fail(first, `Expected type specification, got '${first.value}'.`);
  }

  // Check optional array suffix []
  while (ctx.peek().type === 'LBRACKET' && ctx.peek(1).type === 'RBRACKET') {
    if (++depth > 16) ctx.fail(ctx.peek(), 'Type specification nesting exceeds compiler limit.');
    ctx.next();
    ctx.next();
    baseSchema = { type: 'array', items: baseSchema };
  }

  hasDefault = Object.hasOwn(baseSchema, 'default');
  return { schema: baseSchema, hasDefault };
}

// Parse a Type-DSL block `{ field: string, opt?: int(min=1) }` OR raw JSON Schema block `{ type = "object", ... }`
export function parseTypeDslBlock(ctx: ParseContext, depth = 0): Record<string, unknown> {
  if (ctx.peek().type === 'IDENT' && ctx.peek().value === 'json') {
    const marker = ctx.next();
    const value = parseValue(ctx, depth);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      ctx.fail(marker, 'json schema requires an object.');
    return value as Record<string, unknown>;
  }
  // Detect if this is a raw JSON Schema block: `{ type = "object", properties = ... }` or `{ type: "object", ... }`
  if (
    ctx.peek().type === 'LBRACE' &&
    (ctx.peek(1).type === 'IDENT' || ctx.peek(1).type === 'STRING') &&
    ctx.peek(1).value === 'type' &&
    (ctx.peek(2).type === 'EQ' || ctx.peek(2).type === 'COLON') &&
    ctx.peek(3).type === 'STRING'
  ) {
    return parseValue(ctx, depth) as Record<string, unknown>;
  }

  ctx.expect('LBRACE', '{');
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
    const fieldToken = ctx.peek();
    const fieldName = ctx.readStringOrIdent('schema field name');
    const isOptional = ctx.match('QUESTION');
    if (!ctx.match('COLON') && !ctx.match('EQ')) {
      if (ctx.peek().type !== 'LBRACE') {
        ctx.fail(ctx.peek(), `Expected ':' or '=' after schema field '${fieldName}'.`);
      }
    }
    const { schema, hasDefault } = parseTypeSpec(ctx, depth + 1);
    ctx.assign(properties, fieldName, schema, fieldToken);
    if (!isOptional && !hasDefault) {
      required.push(fieldName);
    }
    ctx.match('COMMA');
  }
  ctx.expect('RBRACE', '}');
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** `type Name = <类型>`：调用时 `type` 关键字已被读掉。 */
export function declareType(ctx: ParseContext): void {
  const nameTok = ctx.expect('IDENT', 'type alias name');
  if (BUILTIN_TYPE_SPELLINGS.includes(nameTok.value.toLowerCase()))
    ctx.fail(nameTok, `Type alias '${nameTok.value}' would shadow a built-in type.`);
  if (ctx.typeAliases.has(nameTok.value))
    ctx.fail(nameTok, `Duplicate type alias '${nameTok.value}'.`);
  ctx.expect('EQ', '=');
  ctx.typeAliases.set(nameTok.value, parseTypeSpec(ctx).schema);
}

/** 类型写法里内置类型的全部拼法（不分大小写），别名不许与它们同名。 */
const BUILTIN_TYPE_SPELLINGS = [...TYPE_NAMES, 'str'];
const TYPE_MODIFIERS = ['description', 'min', 'max', 'pattern', 'default', 'enum'];

/** 默认值是否符合类型；没有 `type` 的（any）什么都接受。 */
function matchesType(type: unknown, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return true;
}

/** 把一个类型修饰（`min=1`、`default="x"` 等）写进 Schema；修饰与类型不符时报错。 */
function applyFacet(
  ctx: ParseContext,
  baseSchema: Record<string, unknown>,
  typeName: string,
  facetTok: Token,
  facetKey: string,
  facetVal: unknown,
): void {
  const type = baseSchema.type;
  const misplaced = (): never =>
    ctx.fail(facetTok, `Type modifier '${facetKey}' does not apply to type '${typeName}'.`);
  if (facetKey === 'description' || facetKey === 'desc') {
    if (typeof facetVal !== 'string')
      ctx.fail(facetTok, `Type modifier '${facetKey}' must be a string.`);
    baseSchema.description = facetVal;
  } else if (facetKey === 'min' || facetKey === 'max') {
    if (type !== 'string' && type !== 'integer' && type !== 'number') misplaced();
    if (typeof facetVal !== 'number')
      ctx.fail(facetTok, `Type modifier '${facetKey}' must be a number.`);
    if (type === 'string') baseSchema[facetKey === 'min' ? 'minLength' : 'maxLength'] = facetVal;
    else baseSchema[facetKey === 'min' ? 'minimum' : 'maximum'] = facetVal;
  } else if (facetKey === 'pattern') {
    if (type !== 'string') misplaced();
    if (typeof facetVal !== 'string')
      ctx.fail(facetTok, "Type modifier 'pattern' must be a string.");
    baseSchema.pattern = facetVal;
  } else if (facetKey === 'default') {
    if (!matchesType(type, facetVal))
      ctx.fail(facetTok, `Type modifier 'default' does not match type '${typeName}'.`);
    baseSchema.default = facetVal;
  } else if (facetKey === 'enum') {
    if (!Array.isArray(facetVal)) ctx.fail(facetTok, "Type modifier 'enum' must be an array.");
    baseSchema.enum = facetVal;
  } else {
    ctx.fail(
      facetTok,
      `Unknown type modifier '${facetKey}'.${suggestName(facetKey, TYPE_MODIFIERS)}`,
    );
  }
}
