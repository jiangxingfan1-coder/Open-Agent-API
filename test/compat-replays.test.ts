import assert from 'node:assert/strict';
import test from 'node:test';
import { agent, FixtureModel, setup, token } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import {
  KNOWN_TOKENS,
  answerForRequirement,
  loadReplayFiles,
  outOfScope,
  replayOrigins,
  runReplayCase,
  type Transport,
} from './compat-replay.js';

// Replays what real chat clients send to a custom OpenAI-compatible endpoint (request shapes
// recorded in integrations/compat/replays/*.json with their sources) against the in-process
// gateway and checks the response against what each client's code relies on. Offline; in-process
// (app.inject), no listening socket. `npm run compat` replays the same files over a real socket.

const files = await loadReplayFiles();

test('replays: every file is well-formed and honest about its evidence', () => {
  assert.ok(files.length >= 12, `expected at least 12 clients, found ${files.length}`);
  const ids = new Set<string>();
  for (const f of files) {
    assert.ok(!ids.has(f.client), `duplicate client ${f.client}`);
    ids.add(f.client);
    assert.match(f.retrieved, /^\d{4}-\d{2}-\d{2}$/, f.client);
    assert.ok(f.sources.length > 0 || f.overall === 'unverified', `${f.client}: no sources`);
    assert.ok(f.setup.baseUrl && f.setup.model && f.setup.apiKey, `${f.client}: incomplete setup`);
    const caseIds = new Set<string>();
    for (const c of f.cases) {
      const where = `${f.client}/${c.id}`;
      assert.ok(!caseIds.has(c.id), `duplicate case ${where}`);
      caseIds.add(c.id);
      if (c.evidence.status === 'verified')
        assert.match(c.evidence.source, /^https?:\/\//, `${where}: verified without a source URL`);
      for (const t of c.consumes)
        assert.ok(KNOWN_TOKENS.includes(t), `${where}: unknown token ${t}`);
      if (c.request.method === 'POST')
        assert.ok(
          Object.keys(c.request.headers).some((h) => h.toLowerCase() === 'authorization'),
          `${where}: POST without Authorization`,
        );
    }
  }
});

for (const file of files) {
  test(`replay ${file.client}: ${file.cases.filter((c) => !outOfScope(c)).length} request shapes are accepted and answered in a form the client parses`, async () => {
    const model = new FixtureModel((_agent, messages) => ({
      text:
        answerForRequirement(messages.map((m) => m.content).join('\n')) ??
        'Hello world from fixture.',
    }));
    const s = await setup(model, { allowedOrigins: replayOrigins(files) });
    s.store.publish('owner', makeBundle(agent()));
    // An agent that runs its own tool loop (never started here): refuses caller tools clearly.
    s.store.publish('owner', makeBundle(agent({ id: 'agent/native', engine: 'codex' })));
    const transport: Transport = async (req) => {
      const r = await s.app.inject({
        method: req.method as 'GET',
        url: req.path,
        headers: req.headers,
        ...(req.body !== undefined ? { payload: req.body } : {}),
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers))
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      return { status: r.statusCode, headers, text: r.body };
    };
    try {
      const failures: string[] = [];
      for (const c of file.cases) {
        if (outOfScope(c)) continue;
        const result = await runReplayCase(c, transport, {
          AGENT: 'agent/test',
          NATIVE: 'agent/native',
          KEY: token,
        });
        if (!result.ok)
          failures.push(`${c.id} [${c.evidence.status}]: ${result.problems.join('; ')}`);
      }
      assert.deepEqual(failures, [], `${file.label}:\n${failures.join('\n')}`);
    } finally {
      await s.cleanup();
    }
  });
}
