import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeBundle } from '../src/lang/bundle.js';
import { capabilitySchema } from '../src/core/contracts.js';
import { invocationSchema } from '../src/gateway/protocol.js';
import { sleep } from '../src/core/util.js';
import { agent, FixtureModel, principal, setup } from '../test/helpers.js';

type ScenarioResult = {
  samples: number;
  p50_ms: number;
  p95_ms: number;
  min_ms: number;
  runs_per_sec?: number;
  extra?: Record<string, unknown>;
};

type BenchmarkReport = {
  label: string;
  node: string;
  platform: string;
  cpus: number;
  started_at: string;
  scenarios: Record<string, ScenarioResult>;
  compare?: Record<string, { p50_change_percent: number }>;
  boundary: string;
};

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[index]!;
};

const round = (val: number, decimals = 2): number => Number(val.toFixed(decimals));

/**
 * 场景 1：simple-zero
 * 模型零延迟、直接返回一段文本、无工具。串行跑 200 次运行。
 * 指标：单次运行耗时（ms）、每秒完成运行数。
 */
async function runSimpleZero(): Promise<ScenarioResult> {
  const text = 'Simple zero-latency test response.';
  const model = new FixtureModel(() => ({ text }));
  const s = await setup(model);
  try {
    const bundle = makeBundle(agent());
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`simple-zero warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== text) {
        throw new Error('simple-zero warmup output mismatch');
      }
    }

    // 测量 200 次串行运行
    const samples: number[] = [];
    const totalStart = performance.now();
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `simple ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`simple-zero run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== text) {
        throw new Error('simple-zero output mismatch');
      }
      if (done.checkpoint.messages.some((m) => m.role === 'tool')) {
        throw new Error('simple-zero unexpected tool calls');
      }
      samples.push(round(ms, 3));
    }
    const totalElapsed = performance.now() - totalStart;
    const sorted = [...samples].sort((a, b) => a - b);
    const p50_ms = round(quantile(sorted, 0.5), 3);
    const p95_ms = round(quantile(sorted, 0.95), 3);
    const min_ms = round(sorted[0]!, 3);
    const runs_per_sec = round((samples.length / totalElapsed) * 1000, 2);

    return {
      samples: samples.length,
      p50_ms,
      p95_ms,
      min_ms,
      runs_per_sec,
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 2：concurrent-zero
 * 同样的零延迟运行，只用 setup() 默认的 owner / principal，一次并发提交 32 个运行（不超过单 owner 32 个未完成上限），等全部结束。
 * 指标：总耗时、每秒完成运行数。
 */
async function runConcurrentZero(): Promise<ScenarioResult> {
  const text = 'Concurrent zero-latency test response.';
  const model = new FixtureModel(() => ({ text }));
  const s = await setup(model);
  try {
    const bundle = makeBundle(agent({ description: 'Concurrent agent' }));
    s.store.publish(principal.owner, bundle);

    const concurrency = 32;

    // 预热 3 次（每批 32 个并发提交）
    for (let w = 0; w < 3; w++) {
      const warmupRuns = [];
      for (let i = 0; i < concurrency; i++) {
        const run = s.kernel.submit(
          principal,
          invocationSchema.parse({
            agent: 'agent/test',
            input: `concurrent warmup ${w} ${i}`,
            background: true,
          }),
        );
        warmupRuns.push(run);
      }
      const doneList = await Promise.all(warmupRuns.map((r) => s.kernel.wait(r.id)));
      for (const done of doneList) {
        if (done.status !== 'completed') {
          throw new Error(`concurrent-zero warmup failed: ${JSON.stringify(done.error)}`);
        }
        if (done.output.map((m) => m.text).join('') !== text) {
          throw new Error('concurrent-zero warmup output mismatch');
        }
      }
    }

    // 测量 10 批（每批 32 个并发提交并等全部结束，记录总耗时）
    const samples: number[] = [];
    const batchCount = 10;
    for (let b = 0; b < batchCount; b++) {
      const start = performance.now();
      const runs = [];
      for (let i = 0; i < concurrency; i++) {
        const run = s.kernel.submit(
          principal,
          invocationSchema.parse({
            agent: 'agent/test',
            input: `concurrent batch ${b} ${i}`,
            background: true,
          }),
        );
        runs.push(run);
      }
      const results = await Promise.all(runs.map((r) => s.kernel.wait(r.id)));
      const batchElapsed = performance.now() - start;
      for (const done of results) {
        if (done.status !== 'completed') {
          throw new Error(`concurrent-zero run failed: ${JSON.stringify(done.error)}`);
        }
        if (done.output.map((m) => m.text).join('') !== text) {
          throw new Error('concurrent-zero output mismatch');
        }
        if (done.checkpoint.messages.some((m) => m.role === 'tool')) {
          throw new Error('concurrent-zero unexpected tool calls');
        }
      }
      samples.push(round(batchElapsed, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50_ms = round(quantile(sorted, 0.5), 3);
    const p95_ms = round(quantile(sorted, 0.95), 3);
    const min_ms = round(sorted[0]!, 3);
    const runs_per_sec = round(concurrency / (p50_ms / 1000), 2);

    return {
      samples: samples.length,
      p50_ms,
      p95_ms,
      min_ms,
      runs_per_sec,
      extra: {
        concurrency,
        batches_measured: batchCount,
      },
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 3：tool-batch-mixed
 * 模型第一轮一次性返回 8 个工具调用，其中第 1 个耗时 80ms，其余 7 个各 5ms；
 * 智能体的 toolConcurrency 设为 2；第二轮模型返回最终文本。跑 20 次。
 */
async function runToolBatchMixed(): Promise<ScenarioResult> {
  const finalMsg = 'Completed tool-batch-mixed.';
  let toolCallsExecuted = 0;
  const model = new FixtureModel(async (_a, messages) => {
    const hasTools = messages.some((m) => m.role === 'tool');
    if (hasTools) {
      return { text: finalMsg };
    }
    return {
      calls: [
        { id: 'c0', name: 'work', arguments: { id: 'c0', delay: 80 } },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `c${i + 1}`,
          name: 'work',
          arguments: { id: `c${i + 1}`, delay: 5 },
        })),
      ],
    };
  });
  const s = await setup(model);
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/work-mixed',
      version: '1',
      description: 'Tool batch mixed test',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, delay: { type: 'integer' } },
        required: ['id', 'delay'],
      },
    });
    s.runtime.config.tools.push({
      reference: 'work',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('work', async (args, _ctx, signal) => {
      toolCallsExecuted++;
      await sleep(Number(args.delay), signal);
      return { value: { id: args.id, verified: true } };
    });
    const bundle = makeBundle(
      agent({
        limits: { toolConcurrency: 2 },
        tools: [{ name: 'work', capability, handler: { kind: 'node', reference: 'work' } }],
      }),
    );
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      toolCallsExecuted = 0;
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`tool-batch-mixed warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('tool-batch-mixed warmup text mismatch');
      }
      if (toolCallsExecuted !== 8) {
        throw new Error(`tool-batch-mixed warmup expected 8 tool calls, got ${toolCallsExecuted}`);
      }
    }

    // 测量 20 次
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      toolCallsExecuted = 0;
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `measure ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`tool-batch-mixed run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('tool-batch-mixed text mismatch');
      }
      if (toolCallsExecuted !== 8) {
        throw new Error(`tool-batch-mixed expected 8 tool calls, got ${toolCallsExecuted}`);
      }
      const toolMessages = done.checkpoint.messages.filter((m) => m.role === 'tool');
      if (toolMessages.length !== 8) {
        throw new Error(`tool-batch-mixed expected 8 tool messages, got ${toolMessages.length}`);
      }
      samples.push(round(ms, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    return {
      samples: samples.length,
      p50_ms: round(quantile(sorted, 0.5), 3),
      p95_ms: round(quantile(sorted, 0.95), 3),
      min_ms: round(sorted[0]!, 3),
      extra: {
        theoretical_optimal_ms: 80,
        theoretical_chunked_ms: 95,
        explanation: '就绪即补位调度理论最优 max(80, 7*5)=80ms，固定分块调度理论值为 80+5+5+5=95ms',
      },
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 4：tool-batch-wide
 * 模型一次返回 16 个各 2ms 的只读工具调用，toolConcurrency 为 8。指标：整次运行耗时。跑 30 次。
 */
async function runToolBatchWide(): Promise<ScenarioResult> {
  const finalMsg = 'Completed tool-batch-wide.';
  let toolCallsExecuted = 0;
  const model = new FixtureModel(async (_a, messages) => {
    const hasTools = messages.some((m) => m.role === 'tool');
    if (hasTools) return { text: finalMsg };
    return {
      calls: Array.from({ length: 16 }, (_, i) => ({
        id: `w${i}`,
        name: 'wide_work',
        arguments: { id: `w${i}` },
      })),
    };
  });
  const s = await setup(model);
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/wide-work',
      version: '1',
      description: 'Wide tool batch test',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    s.runtime.config.tools.push({
      reference: 'wide_work',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('wide_work', async (args, _ctx, signal) => {
      toolCallsExecuted++;
      await sleep(2, signal);
      return { value: { id: args.id, verified: true } };
    });
    const bundle = makeBundle(
      agent({
        limits: { toolConcurrency: 8 },
        tools: [
          { name: 'wide_work', capability, handler: { kind: 'node', reference: 'wide_work' } },
        ],
      }),
    );
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      toolCallsExecuted = 0;
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`tool-batch-wide warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('tool-batch-wide warmup text mismatch');
      }
      if (toolCallsExecuted !== 16) {
        throw new Error(`tool-batch-wide warmup expected 16 tool calls, got ${toolCallsExecuted}`);
      }
    }

    // 测量 30 次
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      toolCallsExecuted = 0;
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `measure ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`tool-batch-wide run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('tool-batch-wide text mismatch');
      }
      if (toolCallsExecuted !== 16) {
        throw new Error(`tool-batch-wide expected 16 tool calls, got ${toolCallsExecuted}`);
      }
      const toolMessages = done.checkpoint.messages.filter((m) => m.role === 'tool');
      if (toolMessages.length !== 16) {
        throw new Error(`tool-batch-wide expected 16 tool messages, got ${toolMessages.length}`);
      }
      samples.push(round(ms, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    return {
      samples: samples.length,
      p50_ms: round(quantile(sorted, 0.5), 3),
      p95_ms: round(quantile(sorted, 0.95), 3),
      min_ms: round(sorted[0]!, 3),
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 5：graph-16
 * 模型返回一个 execute_graph 调用，16 个步骤、4 层依赖（每层 4 个并行，后一层依赖前一层全部），每步 2ms。
 * 指标：整次运行耗时。跑 30 次。
 */
async function runGraph16(): Promise<ScenarioResult> {
  const finalMsg = 'Completed graph-16.';
  let stepsExecuted = 0;
  const graphSteps: Array<{
    id: string;
    tool: string;
    arguments: { id: string };
    depends_on?: string[];
  }> = [];

  for (let layer = 0; layer < 4; layer++) {
    const prevDeps = layer > 0 ? [0, 1, 2, 3].map((j) => `s${layer - 1}_${j}`) : [];
    for (let j = 0; j < 4; j++) {
      graphSteps.push({
        id: `s${layer}_${j}`,
        tool: 'graph_work',
        arguments: { id: `s${layer}_${j}` },
        ...(prevDeps.length ? { depends_on: prevDeps } : {}),
      });
    }
  }

  const model = new FixtureModel(async (_a, messages) => {
    const hasTools = messages.some((m) => m.role === 'tool');
    if (hasTools) return { text: finalMsg };
    return {
      calls: [
        {
          id: 'g16',
          name: 'execute_graph',
          arguments: { steps: graphSteps },
        },
      ],
    };
  });
  const s = await setup(model);
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/graph-work',
      version: '1',
      description: 'Graph step execution test',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    });
    s.runtime.config.tools.push({
      reference: 'graph_work',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('graph_work', async (args, _ctx, signal) => {
      stepsExecuted++;
      await sleep(2, signal);
      return { value: { id: args.id, verified: true } };
    });
    const bundle = makeBundle(
      agent({
        limits: { toolConcurrency: 8 },
        allowGraph: true,
        tools: [
          { name: 'graph_work', capability, handler: { kind: 'node', reference: 'graph_work' } },
        ],
      }),
    );
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      stepsExecuted = 0;
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`graph-16 warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('graph-16 warmup text mismatch');
      }
      if (stepsExecuted !== 16) {
        throw new Error(`graph-16 warmup expected 16 steps, got ${stepsExecuted}`);
      }
    }

    // 测量 30 次
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      stepsExecuted = 0;
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `measure ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`graph-16 run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('graph-16 text mismatch');
      }
      if (stepsExecuted !== 16) {
        throw new Error(`graph-16 expected 16 steps executed, got ${stepsExecuted}`);
      }
      samples.push(round(ms, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    return {
      samples: samples.length,
      p50_ms: round(quantile(sorted, 0.5), 3),
      p95_ms: round(quantile(sorted, 0.95), 3),
      min_ms: round(sorted[0]!, 3),
      extra: {
        steps: 16,
        layers: 4,
        steps_per_layer: 4,
        step_delay_ms: 2,
      },
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 6：multi-turn
 * 6 轮「模型 → 1 个零延迟工具 → 模型」，最后返回文本。指标：整次运行耗时、每轮平均开销。跑 30 次。
 */
async function runMultiTurn(): Promise<ScenarioResult> {
  const finalMsg = 'Multi-turn completed.';
  let toolExecutionCount = 0;
  const model = new FixtureModel(async (_a, messages) => {
    const toolTurns = messages.filter((m) => m.role === 'tool').length;
    if (toolTurns < 6) {
      return {
        calls: [
          {
            id: `turn_${toolTurns + 1}`,
            name: 'turn_tool',
            arguments: { round: toolTurns + 1 },
          },
        ],
      };
    }
    return { text: finalMsg };
  });
  const s = await setup(model);
  try {
    const capability = capabilitySchema.parse({
      id: 'bench/turn-tool',
      version: '1',
      description: 'Multi turn step tool',
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: {
        type: 'object',
        properties: { round: { type: 'integer' } },
        required: ['round'],
      },
    });
    s.runtime.config.tools.push({
      reference: 'turn_tool',
      capability,
      handler: { kind: 'read_directory', root: s.dir },
    });
    s.runtime.handlers.set('turn_tool', async (args) => {
      toolExecutionCount++;
      return { value: { round: args.round, verified: true } };
    });
    const bundle = makeBundle(
      agent({
        limits: { toolConcurrency: 1 },
        tools: [
          { name: 'turn_tool', capability, handler: { kind: 'node', reference: 'turn_tool' } },
        ],
      }),
    );
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      toolExecutionCount = 0;
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`multi-turn warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('multi-turn warmup text mismatch');
      }
      if (toolExecutionCount !== 6) {
        throw new Error(`multi-turn warmup expected 6 tool executions, got ${toolExecutionCount}`);
      }
    }

    // 测量 30 次
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      toolExecutionCount = 0;
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `measure ${i}`,
          background: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`multi-turn run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== finalMsg) {
        throw new Error('multi-turn text mismatch');
      }
      if (toolExecutionCount !== 6) {
        throw new Error(`multi-turn expected 6 tool executions, got ${toolExecutionCount}`);
      }
      const toolMessages = done.checkpoint.messages.filter((m) => m.role === 'tool');
      if (toolMessages.length !== 6) {
        throw new Error(`multi-turn expected 6 tool messages, got ${toolMessages.length}`);
      }
      samples.push(round(ms, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50_ms = round(quantile(sorted, 0.5), 3);
    const p95_ms = round(quantile(sorted, 0.95), 3);
    const min_ms = round(sorted[0]!, 3);
    return {
      samples: samples.length,
      p50_ms,
      p95_ms,
      min_ms,
      extra: {
        turns: 6,
        avg_turn_ms: round(p50_ms / 6, 3),
      },
    };
  } finally {
    await s.cleanup();
  }
}

/**
 * 场景 7：stream-deltas
 * 模型流式吐出 2000 个小文本增量。指标：整次运行耗时、每秒增量数。跑 10 次。
 */
async function runStreamDeltas(): Promise<ScenarioResult> {
  const chunkCount = 2000;
  const chunk = '12345678';
  const text = chunk.repeat(chunkCount);
  const model = new FixtureModel(() => ({ text }));
  const s = await setup(model);
  try {
    const bundle = makeBundle(agent());
    s.store.publish('owner', bundle);

    // 预热 3 次
    for (let i = 0; i < 3; i++) {
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `warmup ${i}`,
          background: true,
          stream: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      if (done.status !== 'completed') {
        throw new Error(`stream-deltas warmup failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== text) {
        throw new Error('stream-deltas warmup output mismatch');
      }
    }

    // 测量 10 次
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const run = s.kernel.submit(
        principal,
        invocationSchema.parse({
          agent: 'agent/test',
          input: `measure ${i}`,
          background: true,
          stream: true,
        }),
      );
      const done = await s.kernel.wait(run.id);
      const ms = performance.now() - start;
      if (done.status !== 'completed') {
        throw new Error(`stream-deltas run failed: ${JSON.stringify(done.error)}`);
      }
      if (done.output.map((m) => m.text).join('') !== text) {
        throw new Error('stream-deltas output mismatch');
      }

      // 校验历史事件中的增量数量与内容完整性
      let cursor = 0;
      let deltaCount = 0;
      let replay = '';
      while (true) {
        const events = s.store.history(run.id, cursor);
        if (!events.length) break;
        for (const e of events) {
          cursor = e.id;
          if (e.type === 'response.output_text.delta') {
            deltaCount++;
            replay += (e.data as { delta: string }).delta;
          }
        }
        if (events.length < 1000) break;
      }
      if (deltaCount !== chunkCount) {
        throw new Error(`stream-deltas expected ${chunkCount} deltas, got ${deltaCount}`);
      }
      if (replay !== text) {
        throw new Error('stream-deltas replayed text mismatch');
      }
      samples.push(round(ms, 3));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p50_ms = round(quantile(sorted, 0.5), 3);
    const p95_ms = round(quantile(sorted, 0.95), 3);
    const min_ms = round(sorted[0]!, 3);
    const deltas_per_sec = round(chunkCount / (p50_ms / 1000), 2);

    return {
      samples: samples.length,
      p50_ms,
      p95_ms,
      min_ms,
      extra: {
        delta_count: chunkCount,
        deltas_per_sec,
      },
    };
  } finally {
    await s.cleanup();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      label: { type: 'string' },
      out: { type: 'string' },
      compare: { type: 'string' },
      only: { type: 'string' },
    },
  });

  if (!values.label || !values.out) {
    throw new Error(
      'Usage: node dist/bench/kernel-core.js --label NAME --out NEW_REPORT.json [--compare BASELINE.json]',
    );
  }

  const outPath = path.resolve(values.out);
  const startedAt = new Date().toISOString();

  console.log(`Starting benchmark [${values.label}] on Node ${process.version}...`);

  const scenarios: Record<string, ScenarioResult> = {};

  const all: [string, () => Promise<ScenarioResult>][] = [
    ['simple-zero', runSimpleZero],
    ['concurrent-zero', runConcurrentZero],
    ['tool-batch-mixed', runToolBatchMixed],
    ['tool-batch-wide', runToolBatchWide],
    ['graph-16', runGraph16],
    ['multi-turn', runMultiTurn],
    ['stream-deltas', runStreamDeltas],
  ];
  // --only a,b 只跑指定场景，便于定位某一项的回退。
  const only = values.only ? new Set(values.only.split(',').map((name) => name.trim())) : null;
  const selected = all.filter(([name]) => !only || only.has(name));
  if (!selected.length) throw new Error(`--only matched no scenario: ${values.only}`);
  for (const [index, [name, run]] of selected.entries()) {
    console.log(`Running scenario ${index + 1}/${selected.length}: ${name}...`);
    scenarios[name] = await run();
  }

  let compareResult: Record<string, { p50_change_percent: number }> | undefined;
  if (values.compare) {
    const baselineRaw = await readFile(path.resolve(values.compare), 'utf8');
    const baseline = JSON.parse(baselineRaw) as {
      scenarios?: Record<string, { p50_ms: number }>;
    };
    if (baseline.scenarios) {
      compareResult = {};
      for (const [name, current] of Object.entries(scenarios)) {
        const base = baseline.scenarios[name];
        if (base && typeof base.p50_ms === 'number' && base.p50_ms > 0) {
          const change = round(((current.p50_ms - base.p50_ms) / base.p50_ms) * 100, 2);
          compareResult[name] = { p50_change_percent: change };
        }
      }
    }
  }

  const report: BenchmarkReport = {
    label: values.label,
    node: process.version,
    platform: process.platform,
    cpus: os.cpus().length,
    started_at: startedAt,
    scenarios,
    ...(compareResult ? { compare: compareResult } : {}),
    boundary: '进程内模拟模型与工具；不代表真实模型或网络耗时',
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  // flag: 'wx' 确保若输出文件已存在时直接抛错，拒绝覆盖
  await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });

  console.log('\n================ 基准测试报告 ================');
  console.log(`标签 (Label): ${report.label}`);
  console.log(
    `环境 (Node/Platform/CPUs): ${report.node} / ${report.platform} / ${report.cpus} cores`,
  );
  console.log(`开始时间: ${report.started_at}`);
  console.log(`输出文件: ${outPath}`);
  console.log('---------------- 场景指标详情 ----------------');
  for (const [name, sc] of Object.entries(scenarios)) {
    const compareInfo = compareResult?.[name]
      ? ` | 相对基线 p50 变化: ${compareResult[name].p50_change_percent > 0 ? '+' : ''}${compareResult[name].p50_change_percent}%`
      : '';
    const rpsInfo = sc.runs_per_sec !== undefined ? ` | runs/s: ${sc.runs_per_sec}` : '';
    console.log(
      `[${name}] 样本数: ${sc.samples} | p50: ${sc.p50_ms}ms | p95: ${sc.p95_ms}ms | min: ${sc.min_ms}ms${rpsInfo}${compareInfo}`,
    );
    if (sc.extra) {
      console.log(`  额外指标: ${JSON.stringify(sc.extra)}`);
    }
  }
  console.log('----------------------------------------------');
  console.log(`边界声明: ${report.boundary}`);
  console.log('==============================================\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
