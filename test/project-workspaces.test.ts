import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectWorkspaces } from '../src/fabric/project-workspaces.js';
import { makeBundle } from '../src/lang/bundle.js';
import { agent, principal, setup, waitFor } from './helpers.js';

test('project bindings persist by owner and same-directory native work is serialized even after a cancelled waiter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-projects-'));
  try {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const bindings = new ProjectWorkspaces(path.join(dir, 'data'), 'owner');
    await bindings.bind('agent/a', project, () => true);
    await bindings.bind('agent/b', project, () => true);
    const first = await bindings.acquire('agent/a', dir, true, new AbortController().signal);
    await assert.rejects(
      bindings.bind('agent/a', null, () => true),
      { code: 'concurrency_limit' },
    );
    const cancelled = new AbortController();
    const second = bindings.acquire('agent/b', dir, true, cancelled.signal);
    const rejection = assert.rejects(second, { code: 'cancelled' });
    cancelled.abort();
    await rejection;
    let acquired = false;
    const third = bindings
      .acquire('agent/b', dir, true, new AbortController().signal)
      .then((lease) => {
        acquired = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(acquired, false);
    first.release();
    const lease = await third;
    lease.release();
    const restored = new ProjectWorkspaces(path.join(dir, 'data'), 'owner');
    assert.equal((await restored.list()).length, 2);
    await assert.rejects(new ProjectWorkspaces(path.join(dir, 'data'), 'other-owner').list(), {
      code: 'invalid_request',
    });
    assert.equal(
      JSON.parse(await readFile(path.join(dir, 'data', 'project-bindings.json'), 'utf8')).owner,
      'owner',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('only the owner binds projects, native cwd is explicit, and queued work prevents retargeting', async () => {
  const s = await setup();
  try {
    const project = path.join(s.dir, 'project');
    await mkdir(project);
    const entry = {
      transport: 'stdio' as const,
      enabled: true,
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.once("data",()=>setTimeout(()=>process.stdout.write(JSON.stringify({protocol:"oaa/1",type:"result",status:"completed",output_text:process.cwd()})),150))',
      ],
    };
    s.runtime.config.adapters.project = entry;
    s.config.localWorker!.adapters.project = entry;
    const deniedKey = s.auth.create(principal, 'reader', ['agent/project'], ['read']);
    const denied = await s.request(
      'POST',
      '/v1/local/projects',
      { agent: 'agent/project', path: project },
      String(deniedKey.token),
    );
    assert.equal(denied.statusCode, 403);
    const bound = await s.request('POST', '/v1/local/projects', {
      agent: 'agent/project',
      path: project,
    });
    assert.equal(bound.statusCode, 200, bound.body);
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/project',
          engine: 'adapter/project',
          model: 'default',
          access: {
            modes: ['managed'],
            defaultMode: 'managed',
            approval: 'native',
            trust: 'private',
            workspace: 'project',
          },
        }),
      ),
    );
    const pending = s.request('POST', '/v1/responses', {
      model: 'agent/project',
      input: 'Fixture only',
    });
    await waitFor(() => s.store.activeCount('owner') > 0);
    const busy = await s.request('POST', '/v1/local/projects', {
      agent: 'agent/project',
      path: null,
    });
    assert.equal(busy.statusCode, 429, busy.body);
    const result = await pending;
    assert.equal(result.statusCode, 200, result.body);
    assert.match(JSON.stringify(result.json().output), /project/);
    assert.equal(s.store.run(result.json().id).output[0]?.text, await realpath(project));
    const listing = await s.request('GET', '/v1/agents');
    assert.equal(
      JSON.stringify(listing.json()).includes(project),
      false,
      'Project paths must stay out of caller catalogs',
    );
  } finally {
    await s.cleanup();
  }
});
