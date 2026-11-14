import { ChildRpc } from './ipc.js';
import { workload, type Shape } from './workload.js';
import { setup, FixtureModel, agent, principal } from '../../test/helpers.js';
import { makeBundle } from '../../src/lang/bundle.js';
import { capabilitySchema, type RunEvent } from '../../src/core/contracts.js';
import { invocationSchema } from '../../src/gateway/protocol.js';
import { RuntimeDiagnostics } from './diagnostics.js';

const rpc = new ChildRpc();
let gateway: Awaited<ReturnType<typeof setup>> | undefined;
let active: string | undefined;
let configured = false;
let diagnostics: RuntimeDiagnostics | undefined;
async function command(frame: any) {
  if (frame.type === 'configure' && !configured) {
    configured = true;
    if (![1, 4].includes(frame.concurrency)) throw Error('Unsupported fixture concurrency.');
    const driver = new FixtureModel();
    driver.call = async (definition, messages, signal, delta) => {
      if (!active) throw Error('No active benchmark trial.');
      const answer = await rpc.call(
        active,
        'model',
        {
          input: messages.find((m) => m.role === 'user')?.content,
          system: messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n'),
          tools: definition.tools.map((t) => ({
            name: t.name,
            description: t.capability.description,
            parameters: t.capability.inputSchema,
          })),
          observations: messages
            .filter((m) => m.role === 'tool')
            .map((m) => ({ id: m.tool_call_id, value: JSON.parse(m.content) })),
        },
        signal,
      );
      for (let i = 0; i < answer.text.length; i += workload.chunk_characters)
        delta(answer.text.slice(i, i + workload.chunk_characters));
      return answer;
    };
    gateway = await setup(driver);
    if (frame.profile_oaa) {
      diagnostics = new RuntimeDiagnostics();
      diagnostics.install(gateway);
    }
    const capability = capabilitySchema.parse({
      id: 'paired/lookup',
      version: '1',
      description: workload.tool.description,
      placement: 'host-bound',
      nodeId: 'local',
      effect: 'read',
      inputSchema: workload.tool.parameters,
    });
    gateway.runtime.config.tools.push({
      reference: 'lookup',
      capability,
      handler: { kind: 'read_directory', root: gateway.dir },
    });
    gateway.runtime.handlers.set('lookup', async (args, _context, signal) => ({
      value: await rpc.call(active!, 'tool', args, signal),
    }));
    gateway.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/paired',
          instructions: workload.base_prompt,
          model: workload.model,
          allowGraph: false,
          limits: {
            maxTurns: 16,
            maxTotalTokens: workload.max_fixture_tokens,
            toolConcurrency: frame.concurrency,
          },
          tools: [
            {
              name: workload.tool.name,
              capability,
              required: true,
              handler: { kind: 'node', reference: 'lookup' },
            },
          ],
        }),
      ),
    );
    rpc.send({
      type: 'ready',
      engine: 'oaa',
      version: '0.1.0',
      durability: 'SQLite synchronous=FULL checkpoints and output journal',
      runtime: process.version,
    });
  } else if (frame.type === 'run' && gateway && !active) {
    active = frame.id;
    diagnostics?.start();
    const shape = frame.shape as Shape;
    if (!Object.hasOwn(workload.tasks, shape)) throw Error('Unknown fixture shape.');
    const run = gateway.kernel.submit(
      principal,
      invocationSchema.parse({
        agent: 'agent/paired',
        input: workload.tasks[shape],
        background: true,
      }),
    );
    const observe = (event: RunEvent) =>
      rpc.send({
        type: 'event',
        run: frame.id,
        event: event.type,
        ...(event.type === 'response.output_text.delta' ? { delta: event.data.delta } : {}),
      });
    gateway.store.events.on(run.id, observe);
    for (const event of gateway.store.history(run.id)) observe(event);
    try {
      const result = await gateway.kernel.wait(run.id);
      rpc.send({
        type: 'done',
        run: frame.id,
        status: result.status,
        error: result.error,
        output: result.output.map((m) => m.text).join(''),
        usage: result.usage,
        diagnostics: diagnostics?.stop(),
      });
    } finally {
      gateway.store.events.off(run.id, observe);
      active = undefined;
    }
  } else if (frame.type === 'shutdown') {
    await gateway?.cleanup();
    rpc.send({ type: 'bye' });
    rpc.lines.close();
    process.stdin.destroy();
  } else throw Error('Unexpected benchmark command.');
}
rpc.command = (frame) =>
  void command(frame).catch(async (error) => {
    rpc.send({ type: 'fatal', message: String(error?.message ?? error) });
    await gateway?.cleanup();
    rpc.lines.close();
    process.stdin.destroy();
    process.exitCode = 1;
  });
