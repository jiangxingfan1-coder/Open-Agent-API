import { z } from 'zod';
import { canonical, sha, sleep } from '../../src/core/util.js';

export const profiles = [
  'oaa-serial',
  'oaa-parallel',
  'agentscope-serial',
  'agentscope-parallel',
] as const;
export type Profile = (typeof profiles)[number];
export const shapes = ['simple', 'parallel', 'dependent'] as const;
export type Shape = (typeof shapes)[number];
export const workload = {
  format: 'oaa.paired-runtime.v1',
  base_prompt:
    'Use the supplied read-only source tool when needed. Return the requested JSON result using only confirmed source records.',
  model: 'scripted-fixture',
  model_delay_ms: 5,
  tool_delay_ms: 25,
  chunk_characters: 16,
  max_model_calls: 8,
  max_tool_calls: 8,
  max_fixture_tokens: 640,
  fixture_usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
  tool: {
    name: 'lookup',
    description: 'Read one record from the controlled benchmark corpus.',
    parameters: {
      type: 'object',
      properties: {
        source_id: { type: 'string', enum: ['a', 'b', 'c'] },
        previous_proof: { type: 'string' },
      },
      required: ['source_id'],
      additionalProperties: false,
    },
  },
  records: [
    { id: 'a', amount: 12, next: 'b' },
    { id: 'b', amount: 34, next: 'c' },
    { id: 'c', amount: 32, next: null },
  ],
  tasks: {
    simple: 'Return the JSON object {"answer":42}. No source lookup is needed.',
    parallel:
      'Read source records a, b and c independently. Return their total amount, source IDs and proof markers.',
    dependent:
      'Start with source a, follow each returned next ID, and pass the previous record proof to the next lookup. Return the total, source IDs and proof markers.',
  },
};
export const observationSchema = z.object({ id: z.string(), value: z.unknown() }).strict();
const modelRequest = z
  .object({
    input: z.string(),
    system: z.string(),
    tools: z.array(
      z.object({ name: z.string(), description: z.string(), parameters: z.unknown() }).strict(),
    ),
    observations: z.array(observationSchema),
  })
  .strict();
type ToolArgs = { source_id: string; previous_proof?: string };
type Source = { id: string; amount: number; next: string | null; proof: string };

export class FixtureOracle {
  modelCalls = 0;
  toolCalls = 0;
  activeTools = 0;
  peakTools = 0;
  rejectedCalls = 0;
  private answered = false;
  readonly systems = new Set<string>();
  readonly issued = new Map<string, ToolArgs>();
  readonly completed = new Map<string, Source>();
  readonly trace: { operation: string; time_ms: number; detail: unknown }[] = [];
  private started = performance.now();
  private used = new Set<string>();
  readonly records: Source[];
  constructor(
    readonly shape: Shape,
    seed: string,
    readonly delays = true,
  ) {
    this.records = workload.records.map((record) => ({
      ...record,
      proof: sha(`${seed}:${record.id}`).slice(0, 20),
    }));
  }
  private note(operation: string, detail: unknown) {
    this.trace.push({ operation, time_ms: performance.now() - this.started, detail });
  }
  expected() {
    return this.shape === 'simple'
      ? { answer: 42 }
      : {
          total: this.records.reduce((total, record) => total + record.amount, 0),
          sources: this.records.map((r) => r.id),
          proofs: this.records.map((r) => r.proof),
        };
  }
  async model(raw: unknown, signal?: AbortSignal) {
    this.modelCalls++;
    try {
      return await this.modelResult(raw, signal);
    } catch (error) {
      this.rejectedCalls++;
      this.note('rejected_model', String((error as Error).message).slice(0, 400));
      throw error;
    }
  }
  private async modelResult(raw: unknown, signal?: AbortSignal) {
    const request = modelRequest.parse(raw);
    if (this.modelCalls > workload.max_model_calls) throw Error('Model call budget exceeded.');
    if (request.input !== workload.tasks[this.shape]) throw Error('Task input changed.');
    if (!request.system.includes(workload.base_prompt))
      throw Error('Base instructions are missing.');
    if (canonical(request.tools) !== canonical([workload.tool]))
      throw Error('Tool schema parity failed.');
    const seen = new Set<string>();
    for (const observation of request.observations) {
      if (seen.has(observation.id)) throw Error('Duplicate tool result in model context.');
      seen.add(observation.id);
      if (
        !this.completed.has(observation.id) ||
        canonical(this.completed.get(observation.id)) !== canonical(observation.value)
      )
        throw Error('Model context contains an unconfirmed or changed tool result.');
    }
    if (seen.size !== this.completed.size || this.activeTools)
      throw Error('Model advanced before all tool results reached context.');
    this.systems.add(sha(request.system));
    this.note('model', {
      observations: [...seen],
      system_sha256: sha(request.system),
      system_bytes: Buffer.byteLength(request.system),
    });
    if (this.delays) await sleep(workload.model_delay_ms, signal);
    const wanted =
      this.shape === 'simple'
        ? []
        : this.shape === 'parallel'
          ? this.records
          : this.records.slice(0, seen.size + 1);
    const next = wanted.filter((record) => !seen.has(`call_${record.id}`));
    const calls = next.map((record) => {
      const id = `call_${record.id}`;
      if (this.issued.has(id)) throw Error('Model repeated an unfinished tool call.');
      const previous =
        this.shape === 'dependent' && record.id !== 'a'
          ? this.records[this.records.findIndex((r) => r.id === record.id) - 1]
          : undefined;
      const args = {
        source_id: record.id,
        ...(previous ? { previous_proof: previous.proof } : {}),
      };
      this.issued.set(id, args);
      return { id, name: workload.tool.name, arguments: args };
    });
    if (!calls.length) this.answered = true;
    return {
      text: calls.length ? '' : JSON.stringify(this.expected()),
      calls,
      usage: workload.fixture_usage,
      finish: calls.length ? 'tool_calls' : 'stop',
    };
  }
  async tool(raw: unknown, signal?: AbortSignal) {
    try {
      return await this.toolResult(raw, signal);
    } catch (error) {
      this.rejectedCalls++;
      this.note('rejected_tool', String((error as Error).message).slice(0, 400));
      throw error;
    }
  }
  private async toolResult(raw: unknown, signal?: AbortSignal) {
    const args = z
      .object({ source_id: z.enum(['a', 'b', 'c']), previous_proof: z.string().optional() })
      .strict()
      .parse(raw);
    const id = `call_${args.source_id}`;
    if (canonical(this.issued.get(id)) !== canonical(args) || this.used.has(id))
      throw Error('Unissued or repeated tool operation.');
    if (++this.toolCalls > workload.max_tool_calls) throw Error('Tool call budget exceeded.');
    this.used.add(id);
    this.activeTools++;
    this.peakTools = Math.max(this.peakTools, this.activeTools);
    this.note('tool_started', { id, arguments: args });
    try {
      if (this.delays) await sleep(workload.tool_delay_ms, signal);
      const result = this.records.find((record) => record.id === args.source_id)!;
      this.completed.set(id, result);
      this.note('tool_completed', { id, result });
      return result;
    } finally {
      this.activeTools--;
    }
  }
  verify(output: string, usage: unknown) {
    if (canonical(JSON.parse(output)) !== canonical(this.expected()))
      throw Error('Final output does not match the shared corpus.');
    const expectedModels = this.shape === 'simple' ? 1 : this.shape === 'parallel' ? 2 : 4;
    if (
      this.modelCalls !== expectedModels ||
      this.toolCalls !== (this.shape === 'simple' ? 0 : 3) ||
      this.activeTools ||
      this.rejectedCalls ||
      !this.answered
    )
      throw Error('Model/tool trace parity failed.');
    const expected = Object.fromEntries(
      Object.entries(workload.fixture_usage).map(([key, value]) => [key, value * expectedModels]),
    );
    if (canonical(usage) !== canonical(expected))
      throw Error('Reported fixture usage did not match actual scripted calls.');
  }
}
