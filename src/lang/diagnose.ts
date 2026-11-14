import { type AgentDefinition } from '../core/contracts.js';
import { faultOf } from '../core/util.js';
import { type CompiledGraphPlan } from './graph.js';
import { compileOaaLang } from './compile.js';
import { formatOaaLang } from './print.js';

export interface OaaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  line?: number;
  col?: number;
}

export interface OaaDiagnosisReport {
  valid: boolean;
  diagnostics: OaaDiagnostic[];
  agent?: AgentDefinition;
  files?: string[];
  workflowPlans?: Record<string, CompiledGraphPlan>;
  formatted?: string;
}

export function diagnoseOaaLang(source: string): OaaDiagnosisReport {
  const diagnostics: OaaDiagnostic[] = [];
  try {
    const compiled = compileOaaLang(source);
    const { agent, files, workflowPlans } = compiled;

    if (!agent.description.trim()) {
      diagnostics.push({
        severity: 'warning',
        code: 'empty_description',
        message: 'Agent description is empty; recommend providing a clear capability summary.',
      });
    }
    if (agent.engine === 'kernel' && !agent.instructions.trim()) {
      diagnostics.push({
        severity: 'warning',
        code: 'empty_instructions',
        message: 'Kernel agent has empty instructions block.',
      });
    }
    if (agent.routes.length === 1) {
      diagnostics.push({
        severity: 'info',
        code: 'single_route',
        message:
          'Single model route configured; add a secondary route to enable Turn-0 cascade failover.',
      });
    }
    for (const [wfName, plan] of Object.entries(workflowPlans)) {
      diagnostics.push({
        severity: 'info',
        code: 'workflow_compiled',
        message: `Flow '${wfName}' compiled into ${plan.criticalPathDepth} topological layer(s) (max parallel width: ${plan.maxParallelWidth}).`,
      });
    }

    // 格式化失败不影响程序本身有效，降级成警告。
    let formatted: string | undefined;
    try {
      formatted = formatOaaLang(source);
    } catch (err) {
      const f = faultOf(err);
      diagnostics.push({
        severity: 'warning',
        code: f.code,
        message: `The program compiles but could not be formatted: ${f.message}`,
      });
    }
    return {
      valid: true,
      diagnostics,
      agent,
      files,
      workflowPlans,
      ...(formatted !== undefined ? { formatted } : {}),
    };
  } catch (err) {
    const f = faultOf(err);
    const locMatch = /^Line (\d+), Col (\d+):\s*(.*)$/.exec(f.message);
    diagnostics.push({
      severity: 'error',
      code: f.code,
      message: locMatch ? locMatch[3]! : f.message,
      ...(locMatch ? { line: Number(locMatch[1]), col: Number(locMatch[2]) } : {}),
    });
    if (locMatch) diagnostics.push(...furtherErrors(source, Number(locMatch[1]), locMatch[3]!));
    return {
      valid: false,
      diagnostics,
    };
  }
}

// 只有这几类「写错一个词」的错误是局限在单行里的：把那一行拿掉再编译，剩下的报错仍然可信。
const LINE_LOCAL_ERROR =
  /^(Unknown (agent property|property|built-in capability|route attribute|type|retry option)|Unexpected statement|Duplicate (property|type alias|'retry' modifier|'timeout' modifier))/;

/**
 * 一次报全：第一个错误如果是单行的拼写类错误，就把那一行抹成空白后继续编译，把后面独立的
 * 错误也找出来（最多再找 7 个）。遇到结构性错误（缺括号、未闭合字符串等）或那一行带花括号时
 * 立刻停下——那种情况下后续报错多半是连带产生的，报出来只会误导。
 */
function furtherErrors(source: string, firstLine: number, firstMessage: string): OaaDiagnostic[] {
  const found: OaaDiagnostic[] = [];
  const lines = source.split('\n');
  const seen = new Set<number>();
  let line = firstLine;
  let message = firstMessage;
  while (found.length < 7) {
    const text = lines[line - 1];
    if (
      text === undefined ||
      seen.has(line) ||
      !LINE_LOCAL_ERROR.test(message) ||
      /[{}]/.test(text) ||
      text.includes('"""')
    )
      break;
    seen.add(line);
    lines[line - 1] = '';
    try {
      compileOaaLang(lines.join('\n'));
      break;
    } catch (err) {
      const fault = faultOf(err);
      const located = /^Line (\d+), Col (\d+):\s*(.*)$/.exec(fault.message);
      if (!located) break;
      line = Number(located[1]);
      message = located[3]!;
      if (seen.has(line)) break;
      found.push({
        severity: 'error',
        code: fault.code,
        message,
        line,
        col: Number(located[2]),
      });
    }
  }
  return found;
}
