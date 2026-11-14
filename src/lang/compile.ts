import { agentSchema, type AgentDefinition, type WorkflowDefinition } from '../core/contracts.js';
import { validateWorkflows, type CompiledGraphPlan } from './graph.js';
import { Fault } from '../core/util.js';
import { JsonSchemas } from '../core/schemas.js';
import { parseFlow } from './flow.js';
import { tokenizeOaaLang } from './lexer.js';
import { ParseContext, parseValue } from './parser.js';
import {
  parseDelegate,
  parseLimits,
  parseRoute,
  parseTool,
  parseUse,
  type AgentState,
} from './statements.js';
import { suggestName, AGENT_STATEMENTS } from './suggest.js';
import { declareType, parseTypeDslBlock } from './types.js';
import { type Token } from './lexer.js';
import {
  agentLocator,
  emptySites,
  locateGraphFault,
  parseLocated,
  type FlowSites,
} from './locate.js';

export interface CompiledOaaSource {
  agent: AgentDefinition;
  files: string[];
  workflowPlans: Record<string, CompiledGraphPlan>;
  /** 源码里声明的类型别名（名字 → 展开后的 Schema）。只供格式化保留别名用，不进入发布内容。 */
  typeAliases?: Record<string, Record<string, unknown>>;
  /** 源码里的 `let` 常量（名字 → 值）。同样只供格式化保留 `let` 声明用，不进入发布内容。 */
  constants?: Record<string, unknown>;
}

const compiledOaaCache = new Map<string, CompiledOaaSource>();
const workflowSchemas = new JsonSchemas();

export function compileOaaLang(source: string): CompiledOaaSource {
  const cached = compiledOaaCache.get(source);
  if (cached) {
    compiledOaaCache.delete(source);
    compiledOaaCache.set(source, cached);
    return structuredClone(cached);
  }
  // 显式标注类型，`ctx.fail(...)` 返回 never 时才能参与类型收窄。
  const ctx: ParseContext = new ParseContext(tokenizeOaaLang(source));
  const { constants, typeAliases } = ctx;

  // Top-level `let NAME = VALUE` declarations before `agent`
  while (
    ctx.peek().type === 'IDENT' &&
    (ctx.peek().value === 'let' || ctx.peek().value === 'type')
  ) {
    if (ctx.next().value === 'type') {
      declareType(ctx);
      continue;
    }
    declareConstant(ctx);
  }

  const head = ctx.expect('IDENT', "'agent'");
  if (head.value !== 'agent') {
    ctx.fail(head, `OAA module must start with 'agent "<id>" { ... }', found '${head.value}'.`);
  }
  const agentId = ctx.readStringOrIdent('agent ID');
  ctx.expect('LBRACE', '{');

  let description = '';
  let instructions = '';
  let engine: string | undefined;
  let model: string | undefined;
  let allowGraph: boolean | undefined;
  let approvals: 'auto' | undefined;
  let allowedNodes: string[] | undefined;
  let outputSchema: Record<string, unknown> | undefined;
  let limits: Record<string, unknown> | undefined;
  let files: string[] = [];
  let skills: AgentDefinition['skills'] = [];
  const workflows: WorkflowDefinition[] = [];
  const sites = emptySites(head);
  const state: AgentState = {
    provider: undefined,
    tools: [],
    delegates: [],
    routes: [],
    pendingProvider: [],
    sites,
  };
  const { tools, delegates, routes } = state;
  const flowSites: FlowSites[] = sites.workflows;
  // 只能声明一次的 agent 属性。
  const declared = new Set<string>();
  const once = (kw: Token, name: string) => {
    if (declared.has(name)) ctx.fail(kw, `Duplicate '${name}' declaration.`);
    declared.add(name);
  };

  while (ctx.peek().type !== 'RBRACE' && ctx.peek().type !== 'EOF') {
    const kw = ctx.expect('IDENT', 'statement keyword');

    // Agent-scoped `type Name = <type>`
    if (kw.value === 'type' && ctx.peek().type === 'IDENT' && ctx.peek(1).type === 'EQ') {
      declareType(ctx);
      continue;
    }

    // Agent-scoped `let NAME = VALUE`
    if (kw.value === 'let') {
      declareConstant(ctx);
      continue;
    }

    if (kw.value === 'use') {
      parseUse(ctx, kw, state);
      continue;
    }

    if (kw.value === 'route') {
      parseRoute(ctx, kw, state);
      continue;
    }

    if (kw.value === 'tool') {
      parseTool(ctx, kw, state);
      continue;
    }

    if (kw.value === 'delegate') {
      parseDelegate(ctx, kw, state);
      continue;
    }

    if (kw.value === 'flow' || kw.value === 'workflow') {
      const steps = new Map<string, Token>();
      flowSites.push({ tok: kw, steps });
      workflows.push(parseFlow(ctx, kw, steps));
      continue;
    }

    if (kw.value === 'limits') {
      once(kw, 'limits');
      limits = parseLimits(ctx, kw, state);
      continue;
    }

    if (kw.value === 'output_schema' || kw.value === 'outputSchema') {
      once(kw, 'output_schema');
      sites.props.set('outputSchema', kw);
      if (!ctx.match('EQ')) ctx.match('COLON');
      outputSchema = parseTypeDslBlock(ctx);
      continue;
    }

    if (kw.value === 'instructions') {
      once(kw, 'instructions');
      sites.props.set('instructions', kw);
      if (!ctx.match('EQ')) ctx.match('COLON');
      const val = parseValue(ctx);
      if (typeof val !== 'string')
        ctx.fail(kw, "'instructions' must be a string or triple-quoted block.");
      instructions = val;
      continue;
    }

    // agent 级属性同时接受 `=` 与 `:`。
    if (!ctx.match('COLON')) ctx.expect('EQ', '=');
    const valTok = ctx.peek();
    let val = parseValue(ctx);
    const text = (name: string): string => {
      if (typeof val !== 'string') ctx.fail(kw, `'${name}' must be a string.`);
      return val;
    };
    switch (kw.value) {
      case 'description':
        once(kw, 'description');
        sites.props.set('description', kw);
        description = text('description');
        break;
      case 'engine':
        // 引擎名是关键字位置，不做常量替换。
        if (valTok.type === 'IDENT') val = valTok.value;
        once(kw, 'engine');
        sites.props.set('engine', kw);
        engine = text('engine');
        break;
      case 'provider':
        once(kw, 'provider');
        sites.props.set('provider', kw);
        state.provider = text('provider');
        break;
      case 'model':
        once(kw, 'model');
        sites.props.set('model', kw);
        model = text('model');
        break;
      case 'allow_graph':
      case 'allowGraph':
        once(kw, 'allow_graph');
        sites.props.set('allowGraph', kw);
        allowGraph = val as boolean;
        break;
      case 'approvals':
        // 与 engine 一样接受标识符；`ask` 是缺省值，产物里不写这个键。
        if (valTok.type === 'IDENT') val = valTok.value;
        if (val !== 'ask' && val !== 'auto') ctx.fail(kw, "'approvals' must be ask or auto.");
        once(kw, 'approvals');
        sites.props.set('approvals', kw);
        approvals = val === 'auto' ? 'auto' : undefined;
        break;
      case 'allowed_nodes':
      case 'allowedNodes':
        if (!Array.isArray(val) || !val.every((v) => typeof v === 'string'))
          ctx.fail(kw, "'allowed_nodes' must be an array of node IDs.");
        once(kw, 'allowed_nodes');
        sites.props.set('allowedNodes', kw);
        allowedNodes = val.map(String);
        break;
      case 'files':
        if (!Array.isArray(val) || !val.every((v) => typeof v === 'string'))
          ctx.fail(kw, "'files' must be an array of relative paths.");
        once(kw, 'files');
        files = val.map(String);
        break;
      case 'skills':
        if (!Array.isArray(val))
          ctx.fail(kw, "'skills' must be an array of published skill descriptors.");
        once(kw, 'skills');
        sites.props.set('skills', kw);
        skills = val as AgentDefinition['skills'];
        break;
      default:
        ctx.fail(
          kw,
          `Unknown agent property '${kw.value}'.${suggestName(kw.value, AGENT_STATEMENTS)}`,
        );
    }
  }

  ctx.expect('RBRACE', '}');
  ctx.expect('EOF', 'end of OAA file');

  // 默认提供方在整个 agent 块解析完之后才确定，与 route 写在 provider 前后无关。
  for (const route of state.pendingProvider) route.provider = state.provider ?? 'default';
  const resolvedProvider = state.provider ?? routes[0]?.provider ?? 'default';
  const resolvedModel = model ?? routes[0]?.model;
  if (!resolvedModel) {
    throw new Fault(
      'oaa_syntax_error',
      `Agent '${agentId}' must specify either 'model = "..."' or at least one 'route'.`,
    );
  }

  // Statically validate all declared `flow` workflows and normalize step `depends_on`
  const { workflowPlans } = validateLocated(tools, delegates, workflows, flowSites);

  const parsedAgent = parseLocated(
    () =>
      agentSchema.parse({
        id: agentId,
        description,
        instructions,
        ...(engine ? { engine } : {}),
        provider: resolvedProvider,
        model: resolvedModel,
        tools,
        skills,
        ...(limits ? { limits } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        ...(allowedNodes ? { allowedNodes } : {}),
        ...(allowGraph !== undefined ? { allowGraph } : {}),
        ...(approvals ? { approvals } : {}),
        ...(workflows.length ? { workflows } : {}),
        ...(delegates.length ? { delegates } : {}),
        ...(routes.length ? { routes } : {}),
      }),
    agentLocator(sites),
  );

  const result: CompiledOaaSource = {
    agent: parsedAgent,
    files,
    workflowPlans,
    ...(typeAliases.size ? { typeAliases: Object.fromEntries(typeAliases) } : {}),
    ...(constants.size ? { constants: Object.fromEntries(constants) } : {}),
  };
  compiledOaaCache.set(source, structuredClone(result));
  if (compiledOaaCache.size > 64) {
    compiledOaaCache.delete(compiledOaaCache.keys().next().value!);
  }
  return result;
}

/** `let NAME = VALUE`：调用时 `let` 关键字已被读掉。同名常量不许重复声明。 */
function declareConstant(ctx: ParseContext): void {
  const nameTok = ctx.expect('IDENT', 'constant name');
  if (ctx.constants.has(nameTok.value)) ctx.fail(nameTok, `Duplicate constant '${nameTok.value}'.`);
  ctx.expect('EQ', '=');
  ctx.constants.set(nameTok.value, parseValue(ctx));
}

/**
 * 校验全部 flow。失败时逐个前缀重跑，找出第一个出错的 flow，把报错定位到它（或报错里提到的
 * 步骤）的声明处；错误码保持执行图校验给出的那个。
 */
function validateLocated(
  tools: AgentState['tools'],
  delegates: AgentState['delegates'],
  workflows: WorkflowDefinition[],
  flowSites: FlowSites[],
): ReturnType<typeof validateWorkflows> {
  const pristine = structuredClone(workflows);
  try {
    return validateWorkflows(
      { tools, delegates, workflows },
      { schemas: workflowSchemas, normalizeSteps: true, compilePlans: true },
    );
  } catch (error) {
    if (!(error instanceof Fault)) throw error;
    for (let i = 0; i < workflows.length; i++) {
      try {
        validateWorkflows(
          { tools, delegates, workflows: structuredClone(pristine.slice(0, i + 1)) },
          { schemas: workflowSchemas },
        );
      } catch {
        throw locateGraphFault(error, flowSites[i]!);
      }
    }
    throw error;
  }
}
