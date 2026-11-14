import { type WorkflowDefinition } from '../core/contracts.js';
import { type Token } from './lexer.js';
import { normalizeDollarRef, parseFlowValue, parseValue, type ParseContext } from './parser.js';
import { suggestName, FLOW_STATEMENTS } from './suggest.js';
import { parseTypeDslBlock } from './types.js';

// Declarative Workflow Macro:
// flow "gather_sources" { params { ... } step s1 = list_files() ... }
/** 解析 `flow` 块；调用时 `flow` / `workflow` 关键字（`kw`）已被读掉。 */
export function parseFlow(
  ctx: ParseContext,
  kw: Token,
  stepSites: Map<string, Token> = new Map(),
): WorkflowDefinition {
  const flowName = ctx.readStringOrIdent('flow name');
  ctx.expect('LBRACE', '{');
  let flowDesc: string | undefined;
  let flowInputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  const flowSteps: Record<string, unknown>[] = [];
  let flowOutput: unknown;
  let hasOutput = false;
  let flowOutputSchema: Record<string, unknown> | undefined;
  let hasParams = false;

  const parseStepCallArgs = (localVars: Set<string>): Record<string, unknown> => {
    ctx.expect('LPAREN', '(');
    const args: Record<string, unknown> = {};
    while (ctx.peek().type !== 'RPAREN' && ctx.peek().type !== 'EOF') {
      const argKey = ctx.readStringOrIdent('step argument name');
      if (!ctx.match('EQ') && !ctx.match('COLON')) {
        ctx.fail(ctx.peek(), `Expected '=' or ':' after step argument '${argKey}'.`);
      }
      ctx.assign(args, argKey, parseFlowValue(ctx, localVars), kw);
      ctx.match('COMMA');
    }
    ctx.expect('RPAREN', ')');
    return args;
  };

  while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
    const fkw = ctx.expect('IDENT', 'flow statement');
    if (fkw.value === 'return') {
      if (hasOutput) ctx.fail(fkw, `Flow '${flowName}' declares more than one return value.`);
      hasOutput = true;
      flowOutput = parseFlowValue(ctx, new Set());
      continue;
    }
    if (fkw.value === 'output_schema' || fkw.value === 'outputSchema') {
      if (flowOutputSchema)
        ctx.fail(fkw, `Flow '${flowName}' declares more than one output schema.`);
      ctx.match('EQ');
      flowOutputSchema = parseTypeDslBlock(ctx);
      continue;
    }
    if (fkw.value === 'description') {
      if (flowDesc !== undefined)
        ctx.fail(fkw, `Duplicate 'description' declaration in flow '${flowName}'.`);
      ctx.expect('EQ', '=');
      const value = parseValue(ctx);
      if (typeof value !== 'string') ctx.fail(fkw, "Flow 'description' must be a string.");
      flowDesc = value;
      continue;
    }
    if (
      fkw.value === 'params' ||
      fkw.value === 'schema' ||
      fkw.value === 'input_schema' ||
      fkw.value === 'inputSchema'
    ) {
      if (hasParams) ctx.fail(fkw, `Duplicate 'params' declaration in flow '${flowName}'.`);
      hasParams = true;
      ctx.match('EQ');
      flowInputSchema = parseTypeDslBlock(ctx);
      continue;
    }
    if (fkw.value === 'step') {
      const stepTok = ctx.peek();
      const stepId = ctx.readStringOrIdent('step ID');
      if (stepId === 'input')
        ctx.fail(stepTok, "A step cannot be named 'input'; that name refers to the flow's input.");
      if (!stepSites.has(stepId)) stepSites.set(stepId, stepTok);
      // Support both `step id = tool(...)` and `step "id" { ... }`
      if (ctx.match('EQ')) {
        const toolTok = ctx.next();
        if (toolTok.type !== 'IDENT' && toolTok.type !== 'STRING') {
          ctx.fail(toolTok, `Expected tool name after 'step ${stepId} ='.`);
        }
        const stepTool = toolTok.value;
        const localVars = new Set<string>();
        const stepArgs = parseStepCallArgs(localVars);
        const stepObj: Record<string, unknown> = {
          id: stepId,
          tool: stepTool,
          arguments: stepArgs,
        };

        // Optional modifiers after tool(...): foreach, when, fallback, depends_on, retry, timeout
        while (
          ctx.peek().type === 'IDENT' &&
          ['when', 'foreach', 'fallback', 'depends_on', 'retry', 'timeout'].includes(
            ctx.peek().value,
          )
        ) {
          const modTok = ctx.next();
          const mod = modTok.value;
          if (mod === 'retry') {
            // `retry 2` 或 `retry(2, backoff=200ms)`：失败后最多再试几次
            if (stepObj.retry !== undefined) ctx.fail(modTok, "Duplicate 'retry' modifier.");
            const retry: Record<string, unknown> = {};
            if (ctx.match('LPAREN')) {
              retry.attempts = Number(parseValue(ctx));
              while (ctx.match('COMMA')) {
                const optTok = ctx.peek();
                const opt = ctx.readStringOrIdent('retry option');
                ctx.expect('EQ', '=');
                if (opt !== 'backoff' && opt !== 'backoff_ms')
                  ctx.fail(
                    optTok,
                    `Unknown retry option '${opt}'.${suggestName(opt, ['backoff'])} The only option is backoff.`,
                  );
                retry.backoff_ms = Number(parseValue(ctx));
              }
              ctx.expect('RPAREN', ')');
            } else {
              ctx.match('EQ');
              retry.attempts = Number(parseValue(ctx));
            }
            stepObj.retry = retry;
          } else if (mod === 'timeout') {
            // `timeout 30s`：每次尝试最多等多久
            if (stepObj.timeout_ms !== undefined) ctx.fail(modTok, "Duplicate 'timeout' modifier.");
            ctx.match('EQ');
            stepObj.timeout_ms = Number(parseValue(ctx));
          } else if (mod === 'depends_on') {
            if (stepObj.depends_on !== undefined)
              ctx.fail(modTok, "Duplicate 'depends_on' modifier.");
            ctx.expect('EQ', '=');
            const deps = parseValue(ctx);
            if (!Array.isArray(deps)) ctx.fail(fkw, "'depends_on' must be an array of step IDs.");
            stepObj.depends_on = deps.map(String);
          } else if (mod === 'when') {
            if (stepObj.when !== undefined) ctx.fail(modTok, "Duplicate 'when' modifier.");
            ctx.match('EQ');
            stepObj.when = parseFlowValue(ctx, localVars);
          } else if (mod === 'foreach') {
            const varName = ctx.readStringOrIdent('foreach variable');
            localVars.add(varName);
            const inTok = ctx.expect('IDENT', "'in'");
            if (inTok.value !== 'in') ctx.fail(inTok, "Expected 'in' after foreach variable.");
            const srcTok = ctx.next();
            if (srcTok.type !== 'IDENT' && srcTok.type !== 'STRING') {
              ctx.fail(srcTok, 'Expected step reference for foreach source.');
            }
            const refStr = normalizeDollarRef(srcTok.value, new Set());
            let maxItems = 16;
            if (ctx.match('LPAREN')) {
              while (ctx.peek().type !== 'RPAREN' && ctx.peek().type !== 'EOF') {
                const optTok = ctx.peek();
                const mk = ctx.readStringOrIdent('foreach option');
                ctx.expect('EQ', '=');
                const mv = parseValue(ctx);
                if (mk === 'max' || mk === 'max_items') maxItems = Number(mv);
                else
                  ctx.fail(
                    optTok,
                    `Unknown foreach option '${mk}'.${suggestName(mk, ['max'])} The only option is max.`,
                  );
                ctx.match('COMMA');
              }
              ctx.expect('RPAREN', ')');
            }
            stepObj.foreach = { $ref: refStr, as: varName, max_items: maxItems };
          } else if (mod === 'fallback') {
            if (stepObj.fallback !== undefined) ctx.fail(modTok, "Duplicate 'fallback' modifier.");
            ctx.match('EQ');
            if (ctx.peek().type === 'IDENT' && ctx.peek(1).type === 'LPAREN') {
              const fbTool = ctx.next().value;
              const fbArgs = parseStepCallArgs(localVars);
              stepObj.fallback = { tool: fbTool, arguments: fbArgs };
            } else {
              stepObj.fallback = { value: parseFlowValue(ctx, localVars) };
            }
          }
        }
        flowSteps.push(stepObj);
      } else {
        const rawStep = parseFlowValue(ctx, new Set()) as Record<string, unknown>;
        flowSteps.push({ id: stepId, ...rawStep });
      }
      continue;
    }
    ctx.fail(
      fkw,
      `Unexpected statement '${fkw.value}' inside flow '${flowName}'.${suggestName(fkw.value, FLOW_STATEMENTS)}`,
    );
  }
  ctx.expect('RBRACE', '}');

  if (!flowSteps.length) {
    ctx.fail(kw, `Flow '${flowName}' must declare at least one 'step'.`);
  }
  const stepIds = new Set(flowSteps.map((step) => String(step.id)));
  for (const step of flowSteps) resolveConstantRefs(ctx, step, stepIds);
  if (hasOutput) flowOutput = resolveConstantRefs(ctx, flowOutput, stepIds);
  return {
    name: flowName,
    description: flowDesc ?? `Compiled OAA workflow macro ${flowName}`,
    inputSchema: flowInputSchema,
    steps: flowSteps,
    ...(hasOutput ? { output: flowOutput } : {}),
    ...(flowOutputSchema ? { outputSchema: flowOutputSchema } : {}),
  };
}

/**
 * flow 里的 `$NAME`：NAME 不是步骤（也不是 input / foreach 变量）而是已声明的常量时，换成常量的值。
 * 同名时步骤优先。`$NAME.x` 这种带路径的写法对常量不适用，报错说明。原地修改并返回新值。
 */
function resolveConstantRefs(ctx: ParseContext, value: unknown, stepIds: Set<string>): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = resolveConstantRefs(ctx, value[i], stepIds);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  const tok = ctx.shorthandRefs.get(value);
  if (tok) {
    const ref = String((value as { $ref: unknown }).$ref);
    const [base] = ref.split('#');
    if (base && !base.startsWith('$') && !stepIds.has(base) && ctx.constants.has(base)) {
      if (ref.includes('#'))
        ctx.fail(
          tok,
          `'${base}' is a constant, not a step; constants cannot be used with a path like '${tok.value}'.`,
        );
      return structuredClone(ctx.constants.get(base));
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    record[key] = resolveConstantRefs(ctx, record[key], stepIds);
  return value;
}
