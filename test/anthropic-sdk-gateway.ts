// 官方 `@anthropic-ai/sdk` 的进程内网关：SDK 经自定义 fetch 接到 app.inject，不监听端口。
// 供 test/compat-anthropic-sdk*.test.ts 共用。
import Anthropic from '@anthropic-ai/sdk';
import { setup, agent, FixtureModel, token } from './helpers.js';
import { builtin, makeBundle } from '../src/lang/bundle.js';
import type { AgentDefinition } from '../src/core/contracts.js';

export type Mode = 'ok' | 'len' | 'fail' | 'tools' | 'parallel' | 'approval';

export async function gateway() {
  const state = { mode: 'ok' as Mode, seen: [] as AgentDefinition[], inputs: [] as string[] };
  const model = new FixtureModel((a, messages) => {
    state.seen.push(a);
    state.inputs.push(messages.map((m) => m.content).join('\n'));
    if (state.mode === 'fail') throw new Error('boom');
    if (state.mode === 'len') return { text: 'partial text', finish: 'length' };
    if (state.mode === 'approval')
      return messages.some((m) => m.role === 'tool')
        ? { text: 'done' }
        : { calls: [{ id: 'w', name: 'write_file', arguments: { path: 'a', content: 'b' } }] };
    if (state.mode === 'tools' || state.mode === 'parallel') {
      const results = messages.filter((m) => m.role === 'tool');
      if (!results.length)
        return {
          text: 'Editing.',
          calls:
            state.mode === 'tools'
              ? [{ id: 'm1', name: 'edit_file', arguments: { path: 'a.ts', line: 3 } }]
              : [
                  { id: 'm1', name: 'edit_file', arguments: { path: 'a.ts' } },
                  { id: 'm2', name: 'edit_file', arguments: { path: 'b.ts' } },
                ],
        };
      return { text: `Done ${results.map((r) => r.content).join(',')}` };
    }
    return { text: 'Hello world from fixture.' };
  });
  const s = await setup(model);
  s.store.publish('owner', makeBundle(agent()));
  s.store.publish(
    'owner',
    makeBundle(agent({ id: 'agent/bridge', tools: [builtin('list_files')] })),
  );
  const write = builtin('write_file');
  write.capability.requiresApproval = true;
  s.store.publish('owner', makeBundle(agent({ id: 'agent/approve', tools: [write] })));
  let requests = 0;
  const seenHeaders: Record<string, string>[] = [];
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    requests++;
    const u = new URL(String(url));
    const headers = Object.fromEntries(new Headers(init.headers));
    seenHeaders.push(headers);
    const r = await s.app.inject({
      method: init.method as 'GET',
      url: u.pathname + u.search,
      payload: init.body as string,
      headers,
    });
    return new Response(new Uint8Array(r.rawPayload), {
      status: r.statusCode,
      headers: r.headers as Record<string, string>,
    });
  };
  const client = (opts: Partial<ConstructorParameters<typeof Anthropic>[0]> = {}) =>
    new Anthropic({ apiKey: token, baseURL: 'http://x', fetch, maxRetries: 2, ...opts });
  return { s, state, client, requests: () => requests, seenHeaders };
}
export const runCount = (s: Awaited<ReturnType<typeof setup>>) =>
  s.store.summaries('owner', ['*'], 200).length;
export const user = (text: string) => [{ role: 'user' as const, content: text }];
