import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  agentSchema,
  type AgentDefinition,
  type ModelMessage,
  type ModelResult,
  type ToolBinding,
} from '../src/core/contracts.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import type { ModelDriver, NativeTurnControls } from '../src/providers/models.js';
import { openAIChatControls } from '../src/providers/structured-wire.js';
import { createGateway } from '../src/gateway/server.js';
import { makeBundle, builtin } from '../src/lang/bundle.js';
import { sleep, sha } from '../src/core/util.js';

export const token = 'test-owner-key-not-a-provider-credential-0000001';
export const secondToken = 'test-second-owner-key-not-a-provider-key-000001';
export const principal = {
  name: 'test',
  owner: 'owner',
  agents: ['*'],
  scopes: ['admin', 'invoke', 'read', 'files', 'approve'],
};
export class FixtureModel implements ModelDriver {
  calls = 0;
  lastControls?: NativeTurnControls;
  seenControls: (NativeTurnControls | undefined)[] = [];
  seenWire: Record<string, unknown>[] = [];
  constructor(
    readonly respond: (
      agent: AgentDefinition,
      messages: ModelMessage[],
      signal: AbortSignal,
      controls?: NativeTurnControls,
    ) => Promise<Partial<ModelResult>> | Partial<ModelResult> = () => ({
      text: 'Fixture response.',
    }),
  ) {}
  async call(
    agent: AgentDefinition,
    messages: ModelMessage[],
    signal: AbortSignal,
    delta: (s: string) => void,
    controls?: NativeTurnControls,
  ): Promise<ModelResult> {
    this.calls++;
    this.lastControls = controls;
    this.seenControls.push(controls);
    this.seenWire.push(openAIChatControls(controls, agent.tools.length > 0));
    const answer = await this.respond(agent, messages, signal, controls);
    const text = answer.text ?? '';
    for (const part of text.match(/.{1,8}/gs) ?? []) delta(part);
    return {
      text,
      calls: answer.calls ?? [],
      usage:
        answer.usage === undefined
          ? { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          : answer.usage,
      finish: answer.finish ?? (answer.calls?.length ? 'tool_calls' : 'stop'),
    };
  }
}
export function researchFixture(): FixtureModel {
  return new FixtureModel((_agent, messages) => {
    const turns = messages.filter((m) => m.role === 'assistant').length;
    if (turns === 0)
      return {
        calls: [
          { id: 'list', name: 'list_files', arguments: {} },
          { id: 'skill', name: 'read_skill', arguments: { path: 'skills/research/SKILL.md' } },
        ],
      };
    if (turns === 1) {
      const content = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'list')!.content;
      const files = (JSON.parse(content) as { files: string[] }).files;
      return {
        calls: [
          {
            id: 'sources',
            name: 'execute_graph',
            arguments: {
              steps: files.map((f, i) => ({
                id: `s${i}`,
                tool: 'read_file',
                arguments: { path: f },
              })),
            },
          },
        ],
      };
    }
    if (turns === 2) {
      const data = JSON.parse(
        messages.find((m) => m.role === 'tool' && m.tool_call_id === 'sources')!.content,
      ) as Record<string, { text: string }>;
      const report =
        '# Source report\n\n' +
        Object.entries(data)
          .map(([key, v]) => `## ${key}\n${v.text}\n`)
          .join('\n');
      return {
        calls: [
          { id: 'report', name: 'write_file', arguments: { path: 'report.md', content: report } },
        ],
      };
    }
    return {
      text: 'Report generated from the supplied sources. [Local deterministic fixture; no live model was called.]',
    };
  });
}
export function agent(overrides: Record<string, unknown> = {}): AgentDefinition {
  return agentSchema.parse({
    id: 'agent/test',
    description: 'Test agent',
    instructions: 'Use the registered tools.',
    model: 'fixture',
    provider: 'fixture',
    ...overrides,
  });
}
export function researchBundle() {
  const source =
    '---\nname: research\ndescription: Ground reports in source files.\n---\nRead supplied files and cite their identifiers.\n';
  return makeBundle(
    agent({
      id: 'agent/research',
      tools: ['list_files', 'read_file', 'read_skill', 'write_file'].map((n) =>
        builtin(n as Parameters<typeof builtin>[0]),
      ),
      skills: [
        { name: 'research', description: 'Use source files.', path: 'skills/research/SKILL.md' },
      ],
    }),
    [
      {
        path: 'skills/research/SKILL.md',
        content: Buffer.from(source).toString('base64'),
        sha256: sha(source),
      },
    ],
  );
}
export async function setup(
  driver = new FixtureModel(),
  extra: Record<string, unknown> = {},
  options: Parameters<typeof createGateway>[2] = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-test-'));
  const workerConfig = workerSchema.parse({ nodeId: 'local', dataDir: path.join(dir, 'worker') });
  const runtime = new WorkerRuntime(workerConfig, new Map(), new Map([['fixture', driver]]));
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    keys: [
      { name: 'test', owner: 'owner', tokenEnv: 'OAA_TEST_TOKEN', scopes: principal.scopes },
      { name: 'second', owner: 'second', tokenEnv: 'OAA_SECOND_TOKEN', scopes: principal.scopes },
    ],
    localWorker: workerConfig,
    approvalTimeoutMs: 1000,
    ...extra,
  });
  process.env.OAA_TEST_TOKEN = token;
  process.env.OAA_SECOND_TOKEN = secondToken;
  const gateway = await createGateway(config, runtime, options);
  await gateway.app.ready();
  const request = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    customToken = token,
    headers: Record<string, string> = {},
  ) =>
    gateway.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${customToken}`, ...headers },
    });
  return {
    ...gateway,
    config,
    dir,
    runtime,
    driver,
    request,
    cleanup: async () => {
      await gateway.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function waitFor(test: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(10);
  }
  throw new Error('Condition did not become true before the deadline.');
}
