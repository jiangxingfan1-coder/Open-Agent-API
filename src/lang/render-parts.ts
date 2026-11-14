import { type ToolBinding } from '../core/contracts.js';
import { dedentTripleString } from './lexer.js';

// 格式化器里几种「讲究的写法」：保留 let 声明、三引号字符串、tool 的块写法（snake_case）。
// 每一种都只在能精确还原时才用；整体结果还要由 decompileToOaaLang 重新编译比对兜底。

const IDENT = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const KEYWORDS = new Set(['true', 'false', 'null']);

/** 能原样写回去的常量：名字是合法标识符，值能写成 JSON 且不会在重新解析时被插值。 */
export function printableConstants(constants: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(constants)) {
    if (!IDENT.test(name) || KEYWORDS.has(name) || name.startsWith('$')) continue;
    const text = JSON.stringify(value);
    if (text === undefined || text.includes('${')) continue;
    out.push([name, text]);
  }
  return out;
}

/** 值恰好等于唯一一个字符串常量时，写常量名；否则写 JSON 字符串。 */
export function constantOrString(value: string, lets: [string, string][]): string {
  const text = JSON.stringify(value);
  const names = lets.filter(([, printed]) => printed === text).map(([name]) => name);
  return names.length === 1 ? names[0]! : text;
}

/**
 * 多行文本写成三引号块（每行缩进 `indent + 2` 个空格）。写不成能精确读回原文的形式时返回
 * undefined：含 `\r`、`"""`、`${`，或有只含空白的行、首行缩进这类会被去缩进改变的情况。
 */
export function tripleQuoted(value: string, indent: string): string | undefined {
  if (!value.includes('\n') || /\r|"""|\$\{/.test(value)) return undefined;
  const inner = `\n${value
    .split('\n')
    .map((line) => (line ? `${indent}  ${line}` : ''))
    .join('\n')}\n${indent}`;
  return dedentTripleString(inner) === value ? `"""${inner}"""` : undefined;
}

/**
 * tool 的块写法：`tool "name" { reference = ... effect = ... params { ... } }`，键一律
 * snake_case。内置处理器、可移植却带 nodeId 等块写法表达不了的绑定返回 undefined。
 */
export function toolBlock(
  tool: ToolBinding,
  schemaBlock: (schema: unknown, indent: string) => string | undefined,
): string[] | undefined {
  const { handler, capability: c } = tool;
  if (handler.kind === 'builtin') return undefined;
  if ((c.placement === 'host-bound') !== (c.nodeId !== undefined)) return undefined;
  const s = JSON.stringify;
  const lines = [`  tool ${s(tool.name)} {`];
  if (c.nodeId !== undefined) lines.push(`    node = ${s(c.nodeId)}`);
  if (handler.kind === 'script')
    lines.push(`    script = ${s(handler.path)}`, `    runtime = ${s(handler.runtime)}`);
  else lines.push(`    reference = ${s(handler.reference)}`);
  if (tool.required !== undefined) lines.push(`    required = ${tool.required}`);
  lines.push(
    `    capability = ${s(c.id)}`,
    `    version = ${s(c.version)}`,
    `    description = ${s(c.description)}`,
    `    effect = ${s(c.effect)}`,
    `    approval = ${c.requiresApproval}`,
    `    timeout_ms = ${c.timeoutMs}`,
    `    cache_ttl_ms = ${c.cacheTtlMs}`,
  );
  if (c.resourceKey !== undefined) lines.push(`    resource_key = ${s(c.resourceKey)}`);
  lines.push(`    result_export = ${c.resultExport}`);
  if (c.network) lines.push(`    network { allowed_domains = ${s(c.network.allowedDomains)} }`);
  const params = schemaBlock(c.inputSchema, '    ');
  lines.push(
    params !== undefined
      ? `    params ${params}`
      : `    input_schema = json ${s(c.inputSchema, null, 2).replace(/\n/g, '\n    ')}`,
  );
  lines.push('  }');
  return lines;
}
