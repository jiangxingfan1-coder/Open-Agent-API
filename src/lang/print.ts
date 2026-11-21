import { type AgentDefinition } from '../core/contracts.js';
import { builtin } from '../core/builtins.js';
import { canonical, Fault } from '../core/util.js';
import { compileOaaLang, type CompiledOaaSource } from './compile.js';
import { constantOrString, printableConstants, toolBlock, tripleQuoted } from './render-parts.js';

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HAS_TEMPLATE = /\{\{[^}]+\}\}/;
/** 词法上能当成一个标识符读回来的步骤 ID；其余的加引号。 */
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `{ "$ref": "listing#/files/0" }` → `$listing.files.0`；写不成简洁形式时返回 undefined。 */
function sugarRef(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const [rawBase, pointer, ...rest] = ref.split('#');
  if (rest.length || rawBase === undefined) return undefined;
  const base = rawBase.startsWith('$') ? rawBase.slice(1) : rawBase;
  if (!SAFE_NAME.test(base)) return undefined;
  if (pointer === undefined) return `$${base}`;
  if (!pointer.startsWith('/')) return undefined;
  const segments = pointer.slice(1).split('/');
  if (!segments.every((segment) => /^[A-Za-z0-9_]+$/.test(segment))) return undefined;
  return `$${base}.${segments.join('.')}`;
}

/** 模板里的 `{{step#/a/b}}` 还原成 `{{step.a.b}}`。 */
function sugarTemplate(template: string): string {
  return template.replace(
    /\{\{(\$?[A-Za-z_][A-Za-z0-9_]*)#\/([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)\}\}/g,
    (_match, base: string, pointer: string) => `{{${base}.${pointer.split('/').join('.')}}}`,
  );
}

/** 表达式能否安全地写成 `$(...)`：单行、括号配平、引号闭合。 */
function sugarExpr(expr: unknown): string | undefined {
  if (typeof expr !== 'string' || !expr.trim() || /[\n\r`]/.test(expr)) return undefined;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return undefined;
  }
  return depth === 0 && !quote ? `$(${expr})` : undefined;
}

/**
 * 打印流程里的值。`sugar` 为真时把引用、表达式和模板还原成人写的简洁形式
 * （`$step.field`、`$(expr)`、`"...{{ref}}..."`），对象的键在安全时不加引号。
 * 调用方会把结果重新编译比对，所以这里只需要保证「写得出来」，等价性由比对兜底。
 */
function formatFlowArgValue(val: unknown, sugar = false): string {
  if (typeof val === 'string' && HAS_TEMPLATE.test(val)) return `literal(${JSON.stringify(val)})`;
  if (!val || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val))
    return `[${val.map((item) => formatFlowArgValue(item, sugar)).join(', ')}]`;
  const o = val as Record<string, unknown>;
  const keys = Object.keys(o);
  if (sugar && keys.length === 1) {
    const short =
      keys[0] === '$ref'
        ? sugarRef(o.$ref)
        : keys[0] === '$expr'
          ? sugarExpr(o.$expr)
          : keys[0] === '$template' &&
              typeof o.$template === 'string' &&
              HAS_TEMPLATE.test(o.$template)
            ? JSON.stringify(sugarTemplate(o.$template))
            : undefined;
    if (short !== undefined) return short;
  }
  const entries = Object.entries(o).map(
    ([k, v]) =>
      `${sugar && SAFE_NAME.test(k) ? k : JSON.stringify(k)}: ${
        ['$ref', '$expr', '$template', '$default'].includes(k)
          ? JSON.stringify(v)
          : formatFlowArgValue(v, sugar)
      }`,
  );
  return `{ ${entries.join(', ')} }`;
}

// ── JSON Schema → 类型写法 ──
// 只处理类型写法本身能生成的那部分 Schema；任何拿不准的情况都返回 undefined，由调用方退回
// `json { ... }`。这样打印出来的写法重新编译后一定得到同一份 Schema。

const DSL_SCALARS: Record<string, string> = {
  string: 'string',
  integer: 'int',
  number: 'number',
  boolean: 'bool',
  object: 'object',
};
const dslString = (value: string): string | undefined =>
  value.includes('${') || value.includes('{{') ? undefined : JSON.stringify(value);
const dslNumber = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : undefined;

type AliasNames = ReadonlyMap<string, string>;

function schemaToTypeSpec(
  schema: unknown,
  indent: string,
  aliases?: AliasNames,
): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  // 与某个别名展开后完全相同的类型，直接写别名的名字。
  const alias = aliases?.get(canonical(schema));
  if (alias !== undefined) return alias;
  const node = schema as Record<string, unknown>;
  const keys = Object.keys(node);
  // 数组：T[]
  if (node.type === 'array') {
    if (keys.length !== 2 || !('items' in node)) return undefined;
    const item = schemaToTypeSpec(node.items, indent, aliases);
    return item === undefined ? undefined : `${item}[]`;
  }
  // 字面量联合："a" | "b" 或 1 | 2
  if (Array.isArray(node.enum)) {
    if (keys.length !== 2 || !node.enum.length) return undefined;
    const parts =
      node.type === 'string' && node.enum.every((v) => typeof v === 'string')
        ? node.enum.map((v) => dslString(v as string))
        : node.type === 'number' && node.enum.every((v) => typeof v === 'number')
          ? node.enum.map(dslNumber)
          : [undefined];
    return parts.every((part) => part !== undefined) ? parts.join(' | ') : undefined;
  }
  // 嵌套对象：{ field: type }
  if (node.type === 'object' && 'properties' in node)
    return schemaToTypeBlock(node, indent, aliases);
  // 标量与 any，可带描述和约束
  const base = keys.includes('type') ? DSL_SCALARS[String(node.type)] : 'any';
  if (!base || (node.type === undefined && 'type' in node)) return undefined;
  const facets: string[] = [];
  const text = node.type === 'string';
  for (const key of keys) {
    const value = node[key];
    let facet: string | undefined;
    if (key === 'type') continue;
    else if (key === 'description' && typeof value === 'string') facet = dslString(value);
    else if (key === 'minLength' && text) facet = dslNumber(value) && `min=${dslNumber(value)}`;
    else if (key === 'maxLength' && text) facet = dslNumber(value) && `max=${dslNumber(value)}`;
    else if (key === 'minimum' && !text) facet = dslNumber(value) && `min=${dslNumber(value)}`;
    else if (key === 'maximum' && !text) facet = dslNumber(value) && `max=${dslNumber(value)}`;
    else if (key === 'pattern' && typeof value === 'string')
      facet = dslString(value) && `pattern=${dslString(value)}`;
    else if (key === 'default') {
      const printed =
        typeof value === 'string'
          ? dslString(value)
          : typeof value === 'boolean'
            ? String(value)
            : dslNumber(value);
      facet = printed && `default=${printed}`;
    }
    if (!facet) return undefined;
    facets.push(facet);
  }
  return facets.length ? `${base}(${facets.join(', ')})` : base;
}

function schemaToTypeBlock(
  schema: unknown,
  indent: string,
  aliases?: AliasNames,
): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const node = schema as Record<string, unknown>;
  const allowed = ['type', 'properties', 'required', 'additionalProperties'];
  if (
    node.type !== 'object' ||
    node.additionalProperties !== false ||
    Object.keys(node).some((key) => !allowed.includes(key)) ||
    !node.properties ||
    typeof node.properties !== 'object' ||
    Array.isArray(node.properties)
  )
    return undefined;
  const properties = node.properties as Record<string, unknown>;
  const names = Object.keys(properties);
  const required = node.required === undefined ? [] : node.required;
  if (!Array.isArray(required) || ('required' in node && !required.length)) return undefined;
  // 第一个字段叫 type 且后面跟字符串时，会被编译器当成原始 JSON Schema。
  if (names[0] === 'type') return undefined;
  const fields: string[] = [];
  const expectRequired: string[] = [];
  for (const name of names) {
    const spec = schemaToTypeSpec(properties[name], `${indent}  `, aliases);
    if (spec === undefined) return undefined;
    const field = properties[name] as Record<string, unknown>;
    // 通过别名引用的类型，默认值藏在别名里，编译器不会因此把字段当成可选。
    const viaAlias = aliases?.has(canonical(field)) ?? false;
    const hasDefault = 'default' in field && !viaAlias;
    const isRequired = required.includes(name);
    // 类型写法里：带默认值的字段不算必填；必填又带默认值的情况它表达不了。
    if (isRequired && hasDefault) return undefined;
    if (isRequired) expectRequired.push(name);
    const label = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
    fields.push(`${label}${!isRequired && !hasDefault ? '?' : ''}: ${spec}`);
  }
  if (JSON.stringify(expectRequired) !== JSON.stringify(required)) return undefined;
  if (!fields.length) return '{}';
  const oneLine = `{ ${fields.join(' ')} }`;
  return oneLine.length + indent.length <= 88 && !oneLine.includes('\n')
    ? oneLine
    : `{\n${fields.map((f) => `${indent}  ${f}`).join('\n')}\n${indent}}`;
}

/** 一种候选写法用到哪些讲究的形式。 */
interface RenderOptions {
  /** 类型写法、引用简写、三引号、合并 use builtin。 */
  typeDsl: boolean;
  typeAliases?: Record<string, Record<string, unknown>>;
  constants?: Record<string, unknown>;
  /** tool 用 snake_case 的块写法，而不是完整绑定的 JSON。 */
  toolBlocks?: boolean;
}

/**
 * 把智能体定义还原成 OAA-Lang 源码。能用简洁类型写法精确表达的 Schema 就用类型写法，其余用
 * `json { ... }`；如果带类型写法的结果重新编译后与原定义有任何出入，整体退回纯 JSON 写法。
 * `typeAliases`、`constants` 是编译结果里仅供格式化用的别名与 `let` 常量，尽量原样保留。
 */
export function decompileToOaaLang(
  agent: AgentDefinition,
  files: string[] = [],
  typeAliases: Record<string, Record<string, unknown>> = {},
  constants: Record<string, unknown> = {},
): string {
  const contract = (compiled: CompiledOaaSource) =>
    canonical({ agent: compiled.agent, files: compiled.files });
  const plain = renderOaaLang(agent, files, { typeDsl: false });
  const reference = () => contract(compileOaaLang(plain));
  const hasAliases = Object.keys(typeAliases).length > 0;
  const hasLets = Object.keys(constants).length > 0;
  // 从最讲究的写法试到最朴素的写法：别名与 let 与 tool 块写法 → 逐项去掉 → 只用类型写法 →
  // 纯 JSON。每一种都要重新编译比对，取第一个通过的。
  const options: RenderOptions[] = [
    ...(hasAliases ? [{ typeDsl: true, typeAliases, constants, toolBlocks: true }] : []),
    { typeDsl: true, constants, toolBlocks: true },
    ...(hasLets ? [{ typeDsl: true, toolBlocks: true }] : []),
    ...(hasLets ? [{ typeDsl: true, constants }] : []),
    { typeDsl: true },
  ];
  const tried = new Set<string>();
  for (const option of options) {
    const candidate = renderOaaLang(agent, files, option);
    if (candidate === plain) return plain;
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      if (contract(compileOaaLang(candidate)) === reference()) return candidate;
    } catch {
      // 这种写法行不通，试下一种。
    }
  }
  return plain;
}

function renderOaaLang(agent: AgentDefinition, files: string[], options: RenderOptions): string {
  const { typeDsl, typeAliases = {}, constants = {}, toolBlocks = false } = options;
  const lets = typeDsl ? printableConstants(constants) : [];
  // 别名声明放在最前面；只要有一个别名写不成类型写法，就整体不用别名。
  const declarations: string[] = lets.map(([name, value]) => `let ${name} = ${value}`);
  const aliasNames = new Map<string, string>();
  for (const [name, schema] of Object.entries(typeAliases)) {
    const spec = schemaToTypeSpec(schema, '');
    if (spec === undefined || !SAFE_NAME.test(name)) {
      declarations.length = lets.length;
      aliasNames.clear();
      break;
    }
    declarations.push(`type ${name} = ${spec}`);
    if (!aliasNames.has(canonical(schema))) aliasNames.set(canonical(schema), name);
  }
  const str = (value: string) =>
    lets.length ? constantOrString(value, lets) : JSON.stringify(value);
  const schemaBlock = (schema: unknown, indent: string) =>
    typeDsl ? schemaToTypeBlock(schema, indent, aliasNames) : undefined;
  const block = schemaBlock;
  const fv = (value: unknown) => formatFlowArgValue(value, typeDsl);
  const argName = (name: string) => (typeDsl && SAFE_NAME.test(name) ? name : JSON.stringify(name));
  const lines: string[] = [
    ...(declarations.length ? [...declarations, ''] : []),
    `agent ${JSON.stringify(agent.id)} {`,
  ];
  lines.push(`  description = ${str(agent.description)}`);
  lines.push(
    `  engine      = ${/^[a-z]+$/.test(agent.engine) ? agent.engine : JSON.stringify(agent.engine)}`,
  );
  lines.push(`  provider    = ${str(agent.provider)}`);
  lines.push(`  model       = ${str(agent.model)}`);
  if (!agent.allowGraph) lines.push(`  allow_graph = false`);
  if (agent.approvals === 'auto') lines.push(`  approvals = auto`);
  if (agent.modelPolicy) lines.push(`  model_policy = ${JSON.stringify(agent.modelPolicy)}`);
  if (agent.access) lines.push(`  access = ${JSON.stringify(agent.access)}`);
  if (agent.orchestration) lines.push(`  orchestration = ${JSON.stringify(agent.orchestration)}`);
  if (agent.allowedNodes?.length) {
    lines.push(`  allowed_nodes = ${JSON.stringify(agent.allowedNodes)}`);
  }
  if (files.length) {
    lines.push(`  files = ${JSON.stringify(files)}`);
  }
  if (agent.skills.length) lines.push(`  skills = ${JSON.stringify(agent.skills)}`);

  if (agent.routes.length) {
    lines.push('');
    for (const r of agent.routes) {
      const extras: string[] = [`priority=${r.priority}`];
      if (r.costTier !== undefined) extras.push(`cost=${r.costTier}`);
      if (r.speedTier !== undefined) extras.push(`speed=${r.speedTier}`);
      if (r.qualityTier !== undefined) extras.push(`quality=${r.qualityTier}`);
      if (r.tags !== undefined) extras.push(`tags=${JSON.stringify(r.tags)}`);
      lines.push(
        `  route ${JSON.stringify(r.id)} -> ${JSON.stringify(r.provider)}/${JSON.stringify(r.model)} ${extras.join(' ')}`,
      );
    }
  }

  const plainBuiltin = (tool: AgentDefinition['tools'][number]) =>
    tool.handler.kind === 'builtin' && canonical(tool) === canonical(builtin(tool.handler.name));
  for (let i = 0; i < agent.tools.length; i++) {
    const tool = agent.tools[i]!;
    lines.push('');
    const block = toolBlocks ? toolBlock(tool, schemaBlock) : undefined;
    if (plainBuiltin(tool)) {
      // 连续的几条 `use builtin` 合并成列表写法。
      const run = [tool.handler.kind === 'builtin' ? tool.handler.name : tool.name];
      while (typeDsl && agent.tools[i + 1] && plainBuiltin(agent.tools[i + 1]!)) {
        const nextTool = agent.tools[++i]!;
        run.push(nextTool.handler.kind === 'builtin' ? nextTool.handler.name : nextTool.name);
      }
      lines.push(run.length > 1 ? `  use builtin [${run.join(', ')}]` : `  use builtin ${run[0]}`);
    } else if (block) {
      lines.push(...block);
    } else {
      // The exact binding form retains permission, placement and future optional fields.
      const { name, ...binding } = tool;
      lines.push(
        `  tool ${JSON.stringify(name)} = ${JSON.stringify(binding, null, 2).replace(/\n/g, '\n  ')}`,
      );
    }
  }

  for (const d of agent.delegates ?? []) {
    lines.push('');
    lines.push(`  delegate ${JSON.stringify(d.name)} -> ${JSON.stringify(d.agent)} {`);
    if (d.model) lines.push(`    model         = ${JSON.stringify(d.model)}`);
    lines.push(`    description   = ${JSON.stringify(d.description)}`);
    lines.push(`    timeout_ms    = ${d.timeoutMs}`);
    if (d.forwardFiles) lines.push(`    forward_files = true`);
    lines.push('  }');
  }

  for (const wf of agent.workflows ?? []) {
    lines.push('');
    lines.push(`  flow ${JSON.stringify(wf.name)} {`);
    lines.push(`    description  = ${JSON.stringify(wf.description)}`);
    const paramsBlock = block(wf.inputSchema, '    ');
    lines.push(
      paramsBlock !== undefined
        ? `    params ${paramsBlock}`
        : `    input_schema = json ${JSON.stringify(wf.inputSchema, null, 2).replace(/\n/g, '\n    ')}`,
    );
    for (const rawStep of wf.steps) {
      const s = rawStep as {
        id: string;
        tool: string;
        arguments: Record<string, unknown>;
        depends_on?: string[];
        when?: unknown;
        foreach?: { $ref: string; as: string; max_items: number; where?: unknown };
        fallback?: { tool?: string; arguments?: Record<string, unknown>; value?: unknown };
        retry?: { attempts: number; backoff_ms?: number };
        timeout_ms?: number;
      };
      const argPairs = Object.entries(s.arguments ?? {}).map(
        ([k, v]) => `${argName(k)} = ${fv(v)}`,
      );
      let stepLine = `    step ${STEP_ID.test(s.id) ? s.id : JSON.stringify(s.id)} = ${s.tool}(${argPairs.join(', ')})`;
      if (s.foreach) {
        const ref =
          (typeDsl ? sugarRef(s.foreach.$ref) : undefined) ??
          (s.foreach.$ref.startsWith('$') ? s.foreach.$ref : `$${s.foreach.$ref}`);
        stepLine += ` foreach ${s.foreach.as} in ${ref} (max=${s.foreach.max_items})`;
        if (s.foreach.where !== undefined) stepLine += ` where ${fv(s.foreach.where)}`;
      }
      if (s.depends_on?.length) stepLine += ` depends_on = ${JSON.stringify(s.depends_on)}`;
      if (s.when !== undefined) {
        stepLine += ` when ${fv(s.when)}`;
      }
      if (s.fallback) {
        if (s.fallback.tool) {
          const fbPairs = Object.entries(s.fallback.arguments ?? {}).map(
            ([k, v]) => `${argName(k)} = ${fv(v)}`,
          );
          stepLine += ` fallback ${s.fallback.tool}(${fbPairs.join(', ')})`;
        } else {
          stepLine += ` fallback = ${fv(s.fallback.value)}`;
        }
      }
      if (s.retry)
        stepLine +=
          s.retry.backoff_ms !== undefined
            ? ` retry(${s.retry.attempts}, backoff=${s.retry.backoff_ms}ms)`
            : ` retry ${s.retry.attempts}`;
      if (s.timeout_ms !== undefined) stepLine += ` timeout ${s.timeout_ms}ms`;
      lines.push(stepLine);
    }
    if (wf.outputSchema) {
      const outputBlock = block(wf.outputSchema, '    ');
      lines.push(
        outputBlock !== undefined
          ? `    output_schema ${outputBlock}`
          : `    output_schema = json ${JSON.stringify(wf.outputSchema, null, 2).replace(/\n/g, '\n    ')}`,
      );
    }
    if (wf.output !== undefined) lines.push(`    return ${fv(wf.output)}`);
    lines.push('  }');
  }

  lines.push('');
  lines.push('  limits {');
  lines.push(`    max_turns         = ${agent.limits.maxTurns}`);
  lines.push(`    max_output_tokens = ${agent.limits.maxOutputTokens}`);
  lines.push(`    timeout_ms        = ${agent.limits.timeoutMs}`);
  lines.push(`    tool_concurrency  = ${agent.limits.toolConcurrency}`);
  lines.push(`    max_total_tokens  = ${agent.limits.maxTotalTokens}`);
  lines.push('  }');

  if (agent.outputSchema) {
    lines.push('');
    const outputBlock = block(agent.outputSchema, '  ');
    lines.push(
      outputBlock !== undefined
        ? `  output_schema ${outputBlock}`
        : `  output_schema = json ${JSON.stringify(agent.outputSchema, null, 2).replace(/\n/g, '\n  ')}`,
    );
  }

  if (agent.instructions) {
    lines.push('');
    lines.push(
      `  instructions = ${(typeDsl && tripleQuoted(agent.instructions, '  ')) || JSON.stringify(agent.instructions)}`,
    );
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

export function formatOaaLang(source: string): string {
  const compiled = compileOaaLang(source);
  const formatted = decompileToOaaLang(
    compiled.agent,
    compiled.files,
    compiled.typeAliases,
    compiled.constants,
  );
  const contract = (c: CompiledOaaSource) =>
    canonical({ agent: c.agent, files: c.files, workflowPlans: c.workflowPlans });
  if (contract(compileOaaLang(formatted)) !== contract(compiled))
    throw new Fault(
      'oaa_roundtrip_error',
      'Formatting would change the compiled execution contract.',
    );
  return formatted;
}
