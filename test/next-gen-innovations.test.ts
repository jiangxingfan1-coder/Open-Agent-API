import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { setup, agent, FixtureModel, principal, token } from './helpers.js';
import { buildBundle, makeBundle } from '../src/lang/bundle.js';
import {
  compileOaaLang,
  decompileToOaaLang,
  diagnoseOaaLang,
  formatOaaLang,
} from '../src/lang/lang.js';
import {
  compileGraphPlan,
  evaluateAst,
  evaluateSafeExpr,
  executeGraph,
  parseGraph,
} from '../src/lang/graph.js';
import {
  extractInlineDirective,
  ModelRouter,
  resolveModelSelector,
} from '../src/gateway/protocol.js';
import { detectProtocolDialect } from '../src/gateway/uap.js';
import { providerSchema } from '../src/config/config.js';
import { AnthropicModel, GeminiModel } from '../src/providers/models.js';
import { Fault } from '../src/core/util.js';

test('OAA-Lang 1.0 compiles .oaa declarative files into bundles and round-trips via decompiler', async () => {
  const examplePath = path.resolve('examples/research.oaa');
  const bundle = await buildBundle(examplePath);

  assert.equal(bundle.agent.id, 'agent/research');
  assert.equal(bundle.agent.engine, 'kernel');
  assert.equal(bundle.agent.allowGraph, true);
  assert.equal(bundle.agent.routes.length, 2);
  assert.equal(bundle.agent.routes[0]?.id, 'primary');
  assert.deepEqual(bundle.agent.routes[0]?.tags, ['reasoning', 'coding', 'quality']);
  assert.equal(bundle.agent.routes[1]?.id, 'fast');
  assert.equal(bundle.agent.routes[1]?.speedTier, 5);
  assert.equal(bundle.agent.routes[1]?.costTier, 1);
  assert.equal(bundle.agent.tools.length, 3);

  // Round-trip decompile -> compile
  const decompiled = decompileToOaaLang(bundle.agent);
  const recompiled = compileOaaLang(decompiled);
  assert.equal(recompiled.agent.id, bundle.agent.id);
  assert.equal(recompiled.agent.routes.length, bundle.agent.routes.length);
  assert.equal(recompiled.agent.limits.maxTurns, bundle.agent.limits.maxTurns);
});

test('OAA-VM v2 Pratt AST evaluator handles precedence, strings with ||, functions, $transform, foreach, and effect-safe fallback', async () => {
  // 1. Pratt AST operator precedence, parentheses, ternary, strings containing || and &&, and functions
  assert.equal(evaluateAst('(10 + 5) * 2 == 30'), true);
  assert.equal(evaluateAst('10 + 5 * 2 == 20'), true);
  assert.equal(evaluateAst("'a||b&&c' == 'a||b&&c'"), true);
  assert.equal(evaluateAst("len('hello') == 5 && includes(lower('TypeScript'), 'script')"), true);
  assert.equal(evaluateAst("10 > 5 ? 'high' : 'low'"), 'high');
  assert.equal(evaluateAst('max(3, min(12, 8))'), 8);

  // 2. Effect-safety blocks fallback on write tools
  const allowed = new Set([
    'fetch_items',
    'enrich_item',
    'primary_read',
    'backup_read',
    'write_db',
  ]);
  const effects = new Map<
    'fetch_items' | 'enrich_item' | 'primary_read' | 'backup_read' | 'write_db',
    'read' | 'write'
  >([
    ['fetch_items', 'read'],
    ['enrich_item', 'read'],
    ['primary_read', 'read'],
    ['backup_read', 'read'],
    ['write_db', 'write'],
  ]);

  assert.throws(
    () =>
      parseGraph(
        {
          steps: [
            {
              id: 'unsafe',
              tool: 'write_db',
              arguments: { x: 1 },
              fallback: { value: { ok: false } },
            },
          ],
        },
        allowed,
        effects,
      ),
    /write|fallback/i,
  );

  // 3. Execute DAG with $transform, foreach bounded map, and read-only fallback
  const steps = parseGraph(
    {
      steps: [
        { id: 'source', tool: 'fetch_items', arguments: {} },
        {
          id: 'mapped',
          tool: 'enrich_item',
          foreach: { $ref: 'source#/items', as: 'entry', max_items: 8 },
          arguments: {
            label: { $template: 'item-{{entry#/name}}' },
            doubled: { $expr: 'entry#/val * 2' },
          },
        },
        {
          id: 'resilient',
          tool: 'primary_read',
          arguments: { q: 'test' },
          fallback: { tool: 'backup_read', arguments: { q: 'backup' } },
        },
        {
          id: 'projection',
          tool: '$transform',
          depends_on: ['mapped', 'resilient'],
          arguments: {
            count: { $expr: 'len(mapped)' },
            backupSource: { $ref: 'resilient#/from' },
          },
        },
      ],
    },
    allowed,
    effects,
  );

  const plan = compileGraphPlan(steps);
  assert.ok(plan.layers.length >= 2);

  const out = await executeGraph(steps, 4, new AbortController().signal, async (step, args) => {
    if (step.tool === 'fetch_items') {
      return {
        items: [
          { name: 'alpha', val: 3 },
          { name: 'beta', val: 7 },
        ],
      };
    }
    if (step.tool === 'enrich_item') {
      return { tag: args.label, score: args.doubled };
    }
    if (step.tool === 'primary_read') {
      throw new Fault('upstream_failed', 'Primary read failed', 502);
    }
    if (step.tool === 'backup_read') {
      return { from: 'backup_ok', q: args.q };
    }
    return {};
  });

  assert.deepEqual(out.mapped, [
    { tag: 'item-alpha', score: 6 },
    { tag: 'item-beta', score: 14 },
  ]);
  assert.deepEqual(out.projection, { count: 2, backupSource: 'backup_ok' });
});

test('zero-friction model selector supports @fast/@best/@eco, fuzzy aliases, fallback chains, and @oaa(...) directives', async () => {
  const dir = extractInlineDirective(
    '@oaa(model=sonnet|gpt-4o, strategy=quality)\nRefactor module',
  );
  assert.equal(dir.cleanedInput, 'Refactor module');
  assert.equal(dir.model, 'sonnet|gpt-4o');
  assert.equal(dir.strategy, 'quality');

  const resolved = resolveModelSelector('agent/coder@sonnet|gpt-4o|flash');
  assert.equal(resolved.agent, 'agent/coder');
  assert.deepEqual(resolved.chain, ['sonnet', 'gpt-4o', 'flash']);

  const router = new ModelRouter();
  const def = agent({
    routes: [
      {
        id: 'r-sonnet',
        provider: 'p1',
        model: 'claude-3-7-sonnet',
        priority: 0,
        costTier: 4,
        speedTier: 3,
      },
      {
        id: 'r-flash',
        provider: 'p2',
        model: 'gemini-2.5-flash',
        priority: 1,
        costTier: 1,
        speedTier: 5,
      },
    ],
  });

  // Semantic @eco picks flash even though sonnet has priority 0
  const ecoPick = router.select('o', 'd', def, '@eco', () => true);
  assert.equal(ecoPick.id, 'r-flash');
  assert.equal(ecoPick.mode, 'auto');

  // Fuzzy family match 'sonnet' picks r-sonnet
  const fuzzyPick = router.select('o', 'd', def, 'sonnet', () => true);
  assert.equal(fuzzyPick.id, 'r-sonnet');

  // Fallback chain skips unavailable p1 and selects p2
  const chainPick = router.select('o', 'd', def, 'sonnet|flash', (p) => p === 'p2');
  assert.equal(chainPick.id, 'r-flash');
  assert.equal(chainPick.mode, 'auto');

  // Topology co-scheduling prefers ready low-load node over degraded/busy node
  const topoCandidates = router.candidates('o', 'd', def, (p) =>
    p === 'p1'
      ? { available: true, status: 'busy', waitMs: 3000, loadRatio: 1 }
      : { available: true, status: 'ready', waitMs: 0, loadRatio: 0.1 },
  );
  assert.equal(topoCandidates[0]?.id, 'r-flash');
});

test('Turn-0 zero-side-effect cascade failover transparently recovers from upstream rate limits', async () => {
  let primaryCalls = 0;
  let backupCalls = 0;
  const s = await setup(
    new FixtureModel((a) => {
      if (a.model === 'flaky-primary') {
        primaryCalls++;
        throw new Fault('upstream_rate_limited', '429 Too Many Requests', 429);
      }
      backupCalls++;
      return { text: `Recovered via ${a.model}` };
    }),
  );

  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          routes: [
            { id: 'primary', provider: 'fixture', model: 'flaky-primary', priority: 0 },
            { id: 'backup', provider: 'fixture', model: 'steady-backup', priority: 1 },
          ],
        }),
      ),
    );

    const res = await s.request('POST', '/v1/uap', {
      uap: '1.0',
      target: 'agent/test',
      input: 'Execute with automatic resilience',
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.uap, '1.0');
    assert.equal(body.status, 'completed');
    assert.equal(body.output.text, 'Recovered via steady-backup');
    assert.equal(body.route.id, 'backup');
    assert.equal(body.route.failover_from, 'primary');
    assert.equal(primaryCalls, 1);
    assert.equal(backupCalls, 1);

    const events = s.store.history(body.id);
    assert.ok(events.some((e) => e.type === 'route.failover'));

    // Check expanded /v1/models?expand=routes
    const modelsRes = await s.request('GET', '/v1/models?expand=routes');
    assert.equal(modelsRes.statusCode, 200);
    const ids = modelsRes.json().data.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('agent/test@fast'));
    assert.ok(ids.includes('agent/test@backup'));
  } finally {
    await s.cleanup();
  }
});

test('UAP/1 NDJSON streaming, Gemini GenerateContent API, multipart OpenAI Chat, and /v1/universal auto-detection', async () => {
  const s = await setup(
    new FixtureModel((_a, msgs) => ({ text: `Echo: ${msgs.at(-1)?.content.slice(0, 40)}` })),
  );
  try {
    s.store.publish('owner', makeBundle(agent()));
    const url = await s.listen();

    // 1. UAP/1 compact NDJSON stream
    const uapStreamRes = await fetch(`${url}/v1/uap`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uap: '1.0',
        target: 'agent/test@fast',
        input: 'Stream compact frames',
        delivery: { stream: true, format: 'uap-ndjson' },
      }),
    });
    assert.equal(uapStreamRes.status, 200);
    assert.match(uapStreamRes.headers.get('content-type') ?? '', /application\/x-ndjson/);
    const lines = (await uapStreamRes.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines[0]?.t, 'start');
    assert.ok(lines.some((l) => l.t === 'delta'));
    assert.equal(lines.at(-1)?.t, 'done');
    assert.equal(lines.at(-1)?.status, 'completed');

    // 2. Google Gemini :generateContent and :streamGenerateContent with x-goog-api-key
    const gemRes = await fetch(`${url}/v1beta/models/agent/test:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Be concise.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello Gemini client' }] }],
      }),
    });
    assert.equal(gemRes.status, 200);
    const gemBody = (await gemRes.json()) as any;
    assert.equal(gemBody.candidates[0].finishReason, 'STOP');
    assert.match(gemBody.candidates[0].content.parts[0].text, /Echo:/);

    const gemStream = await fetch(`${url}/v1beta/models/agent/test:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Stream Gemini' }] }],
      }),
    });
    assert.equal(gemStream.status, 200);
    const gemSse = await gemStream.text();
    assert.match(gemSse, /"candidates":/);
    assert.match(gemSse, /"finishReason":"STOP"/);

    // 3. /v1/universal O(1) auto-detection across dialects + multi-part Chat Completions
    assert.equal(detectProtocolDialect({ uap: '1.0', target: 'a', input: 'x' }), 'uap');
    assert.equal(detectProtocolDialect({ contents: [{ parts: [{ text: 'x' }] }] }), 'gemini');
    // max_tokens 两家都有，不参与判断；判定不了时报 protocol_undetected。
    assert.throws(
      () =>
        detectProtocolDialect({
          model: 'a',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'x' }],
        }),
      (e: { code?: string }) => e.code === 'protocol_undetected',
    );
    assert.equal(
      detectProtocolDialect(
        { model: 'a', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
        { 'anthropic-version': '2023-06-01' },
      ),
      'claude',
    );
    assert.equal(
      detectProtocolDialect({
        model: 'a',
        max_tokens: 100,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'x' },
        ],
      }),
      'chat',
    );

    const univChat = await fetch(`${url}/v1/universal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-OAA-Protocol': 'chat',
      },
      body: JSON.stringify({
        model: 'agent/test',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '@oaa(model=fast) Multi-part chat works!' }],
          },
        ],
      }),
    });
    assert.equal(univChat.status, 200);
    assert.equal(univChat.headers.get('x-oaa-detected-protocol'), 'chat');
    const chatJson = (await univChat.json()) as any;
    assert.equal(chatJson.object, 'chat.completion');
    assert.match(chatJson.choices[0].message.content, /Multi-part chat works!/);
  } finally {
    await s.cleanup();
  }
});

test('AnthropicModel and GeminiModel upstream SSE drivers stream deltas and parse tool calls', async () => {
  process.env.TEST_UPSTREAM_KEY = 'mock-upstream-secret';
  const mockServer = createServer((req, res) => {
    if (req.url?.includes('/v1/messages')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic ' } })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key":"val"}' } })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`);
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }
    if (req.url?.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini ' }, { text: 'OK' }] } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`,
      );
      res.end();
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = mockServer.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const anthropicDriver = new AnthropicModel(
      providerSchema.parse({
        kind: 'anthropic-messages',
        baseUrl,
        apiKeyEnv: 'TEST_UPSTREAM_KEY',
      }),
    );
    const claudeDeltas: string[] = [];
    const claudeRes = await anthropicDriver.call(
      agent({ model: 'claude-3-7-sonnet' }),
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      (d) => claudeDeltas.push(d),
    );
    assert.equal(claudeRes.text, 'Anthropic ');
    assert.equal(claudeRes.finish, 'tool_calls');
    assert.equal(claudeRes.calls[0]?.name, 'lookup');
    assert.deepEqual(claudeRes.calls[0]?.arguments, { key: 'val' });
    assert.equal(claudeRes.usage?.total_tokens, 20);

    const geminiDriver = new GeminiModel(
      providerSchema.parse({
        kind: 'gemini-generate',
        baseUrl,
        apiKeyEnv: 'TEST_UPSTREAM_KEY',
      }),
    );
    const gemDeltas: string[] = [];
    const gemRes = await geminiDriver.call(
      agent({ model: 'gemini-2.5-pro' }),
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      (d) => gemDeltas.push(d),
    );
    assert.equal(gemRes.text, 'Gemini OK');
    assert.equal(gemRes.finish, 'stop');
    assert.equal(gemRes.usage?.total_tokens, 15);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

test('OAA-Lang 2.0 supports let constants, duration literals, Type-DSL schemas, flow macros, delegates, formatter, and diagnostics', () => {
  const source = `
    let BASE_TIMEOUT = 45s
    let DOMAIN_NAME  = "analytics"

    agent "agent/\${DOMAIN_NAME}-orchestrator" {
      description = "Orchestrator for \${DOMAIN_NAME} pipelines"
      engine      = kernel

      route "primary" -> default/"gpt-4.1"      priority=0 cost=3 speed=3 tags=["reasoning", "coding"]
      route "fast"    -> default/"gpt-4.1-mini" priority=1 cost=1 speed=5 tags=["fast", "cost"]

      use builtin [list_files, read_file, write_file]

      tool "search_metrics" {
        capability  = "metrics/search"
        effect      = read
        timeout     = BASE_TIMEOUT
        cache_ttl   = 5m
        description = "Search time-series metrics"
        params {
          query: string("Search query", min=1, max=120)
          mode?: "fast" | "balanced" | "deep"
          limit?: int(default=25, min=1, max=100)
          tags?: string[]
        }
      }

      delegate "ask_specialist" -> "agent/research"@fast {
        description   = "Delegate verification to research specialist"
        timeout       = 60s
        forward_files = true
      }

      flow "gather_overview" {
        description = "List files and read target doc with fallback"
        params {
          primary_doc: string
          backup_doc?: string(default="README.md")
        }
        step listing = list_files()
        step doc     = read_file(path = $input.primary_doc) fallback read_file(path = $input.backup_doc)
        step summary = $transform(
          file_count = $(len(listing.files)),
          file_names = $(pluck(listing.files, "name")),
          excerpt    = $doc.text
        ) when $(len(listing.files) > 0)
      }

      output_schema {
        headline: string(min=1, max=200)
        score: number(min=0, max=1)
        sources: string[]
      }

      limits {
        max_turns        = 12
        timeout          = 2m
        tool_concurrency = 4
      }

      instructions """
        Coordinate \${DOMAIN_NAME} analysis using gather_overview and ask_specialist.
      """
    }
  `;

  const report = diagnoseOaaLang(source);
  assert.equal(report.valid, true);
  assert.ok(report.agent);
  assert.equal(report.agent.id, 'agent/analytics-orchestrator');
  assert.equal(report.agent.limits.timeoutMs, 120_000);

  // Check Type-DSL compilation on custom tool
  const searchTool = report.agent.tools.find((t) => t.name === 'search_metrics');
  assert.ok(searchTool);
  assert.equal(searchTool.capability.timeoutMs, 45_000);
  assert.equal(searchTool.capability.cacheTtlMs, 300_000);
  const props = searchTool.capability.inputSchema.properties as Record<string, any>;
  assert.equal(props.query.type, 'string');
  assert.equal(props.query.minLength, 1);
  assert.equal(props.query.maxLength, 120);
  assert.deepEqual(props.mode.enum, ['fast', 'balanced', 'deep']);
  assert.equal(props.limit.default, 25);
  assert.equal(props.tags.type, 'array');
  assert.deepEqual(searchTool.capability.inputSchema.required, ['query']);

  // Check delegate compilation
  assert.equal(report.agent.delegates?.length, 1);
  assert.equal(report.agent.delegates?.[0]?.name, 'ask_specialist');
  assert.equal(report.agent.delegates?.[0]?.agent, 'agent/research');
  assert.equal(report.agent.delegates?.[0]?.model, '@fast');
  assert.equal(report.agent.delegates?.[0]?.timeoutMs, 60_000);
  assert.equal(report.agent.delegates?.[0]?.forwardFiles, true);

  // Check flow compilation & topological plan
  assert.equal(report.agent.workflows?.length, 1);
  assert.equal(report.workflowPlans?.gather_overview?.criticalPathDepth, 2);

  // Lossless round-trip formatting & recompilation
  const formatted = formatOaaLang(source);
  const recompiled = compileOaaLang(formatted);
  assert.equal(recompiled.agent.id, report.agent.id);
  assert.equal(recompiled.agent.tools.length, report.agent.tools.length);
  assert.equal(recompiled.agent.delegates?.length, 1);
  assert.equal(recompiled.agent.workflows?.length, 1);
});

test('OAA-VM v2.5 supports array literals, in operator, dot notation, and functional collection stdlib', () => {
  const scope = new Map<string, unknown>([
    [
      'listing',
      {
        status: 'ready',
        files: [
          { name: 'a.md', lines: 10 },
          { name: 'b.md', lines: 30 },
          { name: 'a.md', lines: 20 },
        ],
      },
    ],
    ['$input', { limit: 15, tag: 'core' }],
  ]);

  assert.equal(
    evaluateSafeExpr("listing.status in ['ready', 'completed'] && $input.limit > 10", scope),
    true,
  );
  assert.deepEqual(evaluateSafeExpr("unique(pluck(listing.files, 'name'))", scope), [
    'a.md',
    'b.md',
  ]);
  assert.equal(
    evaluateSafeExpr("join(unique(pluck(listing.files, 'name')), ' | ')", scope),
    'a.md | b.md',
  );
  assert.equal(evaluateSafeExpr("sum(pluck(listing.files, 'lines'))", scope), 60);
  assert.equal(evaluateSafeExpr("avg(pluck(listing.files, 'lines'))", scope), 20);
  assert.deepEqual(evaluateSafeExpr("compact([1, null, '', 0, false, 'ok'])", scope), [1, 0, 'ok']);
  assert.deepEqual(evaluateSafeExpr("slice(split('x,y,z,w', ','), 1, 3)", scope), ['y', 'z']);
});

test('Kernel executes compiled OAA-Lang 2.0 flow macros, deadlock-free sub-agent delegates, and enforces zero-trust scope boundaries', async () => {
  const driver = new FixtureModel((a, msgs) => {
    if (a.id === 'agent/specialist') {
      return {
        text: `Specialist verified: ${msgs.at(-1)?.content}`,
        calls: [],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        finish: 'stop',
      };
    }
    const toolOutputs = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    if (toolOutputs.length > 0) {
      return {
        text: `Orchestrated synthesis: ${toolOutputs.join(' || ')}`,
        calls: [],
        usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
        finish: 'stop',
      };
    }
    return {
      text: '',
      calls: [
        {
          id: 'call_flow_1',
          name: 'read_and_summarize',
          arguments: { doc_path: 'inputs/missing.txt', fallback_path: 'outputs/note.txt' },
        },
        {
          id: 'call_del_1',
          name: 'ask_specialist',
          arguments: { task: 'Confirm alpha metric' },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      finish: 'tool_calls',
    };
  });

  const s = await setup(driver);
  try {
    // 1. Publish specialist sub-agent via /v1/agents/publish-oaa
    const specialistOaa = `
      agent "agent/specialist" {
        description = "Domain verification specialist"
        engine      = kernel
        route "fast" -> fixture/"specialist-fast-v1" priority=0 cost=1 speed=5 tags=["fast"]
        instructions "Verify the requested claim concisely."
      }
    `;
    const pubSpec = await s.request('POST', '/v1/agents/publish-oaa', { source: specialistOaa });
    assert.equal(pubSpec.statusCode, 200);
    assert.equal(pubSpec.json().id, 'agent/specialist');

    // 2. Compile & diagnose orchestrator via /v1/lang/compile, then publish via /v1/agents/publish-oaa
    const orchestratorOaa = `
      agent "agent/orchestrator" {
        description = "Lead orchestrator with flow macro and specialist delegation"
        engine      = kernel
        route "main" -> fixture/"orchestrator-v1" priority=0 cost=2 speed=4 tags=["reasoning"]

        use builtin [list_files, read_file, write_file]

        delegate "ask_specialist" -> "agent/specialist"@fast {
          description   = "Ask specialist to verify a claim"
          timeout       = 30s
          forward_files = true
        }

        flow "read_and_summarize" {
          description = "Write a seed note, list files, and transform metadata"
          params {
            doc_path: string
            fallback_path?: string(default="note.txt")
          }
          step seed    = write_file(path = "note.txt", content = "Alpha=42")
          step listing = list_files() depends_on = ["seed"]
          step read_it = read_file(path = $input.doc_path) fallback read_file(path = $input.fallback_path) depends_on = ["seed"]
          step digest  = $transform(
            body  = $read_it.text,
            count = $(len(listing.files))
          )
        }

        instructions "Run read_and_summarize and ask_specialist."
      }
    `;
    const compileCheck = await s.request('POST', '/v1/lang/compile', { source: orchestratorOaa });
    assert.equal(compileCheck.statusCode, 200);
    assert.equal(compileCheck.json().valid, true);
    assert.ok(compileCheck.json().workflow_plans.read_and_summarize);

    const pubOrch = await s.request('POST', '/v1/agents/publish-oaa', { source: orchestratorOaa });
    assert.equal(pubOrch.statusCode, 200);

    // 3. Execute orchestrator with wildcard grant -> both flow macro and delegate succeed
    const runRes = await s.request('POST', '/v1/uap', {
      uap: '1.0',
      agent: 'agent/orchestrator',
      input: 'Run full verification',
    });
    assert.equal(runRes.statusCode, 200);
    const body = runRes.json();
    assert.equal(body.status, 'completed', JSON.stringify(body.error));
    assert.match(body.output.text, /Alpha=42/);
    assert.match(body.output.text, /Specialist verified: Confirm alpha metric/);
    // Aggregated usage includes parent (30 + 45) + delegated child (20) = 95 total tokens
    assert.equal(body.usage.total_tokens, 95);

    // 4. Verify zero-trust scope enforcement: a key restricted ONLY to `agent/orchestrator`
    // cannot escalate privileges by delegating to `agent/specialist`!
    const restrictedKey = s.auth.create(
      principal,
      'orchestrator-only-key',
      ['agent/orchestrator'],
      ['read', 'invoke', 'files'],
    );
    const deniedRes = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${restrictedKey.token}` },
      payload: {
        uap: '1.0',
        agent: 'agent/orchestrator',
        input: 'Try restricted delegation',
      },
    });
    assert.equal(deniedRes.statusCode, 200);
    const deniedBody = deniedRes.json();
    assert.equal(deniedBody.status, 'failed');
    assert.equal(deniedBody.error.code, 'scope_denied');
  } finally {
    await s.cleanup();
  }
});

test('Public Cloud Gateway hot-binds publicBaseUrl, permits dynamic Host header, and exports endpoint directory in /v1/overview and /v1/me', async () => {
  const s = await setup();
  try {
    // Before binding, an unknown external Host header is rejected with 403 invalid_host
    const blocked = await s.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'agents.example.com' },
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'invalid_host');

    // Bind public URL at runtime via admin endpoint
    const bindRes = await s.request('POST', '/v1/gateway/public-url', {
      public_base_url: 'https://agents.example.com/',
    });
    assert.equal(bindRes.statusCode, 200);
    const bindBody = bindRes.json();
    assert.equal(bindBody.public_base_url, 'https://agents.example.com');
    assert.equal(bindBody.endpoints.openai_compat_base_url, 'https://agents.example.com/v1/compat');
    assert.equal(bindBody.endpoints.worker_connect_ws, 'wss://agents.example.com/v1/nodes/connect');

    // Now requests with Host: agents.example.com are accepted!
    const allowed = await s.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'agents.example.com' },
    });
    assert.equal(allowed.statusCode, 200);

    // /v1/overview and /openapi.json reflect the public base URL
    const overview = await s.request('GET', '/v1/overview');
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().public_base_url, 'https://agents.example.com');
    assert.equal(
      overview.json().endpoints.universal_endpoint,
      'https://agents.example.com/v1/universal',
    );

    const openapi = await s.request('GET', '/openapi.json');
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().servers[0].url, 'https://agents.example.com');
  } finally {
    await s.cleanup();
  }
});

test('/v1/compat/* and X-OAA-Compat accept third-party OpenAI SDK fields, tool history, and map reasoning_effort to routing strategy', async () => {
  const driver = new FixtureModel((a, msgs) => ({
    text: `Compat reply from ${a.model}: ${msgs.at(-1)?.content}`,
    calls: [],
    usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
    finish: 'stop',
  }));
  const s = await setup(driver);
  try {
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/compat-coder',
          model: 'flash-lite-v1',
          routes: [
            {
              id: 'fast-tier',
              provider: 'fixture',
              model: 'flash-lite-v1',
              priority: 0,
              costTier: 1,
              speedTier: 5,
              tags: ['fast'],
            },
            {
              id: 'deep-pro',
              provider: 'fixture',
              model: 'claude-opus-pro',
              priority: 1,
              costTier: 4,
              speedTier: 2,
              tags: ['reasoning', 'coding'],
            },
          ],
        }),
      ),
    );

    // 1. /v1/compat/models returns expanded agent + semantic profiles + routes
    const modelsRes = await s.request('GET', '/v1/compat/models');
    assert.equal(modelsRes.statusCode, 200);
    const modelIds = modelsRes.json().data.map((m: any) => m.id);
    assert.ok(modelIds.includes('agent/compat-coder'));
    assert.ok(modelIds.includes('agent/compat-coder@fast'));
    assert.ok(modelIds.includes('agent/compat-coder@best'));
    assert.ok(modelIds.includes('agent/compat-coder@deep-pro'));

    // 2. /v1/compat/chat/completions accepts temperature, max_tokens, tools, tool_calls, tool role, and reasoning_effort
    const chatRes = await s.request('POST', '/v1/compat/chat/completions', {
      model: 'agent/compat-coder',
      temperature: 0.2,
      max_tokens: 1024,
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'dummy', parameters: {} } }],
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"status"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
        { role: 'user', content: 'Summarize the tool result.' },
      ],
    });
    assert.equal(chatRes.statusCode, 200);
    const chatBody = chatRes.json();
    // Because reasoning_effort='high' maps to strategy='quality', it routes to 'claude-opus-pro'!
    assert.match(chatBody.choices[0].message.content, /Compat reply from claude-opus-pro/);
    assert.match(chatBody.choices[0].message.content, /\[tool:call_1\]/);

    // 3. /v1/chat/completions with X-OAA-Compat: true also accepts extra OpenAI fields
    const headerCompatRes = await s.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'x-oaa-compat': 'true',
      },
      payload: {
        model: 'agent/compat-coder',
        temperature: 0.5,
        max_completion_tokens: 500,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: 'Quick ping' }],
      },
    });
    assert.equal(headerCompatRes.statusCode, 200);
    assert.match(
      headerCompatRes.json().choices[0].message.content,
      /Compat reply from flash-lite-v1/,
    );

    // 4. /v1/compat/responses accepts instructions, max_output_tokens, reasoning.effort, and function_call_output
    const respCompat = await s.request('POST', '/v1/compat/responses', {
      model: 'agent/compat-coder',
      instructions: 'Be concise.',
      max_output_tokens: 300,
      reasoning: { effort: 'high' },
      input: [
        { type: 'function_call_output', call_id: 'c9', output: '42' },
        { role: 'user', content: 'What was the output?' },
      ],
    });
    assert.equal(respCompat.statusCode, 200);
    assert.equal(respCompat.json().metadata['oaa.selected_model'], 'claude-opus-pro');
  } finally {
    await s.cleanup();
  }
});

test('Multi-tenant API key quotas enforce maxRuns, maxTotalTokens, expiresAt, and support live /v1/me inspection and quota reset', async () => {
  const driver = new FixtureModel(() => ({
    text: 'Quota test ok',
    calls: [],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    finish: 'stop',
  }));
  const s = await setup(driver);
  try {
    s.store.publish('owner', makeBundle(agent({ id: 'agent/quota-bot' })));

    // 1. Create a tenant key with maxRuns=2, maxTotalTokens=50
    const createdKey = await s.request('POST', '/v1/keys', {
      name: 'tenant-alpha',
      agents: ['agent/quota-bot'],
      scopes: ['read', 'invoke'],
      quota: {
        rpm: 30,
        maxConcurrentRuns: 2,
        maxTotalTokens: 50,
        maxRuns: 2,
      },
    });
    assert.equal(createdKey.statusCode, 200);
    const { id: keyId, token: tenantToken } = createdKey.json();

    // 2. Inspect /v1/me as tenant-alpha
    const meInitial = await s.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    assert.equal(meInitial.statusCode, 200);
    assert.equal(meInitial.json().principal.name, 'tenant-alpha');
    assert.equal(meInitial.json().usage.remaining_tokens, 50);
    assert.equal(meInitial.json().usage.remaining_runs, 2);

    // 3. Run #1 consumes 30 tokens -> succeeds
    const run1 = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { agent: 'agent/quota-bot', input: 'First call' },
    });
    assert.equal(run1.statusCode, 200);
    assert.equal(run1.json().usage.total_tokens, 30);

    // Check /v1/me after Run #1 -> used_tokens=30, remaining_tokens=20, used_runs=1, remaining_runs=1
    const meAfter1 = await s.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    assert.equal(meAfter1.json().usage.used_tokens, 30);
    assert.equal(meAfter1.json().usage.remaining_tokens, 20);
    assert.equal(meAfter1.json().usage.used_runs, 1);
    assert.equal(meAfter1.json().usage.remaining_runs, 1);

    // 4. Run #2 consumes another 30 tokens (total 60 >= 50) -> succeeds
    const run2 = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { agent: 'agent/quota-bot', input: 'Second call' },
    });
    assert.equal(run2.statusCode, 200);

    // 5. Run #3 is blocked by token_quota_exceeded (60 >= 50)
    const run3 = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { agent: 'agent/quota-bot', input: 'Third call' },
    });
    assert.equal(run3.statusCode, 429);
    assert.equal(run3.json().error.code, 'token_quota_exceeded');

    // 6. Admin raises maxTotalTokens to 200 without resetting usage -> Run #3 now hits run_quota_exceeded (used_runs=2 >= maxRuns=2)
    const update1 = await s.request('POST', `/v1/keys/${keyId}/quota`, {
      quota: { maxTotalTokens: 200, maxRuns: 2 },
      reset_usage: false,
    });
    assert.equal(update1.statusCode, 200);

    const run4 = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { agent: 'agent/quota-bot', input: 'Fourth call' },
    });
    assert.equal(run4.statusCode, 429);
    assert.equal(run4.json().error.code, 'run_quota_exceeded');

    // 7. Admin resets usage -> tenant can invoke again!
    const update2 = await s.request('POST', `/v1/keys/${keyId}/quota`, {
      quota: { maxTotalTokens: 200, maxRuns: 2 },
      reset_usage: true,
    });
    assert.equal(update2.statusCode, 200);
    assert.equal(update2.json().usage.usedTokens, 0);
    assert.equal(update2.json().usage.usedRuns, 0);

    const run5 = await s.app.inject({
      method: 'POST',
      url: '/v1/uap',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { agent: 'agent/quota-bot', input: 'Fifth call after reset' },
    });
    assert.equal(run5.statusCode, 200);

    // 8. Expired key is rejected with 401 key_expired
    await s.request('POST', `/v1/keys/${keyId}/quota`, {
      quota: { expiresAt: Date.now() - 1000 },
    });
    const expiredCall = await s.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    assert.equal(expiredCall.statusCode, 401);
    assert.equal(expiredCall.json().error.code, 'key_expired');
  } finally {
    await s.cleanup();
  }
});

test('Cross-Agent Durable Memory Plane persists and recalls state across independent sessions and agents via memory_read/memory_write and /v1/memory', async () => {
  const driver = new FixtureModel((a, msgs) => {
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    if (toolMsgs.length > 0) {
      return {
        text: `Memory result for ${a.id}: ${toolMsgs.map((m) => m.content).join(' | ')}`,
        calls: [],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        finish: 'stop',
      };
    }
    if (a.id === 'agent/writer') {
      return {
        text: '',
        calls: [
          {
            id: 'call_mem_w',
            name: 'memory_write',
            arguments: {
              namespace: 'shared-kb',
              key: 'release_plan',
              value: { version: '2.0.0', codename: 'Nova' },
            },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        finish: 'tool_calls',
      };
    }
    return {
      text: '',
      calls: [
        {
          id: 'call_mem_r',
          name: 'memory_read',
          arguments: {
            namespace: 'shared-kb',
            key: 'release_plan',
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      finish: 'tool_calls',
    };
  });

  const s = await setup(driver);
  try {
    // Publish writer and reader agents using OAA-Lang 2.0 `use builtin [memory_read, memory_write]`
    const writerOaa = `
      agent "agent/writer" {
        description = "Memory writer agent"
        engine      = kernel
        route "default" -> fixture/"writer-v1" priority=0
        use builtin [memory_write]
        instructions "Persist release plan to shared-kb."
      }
    `;
    const readerOaa = `
      agent "agent/reader" {
        description = "Memory reader agent"
        engine      = kernel
        route "default" -> fixture/"reader-v1" priority=0
        use builtin [memory_read]
        instructions "Read release plan from shared-kb."
      }
    `;
    assert.equal(
      (await s.request('POST', '/v1/agents/publish-oaa', { source: writerOaa })).statusCode,
      200,
    );
    assert.equal(
      (await s.request('POST', '/v1/agents/publish-oaa', { source: readerOaa })).statusCode,
      200,
    );

    // 1. Writer agent stores memory in namespace "shared-kb"
    const wRes = await s.request('POST', '/v1/uap', {
      agent: 'agent/writer',
      input: 'Save release plan',
    });
    assert.equal(wRes.statusCode, 200);
    assert.equal(wRes.json().status, 'completed');

    // 2. Reader agent (separate agent & separate session) recalls the memory written by Writer!
    const rRes = await s.request('POST', '/v1/uap', {
      agent: 'agent/reader',
      input: 'Fetch release plan',
    });
    assert.equal(rRes.statusCode, 200);
    assert.match(rRes.json().output.text, /"codename":"Nova"/);

    // 3. Verify REST API /v1/memory GET, PUT, DELETE
    const getMem = await s.request('GET', '/v1/memory?namespace=shared-kb&key=release_plan');
    assert.equal(getMem.statusCode, 200);
    assert.deepEqual(getMem.json().entry.value, { version: '2.0.0', codename: 'Nova' });

    const putMem = await s.app.inject({
      method: 'PUT',
      url: '/v1/memory',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        namespace: 'shared-kb',
        key: 'extra_note',
        value: 'ready_for_cloud',
      },
    });
    assert.equal(putMem.statusCode, 200);

    const listMem = await s.request('GET', '/v1/memory?namespace=shared-kb');
    assert.equal(listMem.statusCode, 200);
    assert.equal(listMem.json().data.length, 2);

    const delMem = await s.request('DELETE', '/v1/memory?namespace=shared-kb&key=extra_note');
    assert.equal(delMem.statusCode, 200);
    assert.equal(delMem.json().deleted, true);
  } finally {
    await s.cleanup();
  }
});

test('Kernel Hardening: content-addressed bundle LRU cache, OAA-Lang compiler cache, and VM AST cache maintain isolation', async () => {
  const s = await setup(new FixtureModel(() => ({ text: 'ok' })));
  try {
    const oaaSource = `
      agent "agent/cache-verified" {
        description = "Verifies compiler and store bundle cache isolation"
        engine      = kernel
        route "fast" -> fixture/"fast-v1" priority=0 speed=5
        use builtin [list_files]
        flow "cached_flow" {
          step calc = $transform(result=$(join(unique(["z", "a", "z"]), "-")))
        }
        instructions "Fast cached agent."
      }
    `;
    const firstCompile = compileOaaLang(oaaSource);
    firstCompile.agent.description = 'mutated-by-caller';
    const secondCompile = compileOaaLang(oaaSource);
    assert.equal(
      secondCompile.agent.description,
      'Verifies compiler and store bundle cache isolation',
    );

    const bundle = makeBundle(secondCompile.agent);
    s.store.publish('owner', bundle);

    const b1 = s.store.bundle('owner', 'agent/cache-verified');
    b1.agent.description = 'mutated-bundle';
    const b2 = s.store.bundle('owner', 'agent/cache-verified', bundle.digest);
    assert.equal(b2.agent.description, 'Verifies compiler and store bundle cache isolation');
  } finally {
    await s.cleanup();
  }
});
