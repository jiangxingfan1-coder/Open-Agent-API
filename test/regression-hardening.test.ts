import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { compileOaaLang, formatOaaLang } from '../src/lang/lang.js';
import { connectionFixture } from './local-connection-fixture.js';
import { setup, agent, FixtureModel, principal } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';

test(
  'a named pipe in a client config path is rejected without blocking',
  { skip: process.platform === 'win32' },
  async () => {
    const s = await connectionFixture();
    try {
      const file = path.join(s.dsh.home, 'settings.yaml');
      await unlink(file);
      await promisify(execFile)('mkfifo', [file]);
      const module = new URL('../src/config/local-client-files.js', import.meta.url).href;
      const script = `import {readClientFile} from ${JSON.stringify(module)};try{await readClientFile(${JSON.stringify(file)});process.exitCode=1}catch(e){if(e.code!=='local_connection_invalid')throw e}`;
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        timeout: 2000,
      });
    } finally {
      await s.cleanup();
    }
  },
);

test('type aliases retain defaults and item defaults do not make arrays optional', () => {
  const source =
    'type Flag = bool(default=true)\nagent "agent/test" { model="fixture" output_schema { flag: Flag flags: Flag[] direct: bool(default=true)[] } }';
  const compiled = compileOaaLang(source);
  assert.deepEqual(compiled.agent.outputSchema?.required, ['flags', 'direct']);
  assert.deepEqual(compileOaaLang(formatOaaLang(source)).agent, compiled.agent);
});

test('nested suffixes and expanding aliases fail within compiler budgets', () => {
  assert.throws(
    () =>
      compileOaaLang(
        `agent "agent/test" { model="fixture" output_schema { a: bool${'[]'.repeat(100)} } }`,
      ),
    /compiler limit/,
  );
  const aliases = ['type T0 = string'];
  for (let i = 1; i < 24; i++) aliases.push(`type T${i} = { left: T${i - 1} right: T${i - 1} }`);
  assert.throws(
    () =>
      compileOaaLang(
        `${aliases.join('\n')}\nagent "agent/test" { model="fixture" output_schema { a: T23 } }`,
      ),
    /compiler.*limit/,
  );
});

test('disconnect preserves annotations on the otherwise empty provider container', async () => {
  const s = await connectionFixture();
  try {
    const row = (await s.configure()).result.json();
    const file = path.join(s.dsh.home, 'settings.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(
      file,
      text.replace('  providers:', '  # User note on the provider container\n  providers:'),
    );
    const result = await s.request('DELETE', `/v1/local/connections/${row.id}`);
    assert.equal(result.json().configuration_removed, true, result.body);
    const remaining = await readFile(file, 'utf8');
    assert.match(remaining, /User note on the provider container/);
    assert.doesNotMatch(remaining, new RegExp(row.provider));
  } finally {
    await s.cleanup();
  }
});

test('an orchestration stage named constructor is executed and persisted as an own result', async () => {
  const s = await setup(
    new FixtureModel((a, messages) => {
      const input = messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      if (input.startsWith('Plan this task;'))
        return {
          text: JSON.stringify({
            stages: [
              {
                id: 'constructor',
                role: 'execute',
                agent: a.id,
                model: 'two',
                task: 'Produce evidence.',
              },
            ],
          }),
        };
      return { text: 'Actual execution evidence.' };
    }),
  );
  try {
    const a = agent({
      orchestration: { enabled: true },
      routes: [
        { id: 'one', provider: 'fixture', model: 'one', priority: 0 },
        { id: 'two', provider: 'fixture', model: 'two', priority: 1 },
      ],
    });
    s.store.publish('owner', makeBundle(a));
    const submitted = s.kernel.submit(principal, {
      protocol: 'oaa/1',
      agent: a.id,
      model: 'auto',
      input: 'Produce a reviewed implementation with concrete evidence.'.repeat(5),
      file_ids: [],
      metadata: { 'oaa.routing_strategy': 'quality' },
      stream: false,
      background: false,
    });
    const result = await s.kernel.wait(submitted.id);
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.equal(s.driver.calls, 2);
    assert.equal(result.output.map((m) => m.text).join(''), 'Actual execution evidence.');
    assert.equal(Object.hasOwn(result.checkpoint.orchestration!.results, 'constructor'), true);
  } finally {
    await s.cleanup();
  }
});
