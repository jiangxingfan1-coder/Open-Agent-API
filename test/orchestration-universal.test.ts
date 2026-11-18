import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { setup, agent, FixtureModel, principal } from './helpers.js';
import { validateOrchestrationPlan } from '../src/kernel/orchestration.js';
import { refreshAgentModels, supportsReasoning } from '../src/fabric/model-pool.js';
import {
  buildHandoffBrief,
  buildHandoffSystemPrompt,
  extractStructuredHandoff,
} from '../src/kernel/handoff.js';
import {
  EVALUATION_DIMENSIONS,
  evaluationCases,
  evaluationSettingsSchema,
  scoreEvaluation,
} from '../src/core/model-evaluation.js';
import { ModelEvaluator } from '../src/kernel/model-evaluation.js';
import { ModelEvaluations } from '../src/store/model-evaluations.js';
import { sha } from '../src/core/util.js';
import type { ModelMessage, Work } from '../src/core/contracts.js';

test('1. dedicated orchestration.planner unlocks @best / @fast / @eco / recommend for opaque external engines and enforces grants & trust', async () => {
  const plannerCalls: { agent: string; model: string; input: string }[] = [];
  const externalCalls: { model: string; input: string; toolsDisabled?: boolean }[] = [];

  const driver = new FixtureModel((a, messages) => {
    const input = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    plannerCalls.push({ agent: a.id, model: a.model, input });
    if (input.startsWith('Plan this task;')) {
      // Intentionally emit review on the primary external agent to verify automatic routing to planner!
      return {
        text: JSON.stringify({
          stages: [
            {
              id: 'execute',
              role: 'execute',
              agent: 'agent/opaque-cli',
              model: 'ext-pro',
              task: 'Implement the requested CLI workflow.',
            },
            {
              id: 'review',
              role: 'review',
              agent: 'agent/opaque-cli',
              model: 'ext-pro',
              task: 'Verify the CLI output against requirements.',
            },
          ],
        }),
      };
    }
    if (input.startsWith('Review the completed task')) {
      assert.match(input, /OPAQUE_EXEC_OUTPUT/);
      return {
        text: JSON.stringify({
          passed: true,
          summary: 'Verified by the dedicated planner.',
        }),
      };
    }
    return { text: 'Unexpected kernel call.' };
  });

  const s = await setup(driver);
  try {
    // Register an external engine node that does NOT advertise toolFreeReasoning.
    s.hub.addLocal(
      {
        nodeId: 'opaque-node',
        owner: 'owner',
        token: 'opaque-token',
        agents: ['*'],
        capabilities: ['*'],
      },
      {
        advertisement: () => ({
          nodeId: 'opaque-node',
          providers: [],
          natives: ['adapter/opaque'],
          capabilities: [],
          warm: [],
          concurrency: 2,
          execution: {
            builtins: [],
            scripts: [],
            toolSelection: true,
            agentPolicyVersion: 1,
            nativeModels: { 'adapter/opaque': { mode: 'declared' } },
          },
        }),
        install: async () => {},
        close: async () => {},
        execute: async (work: Work) => {
          const nativeWork = work as Extract<Work, { kind: 'native' }>;
          externalCalls.push({
            model: nativeWork.agent.model,
            input: nativeWork.input,
            toolsDisabled: nativeWork.toolsDisabled,
          });
          return {
            text: `OPAQUE_EXEC_OUTPUT:${nativeWork.agent.model}`,
            nativeState: { session: 'opaque-1' },
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          };
        },
      },
    );

    // Without a planner, automatic orchestration on an engine lacking toolFreeReasoning is refused.
    const unplannable = agent({
      id: 'agent/opaque-no-planner',
      engine: 'adapter/opaque',
      provider: 'native',
      model: 'ext-fast',
      allowGraph: false,
      orchestration: { enabled: true, scope: 'agent' },
      routes: [
        { id: 'ext-fast', provider: 'native', model: 'ext-fast', priority: 0 },
        { id: 'ext-pro', provider: 'native', model: 'ext-pro', priority: 1 },
      ],
    });
    s.store.publish('owner', makeBundle(unplannable));
    assert.throws(
      () =>
        s.kernel.submit(principal, {
          protocol: 'oaa/1',
          agent: unplannable.id,
          model: '@best',
          input: 'Plan without a planner',
          file_ids: [],
          metadata: {},
          stream: false,
          background: true,
        }),
      { code: 'capability_unavailable' },
    );

    // Publish a dedicated Kernel planner agent with multiple routes.
    const planner = agent({
      id: 'agent/planner',
      model: 'plan-fast',
      access: {
        modes: ['managed'],
        defaultMode: 'managed',
        approval: 'auto',
        trust: 'private',
      },
      routes: [
        { id: 'plan-fast', provider: 'fixture', model: 'plan-fast', priority: 0 },
        { id: 'plan-deep', provider: 'fixture', model: 'plan-deep', priority: 1 },
      ],
    });
    s.store.publish('owner', makeBundle(planner));

    const orchestratedExternal = agent({
      id: 'agent/opaque-cli',
      engine: 'adapter/opaque',
      provider: 'native',
      model: 'ext-fast',
      allowGraph: false,
      orchestration: {
        enabled: true,
        scope: 'agent',
        planner: { agent: 'agent/planner', route: 'plan-deep' },
      },
      routes: [
        { id: 'ext-fast', provider: 'native', model: 'ext-fast', priority: 0 },
        { id: 'ext-pro', provider: 'native', model: 'ext-pro', priority: 1 },
      ],
    });
    s.store.publish('owner', makeBundle(orchestratedExternal));

    // Caller without invoke grant on planner cannot unlock automatic orchestration.
    assert.throws(
      () =>
        s.kernel.submit(
          { ...principal, scopes: ['invoke', 'read'], agents: ['agent/opaque-cli'] },
          {
            protocol: 'oaa/1',
            agent: orchestratedExternal.id,
            model: '@best',
            input: 'Unauthorized planner attempt',
            file_ids: [],
            metadata: {},
            stream: false,
            background: true,
          },
        ),
      { code: 'capability_unavailable' },
    );

    // Public/external caller cannot cross into a private planner.
    assert.throws(
      () =>
        s.kernel.submit(
          { ...principal, scopes: ['invoke', 'read'], externalCaller: true },
          {
            protocol: 'oaa/1',
            agent: orchestratedExternal.id,
            model: '@best',
            input: 'External caller against private planner',
            file_ids: [],
            metadata: {},
            stream: false,
            background: true,
          },
        ),
      { code: 'capability_unavailable' },
    );

    // Authorized `recommend` preview plans via planner without ever starting the external engine!
    const recRun = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: orchestratedExternal.id,
      model: '@eco',
      input: 'Preview the orchestration plan safely.',
      file_ids: [],
      metadata: { 'oaa.orchestration_action': 'recommend' },
      stream: false,
      background: true,
    });
    const recDone = await s.kernel.wait(recRun.id);
    assert.equal(recDone.status, 'completed', JSON.stringify(recDone.error));
    assert.equal(externalCalls.length, 0);
    assert.equal(plannerCalls.length, 1);
    assert.equal(plannerCalls[0]!.agent, 'agent/planner');
    assert.equal(plannerCalls[0]!.model, 'plan-deep');
    const recommendation = JSON.parse(recDone.output.map((m) => m.text).join(''));
    assert.equal(recommendation.executed, false);
    assert.equal(recommendation.mode, 'cost');
    assert.equal(recommendation.stages[0].agent, 'agent/opaque-cli');
    assert.equal(recommendation.stages[1].agent, 'agent/planner');

    // Full `@best` run: plan -> external execute -> planner review!
    plannerCalls.length = 0;
    const bestRes = await s.request('POST', '/v1/responses', {
      model: 'agent/opaque-cli@best',
      input: 'Deliver and review the complete implementation for this architecture.',
    });
    assert.equal(bestRes.statusCode, 200, bestRes.body);
    const completed = s.store.run(bestRes.json().id);
    assert.equal(completed.metadata['oaa.orchestration_mode'], 'quality');
    assert.equal(completed.metadata['oaa.review'], 'passed');
    assert.equal(externalCalls.length, 1);
    assert.equal(externalCalls[0]!.model, 'ext-pro');
    assert.equal(externalCalls[0]!.toolsDisabled, undefined);
    assert.deepEqual(
      plannerCalls.map((c) => c.model),
      ['plan-deep', 'plan-deep'],
    );
    assert.equal(completed.output.map((m) => m.text).join(''), 'OPAQUE_EXEC_OUTPUT:ext-pro');
  } finally {
    await s.cleanup();
  }
});

test('2. nodes advertising toolFreeReasoning for codex and adapter/<acp> orchestrate directly', async () => {
  const s = await setup();
  const dispatched: { engine: string; model: string; toolsDisabled: boolean }[] = [];
  try {
    s.hub.addLocal(
      {
        nodeId: 'universal-node',
        owner: 'owner',
        token: 'univ-token',
        agents: ['*'],
        capabilities: ['*'],
      },
      {
        advertisement: () => ({
          nodeId: 'universal-node',
          providers: [],
          natives: ['codex', 'adapter/acp-agent'],
          capabilities: [],
          warm: [],
          concurrency: 4,
          execution: {
            builtins: [],
            scripts: [],
            toolSelection: true,
            nativeModels: {
              codex: { mode: 'declared' },
              'adapter/acp-agent': { mode: 'declared' },
            },
            agentPolicyVersion: 1,
            toolFreeReasoning: ['codex', 'adapter/acp-agent'],
          },
        }),
        install: async () => {},
        close: async () => {},
        execute: async (work: Work) => {
          const w = work as Extract<Work, { kind: 'native' }>;
          dispatched.push({
            engine: w.agent.engine,
            model: w.agent.model,
            toolsDisabled: Boolean(w.toolsDisabled),
          });
          if (w.input.startsWith('Plan this task;')) {
            return {
              text: JSON.stringify({
                stages: [
                  {
                    id: 'execute',
                    role: 'execute',
                    agent: w.agent.id,
                    model: 'deep-route',
                    task: 'Execute on the selected model.',
                  },
                  {
                    id: 'review',
                    role: 'review',
                    agent: w.agent.id,
                    model: 'fast-route',
                    task: 'Verify the execution output.',
                  },
                ],
              }),
              nativeState: {},
              usage: null,
            };
          }
          if (w.input.startsWith('Review the completed task')) {
            return {
              text: JSON.stringify({ passed: true, summary: 'Verified via tool-free pass.' }),
              nativeState: {},
              usage: null,
            };
          }
          return {
            text: `DIRECT_DONE:${w.agent.engine}:${w.agent.model}`,
            nativeState: { thread: 't1' },
            usage: null,
          };
        },
      },
    );

    for (const [id, engine] of [
      ['agent/codex-auto', 'codex'],
      ['agent/acp-auto', 'adapter/acp-agent'],
    ] as const) {
      const def = agent({
        id,
        engine,
        provider: 'native',
        model: 'fast-route',
        allowGraph: false,
        orchestration: { enabled: true, scope: 'agent' },
        routes: [
          { id: 'fast-route', provider: 'native', model: 'fast-route', priority: 0 },
          { id: 'deep-route', provider: 'native', model: 'deep-route', priority: 1 },
        ],
      });
      s.store.publish('owner', makeBundle(def));
      assert.equal(supportsReasoning(s.hub, 'owner', def), true);

      dispatched.length = 0;
      const run = s.kernel.submit(principal, {
        protocol: 'oaa/1',
        agent: id,
        model: '@best',
        input: `Orchestrate ${engine} directly with tool-free planning and review.`,
        file_ids: [],
        metadata: {},
        stream: false,
        background: true,
      });
      const done = await s.kernel.wait(run.id);
      assert.equal(done.status, 'completed', JSON.stringify(done.error));
      assert.equal(done.output.map((m) => m.text).join(''), `DIRECT_DONE:${engine}:deep-route`);
      assert.deepEqual(dispatched, [
        { engine, model: 'fast-route', toolsDisabled: true },
        { engine, model: 'deep-route', toolsDisabled: false },
        { engine, model: 'fast-route', toolsDisabled: true },
      ]);
    }
  } finally {
    await s.cleanup();
  }
});

test('3. scope="helpers" multi-agent analyze -> execute -> review pipeline forwards outputs and artifacts', async () => {
  let reviewCalls = 0;
  let builderExecutions = 0;
  const reviewerInputs: string[] = [];

  const driver = new FixtureModel((a, messages) => {
    const userText = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (a.id === 'agent/lead' && userText.startsWith('Plan this task;')) {
      assert.ok(!userText.includes('agent/ungranted'), 'ungranted helper must not enter pools');
      return {
        text: JSON.stringify({
          stages: [
            {
              id: 'analyze',
              role: 'analyze',
              agent: 'agent/analyst',
              model: 'analyst-m1',
              task: 'Identify key schema constraints.',
            },
            {
              id: 'build',
              role: 'execute',
              agent: 'agent/builder',
              model: 'builder-m1',
              task: 'Write artifact deliverable.json based on analysis.',
            },
            {
              id: 'verify',
              role: 'review',
              agent: 'agent/reviewer',
              model: 'reviewer-m1',
              task: 'Check deliverable.json and prior outputs.',
            },
          ],
        }),
      };
    }
    if (a.id === 'agent/analyst') {
      return { text: 'ANALYSIS_FINDING: version must be 2.' };
    }
    if (a.id === 'agent/builder') {
      if (!hasToolResult) {
        builderExecutions++;
        assert.match(userText, /ANALYSIS_FINDING: version must be 2\./);
        const version = builderExecutions === 1 ? 1 : 2;
        return {
          calls: [
            {
              id: `write_${builderExecutions}`,
              name: 'write_file',
              arguments: {
                path: 'deliverable.json',
                content: JSON.stringify({ version, builtBy: 'agent/builder' }),
              },
            },
          ],
        };
      }
      return { text: `BUILDER_COMPLETED_PASS_${builderExecutions}` };
    }
    if (a.id === 'agent/reviewer') {
      reviewCalls++;
      reviewerInputs.push(userText);
      const passed = reviewCalls >= 2;
      return {
        text: JSON.stringify({
          passed,
          summary: passed ? 'Artifact version=2 verified.' : 'Version was 1 instead of 2.',
          ...(passed ? {} : { correction: 'Update deliverable.json to version 2.' }),
        }),
      };
    }
    return { text: 'Unexpected call' };
  });

  const s = await setup(driver);
  try {
    const analyst = agent({
      id: 'agent/analyst',
      model: 'analyst-m1',
      routes: [{ id: 'analyst-m1', provider: 'fixture', model: 'analyst-m1', priority: 0 }],
    });
    const builder = agent({
      id: 'agent/builder',
      model: 'builder-m1',
      tools: [builtin('write_file')],
      routes: [{ id: 'builder-m1', provider: 'fixture', model: 'builder-m1', priority: 0 }],
    });
    const reviewer = agent({
      id: 'agent/reviewer',
      model: 'reviewer-m1',
      routes: [{ id: 'reviewer-m1', provider: 'fixture', model: 'reviewer-m1', priority: 0 }],
    });
    const ungranted = agent({
      id: 'agent/ungranted',
      model: 'secret-m1',
      routes: [{ id: 'secret-m1', provider: 'fixture', model: 'secret-m1', priority: 0 }],
    });
    const lead = agent({
      id: 'agent/lead',
      model: 'lead-m1',
      orchestration: {
        enabled: true,
        scope: 'helpers',
        helpers: ['agent/analyst', 'agent/builder', 'agent/reviewer', 'agent/ungranted'],
      },
      routes: [{ id: 'lead-m1', provider: 'fixture', model: 'lead-m1', priority: 0 }],
    });

    // Unit validation for `scope: 'helpers'` stage rules.
    const samplePools = new Map([
      ['agent/lead', ['lead-m1']],
      ['agent/analyst', ['analyst-m1']],
      ['agent/builder', ['builder-m1']],
      ['agent/reviewer', ['reviewer-m1']],
    ]);
    const validPipeline = validateOrchestrationPlan(
      {
        stages: [
          {
            id: 'analyze',
            role: 'analyze',
            agent: 'agent/analyst',
            model: 'analyst-m1',
            task: 'Analyze',
          },
          {
            id: 'exec1',
            role: 'execute',
            agent: 'agent/builder',
            model: 'builder-m1',
            task: 'Step 1',
          },
          {
            id: 'exec2',
            role: 'execute',
            agent: 'agent/lead',
            model: 'lead-m1',
            task: 'Step 2',
          },
          {
            id: 'review',
            role: 'review',
            agent: 'agent/reviewer',
            model: 'reviewer-m1',
            task: 'Review',
          },
        ],
      },
      lead,
      samplePools,
      8,
    );
    assert.equal(validPipeline.length, 4);
    assert.throws(() =>
      validateOrchestrationPlan(
        {
          stages: [
            {
              id: 'analyze',
              role: 'analyze',
              agent: 'agent/analyst',
              model: 'analyst-m1',
              task: 'No execute stage',
            },
          ],
        },
        lead,
        samplePools,
        8,
      ),
    );

    for (const def of [analyst, builder, reviewer, ungranted, lead]) {
      s.store.publish('owner', makeBundle(def));
    }

    const scopedCaller = {
      ...principal,
      scopes: ['invoke', 'read', 'files'],
      agents: ['agent/lead', 'agent/analyst', 'agent/builder', 'agent/reviewer'],
    };
    const submitted = s.kernel.submit(scopedCaller, {
      protocol: 'oaa/1',
      agent: 'agent/lead',
      model: '@best',
      input: 'Design, build, and review deliverable.json across specialized agents.',
      file_ids: [],
      metadata: {},
      stream: false,
      background: true,
    });
    const done = await s.kernel.wait(submitted.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(builderExecutions, 2, 'negative review must re-invoke the helper executor');
    assert.equal(reviewCalls, 2);
    assert.equal(done.metadata['oaa.review'], 'passed');
    assert.equal(done.output.map((m) => m.text).join(''), 'BUILDER_COMPLETED_PASS_2');
    assert.ok(
      done.artifactIds.length >= 1,
      'helper execution artifacts are retained on parent run',
    );

    // Reviewer received both prior stage outputs, artifact metadata (name/id/sha256), and file excerpt.
    const finalReviewPrompt = reviewerInputs.at(-1)!;
    assert.match(finalReviewPrompt, /\[analyze \(agent\/analyst\)\] ANALYSIS_FINDING/);
    assert.match(finalReviewPrompt, /Artifacts: deliverable\.json \(id=artifact_/);
    assert.match(finalReviewPrompt, /sha256=[a-f0-9]{64}/);
    assert.match(finalReviewPrompt, /\\"version\\":2/);
  } finally {
    await s.cleanup();
  }
});

test('4. structured handoff injects source agent, confirmed step summary, and artifact manifest while isolating subjects and private prompts', async () => {
  const kernelSeen: { agent: string; messages: ModelMessage[] }[] = [];
  const externalInputs: string[] = [];
  const artifactContent = '{"schema":"v3","ready":true}';
  const expectedSha = sha(Buffer.from(artifactContent));

  const driver = new FixtureModel((a, messages) => {
    kernelSeen.push({ agent: a.id, messages: messages.map((m) => ({ ...m })) });
    if (a.id === 'agent/author' && !messages.some((m) => m.role === 'tool')) {
      return {
        calls: [
          {
            id: 'c_write',
            name: 'write_file',
            arguments: { path: 'manifest.json', content: artifactContent },
          },
        ],
      };
    }
    return { text: `DONE_BY_${a.id}` };
  });

  const s = await setup(driver);
  try {
    s.hub.addLocal(
      {
        nodeId: 'ext-handoff',
        owner: 'owner',
        token: 'ext-token',
        agents: ['*'],
        capabilities: ['*'],
      },
      {
        advertisement: () => ({
          nodeId: 'ext-handoff',
          providers: [],
          natives: ['adapter/ext-worker'],
          capabilities: [],
          warm: [],
          concurrency: 2,
        }),
        install: async () => {},
        close: async () => {},
        execute: async (work: Work) => {
          externalInputs.push(String((work as { input?: unknown }).input));
          return { text: 'EXT_HANDOFF_DONE', nativeState: { s: '1' }, usage: null };
        },
      },
    );

    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/author',
          instructions: 'PRIVATE_AUTHOR_SYSTEM_SECRET_991',
          tools: [builtin('write_file')],
        }),
      ),
    );
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/ext-target',
          engine: 'adapter/ext-worker',
          provider: 'native',
          model: 'default',
          allowGraph: false,
        }),
      ),
    );
    s.store.publish(
      'owner',
      makeBundle(
        agent({ id: 'agent/kernel-target', instructions: 'You are the kernel reviewer.' }),
      ),
    );

    const callerA = {
      name: 'caller-a',
      owner: 'owner',
      subject: 'subj:alpha',
      agents: ['*'],
      scopes: ['invoke', 'read', 'files'],
    };
    const callerB = {
      name: 'caller-b',
      owner: 'owner',
      subject: 'subj:beta',
      agents: ['*'],
      scopes: ['invoke', 'read', 'files'],
    };

    const first = await s.kernel.wait(
      s.kernel.submit(callerA, {
        protocol: 'oaa/1',
        agent: 'agent/author',
        model: 'auto',
        input: 'Generate manifest.json for the release.',
        file_ids: [],
        metadata: {},
        stream: false,
        background: true,
      }).id,
    );
    assert.equal(first.status, 'completed');
    assert.equal(first.artifactIds.length, 1);
    const artifactId = first.artifactIds[0]!;

    // Tenant and subject isolation: another subject or another owner cannot extract or handoff `first`.
    assert.throws(() => extractStructuredHandoff(s.store, first, 'second', undefined), {
      code: 'run_not_found',
    });
    assert.throws(() => extractStructuredHandoff(s.store, first, 'owner', 'subj:beta'), {
      code: 'run_not_found',
    });
    assert.throws(
      () =>
        s.kernel.submit(callerB, {
          protocol: 'oaa/1',
          agent: 'agent/kernel-target',
          model: 'auto',
          input: 'Cross-subject handoff attempt',
          previous_response_id: first.id,
          handoff: true,
          file_ids: [],
          metadata: {},
          stream: false,
          background: true,
        }),
      { code: 'run_not_found' },
    );

    // 4a. Handoff to external agent: `handoffBrief` carries source agent, confirmed step, and artifact id/sha256.
    const extRun = await s.kernel.wait(
      s.kernel.submit(callerA, {
        protocol: 'oaa/1',
        agent: 'agent/ext-target',
        model: 'auto',
        input: 'Deploy using the generated manifest.',
        previous_response_id: first.id,
        handoff: true,
        file_ids: [],
        metadata: {},
        stream: false,
        background: true,
      }).id,
    );
    assert.equal(extRun.status, 'completed');
    assert.equal(externalInputs.length, 1);
    const brief = externalInputs[0]!;
    assert.match(brief, /来源智能体=agent\/author/);
    assert.match(
      brief,
      /最后确认步骤：write_file \[idempotent-write\]: path=outputs\/manifest\.json/,
    );
    assert.ok(brief.includes(`manifest.json (id=${artifactId}, sha256=${expectedSha})`));
    assert.equal(brief.includes('PRIVATE_AUTHOR_SYSTEM_SECRET_991'), false);

    // 4b. Handoff to Kernel agent: system prompt carries structured handoff block without leaking private prompt.
    const kernelRun = await s.kernel.wait(
      s.kernel.submit(callerA, {
        protocol: 'oaa/1',
        agent: 'agent/kernel-target',
        model: 'auto',
        input: 'Audit the manifest artifact.',
        previous_response_id: first.id,
        handoff: true,
        file_ids: [],
        metadata: {},
        stream: false,
        background: true,
      }).id,
    );
    assert.equal(kernelRun.status, 'completed');
    const targetCall = kernelSeen.find((c) => c.agent === 'agent/kernel-target')!;
    const systemText = targetCall.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    assert.match(systemText, /\[Structured Handoff Context\]/);
    assert.match(systemText, /Source agent: agent\/author/);
    assert.match(systemText, /Last confirmed step: write_file \[idempotent-write\]/);
    assert.ok(systemText.includes(`manifest.json | ${artifactId} | ${expectedSha}`));
    assert.equal(
      targetCall.messages.some((m) => m.content.includes('PRIVATE_AUTHOR_SYSTEM_SECRET_991')),
      false,
    );

    // Boundedness check on huge structured payloads.
    const boundedPrompt = buildHandoffSystemPrompt({
      fromAgent: 'agent/author',
      previousRunId: 'resp_1',
      lastStepSummary: 'x'.repeat(5000),
      steps: Array.from({ length: 20 }, (_, i) => ({
        name: `step_${i}`,
        effect: 'read' as const,
        summary: 'y'.repeat(500),
      })),
      artifacts: Array.from({ length: 60 }, (_, i) => ({
        id: `artifact_${i}`,
        name: `out_${i}.txt`,
        sha256: 'a'.repeat(64),
      })),
    });
    assert.ok(boundedPrompt.length <= 4000);
    const boundedBrief = buildHandoffBrief({
      fromAgent: 'agent/author',
      conversation: [{ role: 'user', content: 'hello' }],
      inputFiles: [],
      artifacts: ['out_0.txt'],
      structured: {
        fromAgent: 'agent/author',
        lastStepSummary: 'z'.repeat(1000),
        steps: [],
        artifacts: Array.from({ length: 60 }, (_, i) => ({
          id: `artifact_${i}`,
          name: `out_${i}.txt`,
          sha256: 'b'.repeat(64),
        })),
      },
    });
    assert.ok(boundedBrief.length <= 12_000);
  } finally {
    await s.cleanup();
  }
});

test('5. tool_calling evaluation dimension scores nested argument constraints, persists, and drives tool-heavy routing', async () => {
  assert.ok(EVALUATION_DIMENSIONS.includes('tool_calling'));
  const cases = evaluationCases('seed-alpha');
  const toolCases = cases.filter((c) => c.dimension === 'tool_calling');
  assert.equal(toolCases.length, 2);

  for (const sample of toolCases) {
    const expected = sample.expected as {
      tool: string;
      arguments: {
        filter: { environment: string; min_duration_ms: number; tags: string[] };
        page: { limit: number; order: string };
      };
    };
    // Key-order-independent deterministic match on nested objects!
    const reordered = {
      arguments: {
        page: { order: expected.arguments.page.order, limit: expected.arguments.page.limit },
        filter: {
          tags: expected.arguments.filter.tags,
          min_duration_ms: expected.arguments.filter.min_duration_ms,
          environment: expected.arguments.filter.environment,
        },
      },
      tool: expected.tool,
    };
    assert.equal(scoreEvaluation(sample, JSON.stringify(reordered)), true);
    // Reject wrong tool selection (destructive write tool).
    assert.equal(
      scoreEvaluation(sample, JSON.stringify({ ...expected, tool: 'purge_traces' })),
      false,
    );
    // Reject unclamped boundary violations (limit > 50).
    assert.equal(
      scoreEvaluation(
        sample,
        JSON.stringify({
          ...expected,
          arguments: { ...expected.arguments, page: { ...expected.arguments.page, limit: 99 } },
        }),
      ),
      false,
    );
    // Reject unsorted/duplicate tags or injected fields.
    assert.equal(
      scoreEvaluation(
        sample,
        JSON.stringify({
          ...expected,
          arguments: {
            ...expected.arguments,
            filter: { ...expected.arguments.filter, tags: ['z', 'a', 'a'] },
          },
        }),
      ),
      false,
    );
  }

  // End-to-end evaluator run + SQLite persistence + tool-heavy route selection!
  const epoch = Math.floor(Date.now() / (24 * 3_600_000));
  let expectedMap = new Map<string, unknown>();

  const driver = new FixtureModel((a, messages) => {
    const prompt = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    const matched = [...expectedMap.entries()].find(([p]) => prompt.includes(p));
    if (!matched) return { text: '{}' };
    const [, expected] = matched;
    // `route-precise` passes all dimensions including `tool_calling`;
    // `route-sloppy-tools` fails `tool_calling` cases (wrong tool choice) while passing others.
    const isToolCase = prompt.includes('"query_traces"');
    if (a.model === 'sloppy-tools' && isToolCase) {
      return { text: JSON.stringify({ tool: 'purge_traces', arguments: {} }) };
    }
    return { text: JSON.stringify(expected) };
  });

  const s = await setup(driver);
  const evaluator = new ModelEvaluator(s.store, s.hub, s.kernel);
  try {
    const toolRichAgent = agent({
      id: 'agent/tool-rich',
      model: 'sloppy-tools',
      tools: [
        builtin('read_file'),
        builtin('write_file'),
        builtin('list_files'),
        builtin('memory_read'),
      ],
      routes: [
        { id: 'sloppy', provider: 'fixture', model: 'sloppy-tools', priority: 0 },
        { id: 'precise', provider: 'fixture', model: 'precise-tools', priority: 1 },
      ],
    });
    const bundle = makeBundle(toolRichAgent);
    s.store.publish('owner', bundle);
    await refreshAgentModels(s.hub, 'owner', toolRichAgent.engine);

    const { revision } = evaluator.definition('owner', toolRichAgent.id);
    for (const c of evaluationCases(`${toolRichAgent.id}:${revision}:${epoch}`)) {
      expectedMap.set(c.prompt, c.expected);
    }
    // Also cover adjacent epoch boundary just in case Date.now() crosses an hour boundary.
    for (const c of evaluationCases(`${toolRichAgent.id}:${revision}:${epoch + 1}`)) {
      expectedMap.set(c.prompt, c.expected);
    }

    evaluator.records.configure(
      'owner',
      toolRichAgent.id,
      evaluationSettingsSchema.parse({ enabled: true, maxCallsPerDay: 48 }),
    );
    await evaluator.run('owner', toolRichAgent.id);

    const view = evaluator.view('owner', toolRichAgent.id);
    assert.ok(view.dimensions.includes('tool_calling'));

    const reloaded = new ModelEvaluations(s.store);
    const sloppyPerf = reloaded.performance('owner', toolRichAgent.id, revision, 'sloppy');
    const precisePerf = reloaded.performance('owner', toolRichAgent.id, revision, 'precise');
    assert.ok(sloppyPerf && precisePerf, JSON.stringify(view));
    assert.equal(sloppyPerf.dimensions.tool_calling?.score, 0);
    assert.equal(precisePerf.dimensions.tool_calling?.score, 1);

    // With >= 4 tools, `detectTaskIntent` yields `tool_heavy`, and `measuredRouteScore` prioritizes
    // the route with superior `tool_calling` accuracy despite lower static priority!
    const selected = s.kernel.router.select(
      'owner',
      bundle.digest,
      toolRichAgent,
      'auto',
      () => true,
      undefined,
      { input: 'Search production traces and update workspace summary.' },
    );
    assert.equal(selected.id, 'precise');
  } finally {
    await evaluator.close();
    await s.cleanup();
  }
});
