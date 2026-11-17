import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoverLocalClients,
  type DiscoveryOptions,
} from '../src/config/local-client-discovery.js';
import { workerSchema } from '../src/config/config.js';
import { connectionFixture } from './local-connection-fixture.js';
import { principal } from './helpers.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'oaa-inventory-'));
  const bin = path.join(root, 'bin');
  const apps = path.join(root, 'apps');
  const extensions = path.join(root, 'extensions');
  await mkdir(bin);
  const options: DiscoveryOptions = {
    home: root,
    pathEnv: bin,
    installDirs: [],
    appRoots: [apps],
    extensionRoots: [extensions],
  };
  const file = async (name: string, text = 'metadata only', mode = 0o600) => {
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, text, { mode });
    return name;
  };
  const executable = (name: string) =>
    file(path.join(bin, name), `#!/bin/sh\ntouch '${root}/EXECUTED'\n`, 0o700);
  return {
    root,
    bin,
    apps,
    extensions,
    options,
    file,
    executable,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('local inventory discovers native and ACP executables without running them; launcher presence is not evidence', async () => {
  const f = await fixture();
  try {
    for (const name of [
      'codex',
      'codex-acp',
      'claude',
      'agy',
      'dsh',
      'qoder',
      'opencode',
      'npx',
      'node',
    ])
      await f.executable(name);
    const clients = await discoverLocalClients(undefined, f.options);
    assert.ok(clients.length >= 37);
    for (const id of ['codex', 'claude', 'antigravity', 'dsh', 'qoder', 'opencode-acp'])
      assert.equal(clients.find((c) => c.id === id)?.installed, true, id);
    assert.equal(clients.filter((c) => c.id === 'codex').length, 1);
    assert.equal(clients.find((c) => c.id === 'codex')?.evidence.length, 2);
    assert.equal(clients.find((c) => c.id === 'deepagents')?.installed, false);
    assert.equal(clients.find((c) => c.id === 'antigravity')?.connection, 'unavailable');
    assert.equal(
      clients.find((c) => c.id === 'qoder')?.connection,
      'unavailable',
      'CLI catalog does not promise arbitrary endpoints',
    );
    await assert.rejects(access(path.join(f.root, 'EXECUTED')));
  } finally {
    await f.cleanup();
  }
});

test('application-only discovery distinguishes Claude desktop from Claude Code and CLI-only Qoder', async () => {
  const f = await fixture();
  try {
    for (const app of ['Claude.app', 'Antigravity.app', 'Qoder.app'])
      await f.file(path.join(f.apps, app, 'Contents/Info.plist'));
    await mkdir(path.join(f.apps, 'Cursor.app'), { recursive: true });
    const clients = await discoverLocalClients(undefined, f.options);
    assert.equal(clients.find((c) => c.id === 'claude-desktop')?.installed, true);
    assert.equal(clients.find((c) => c.id === 'claude')?.installed, false);
    assert.equal(
      clients.find((c) => c.id === 'cursor')?.installed,
      false,
      'empty directory is not an application',
    );
    assert.equal(clients.find((c) => c.id === 'qoder')?.connection, 'manual');
    assert.equal(
      clients.find((c) => c.id === 'qoder')?.guide,
      'https://docs.qoder.com/qoder/custom-models',
    );
    assert.equal(clients.find((c) => c.id === 'antigravity')?.evidence[0]?.kind, 'application');
  } finally {
    await f.cleanup();
  }
});

test('local model runtimes are discovered without execution and are not receiver clients', async () => {
  const f = await fixture();
  try {
    for (const name of ['ollama', 'lms', 'llama-server', 'vllm', 'local-ai', 'chat'])
      await f.executable(name);
    await f.file(path.join(f.apps, 'Jan.app/Contents/Info.plist'));
    const worker = workerSchema.parse({
      nodeId: 'fixture',
      dataDir: f.root,
      providers: {
        local: {
          kind: 'openai-chat',
          preset: 'lmstudio',
          baseUrl: 'http://127.0.0.1:1234/v1',
          apiKeyEnv: 'SECRET_REF',
        },
      },
    });
    const clients = await discoverLocalClients(worker, f.options);
    for (const id of ['ollama', 'lmstudio', 'llamacpp', 'jan', 'localai', 'vllm']) {
      const client = clients.find((c) => c.id === id)!;
      assert.equal(client.installed, true, id);
      assert.equal(client.connection, 'provider');
      assert.match(client.runtime!.base_url, /^http:\/\/127\.0\.0\.1:/);
    }
    assert.deepEqual(clients.find((c) => c.id === 'lmstudio')!.runtime!.providers, ['local']);
    assert.equal(
      clients.find((c) => c.id === 'gpt4all')!.installed,
      false,
      'generic chat command is not GPT4All',
    );
    assert.equal(
      clients.find((c) => c.id === 'lmstudio')!.runtime!.connections?.[0]?.key_env,
      'SECRET_REF',
    );
    await assert.rejects(access(path.join(f.root, 'EXECUTED')));
  } finally {
    await f.cleanup();
  }
});

test('LM Studio and Windows Ollama fixed installation directories work without PATH', async () => {
  const f = await fixture();
  try {
    await f.file(path.join(f.root, '.lmstudio/bin/lms'), '#!/bin/sh\nexit 1', 0o700);
    await f.file(path.join(f.root, 'AppData/Local/Programs/Ollama/ollama.exe'), 'test', 0o700);
    const clients = await discoverLocalClients(undefined, {
      ...f.options,
      platform: 'win32',
      installDirs: undefined,
    });
    assert.equal(clients.find((c) => c.id === 'lmstudio')!.installed, true);
    assert.equal(clients.find((c) => c.id === 'ollama')!.installed, true);
  } finally {
    await f.cleanup();
  }
});

test('configured absolute native and script entries are detected even outside PATH, without leaking args', async () => {
  const f = await fixture();
  try {
    const native = await f.file(path.join(f.root, 'custom/codex'), '#!/bin/sh\nexit 1', 0o700);
    const node = await f.executable('node');
    const entry = await f.file(path.join(f.root, 'package/entry.mjs'));
    const npx = await f.executable('npx');
    const worker = workerSchema.parse({
      nodeId: 'fixture',
      dataDir: f.root,
      native: { codex: { executable: native, enabled: false } },
      adapters: {
        qoder: {
          transport: 'acp',
          command: node,
          args: [entry, '--token', 'never-return-this'],
          preset: 'qoder',
        },
        deepagents: {
          transport: 'acp',
          command: npx,
          args: ['-y', 'deepagents-acp'],
          preset: 'deepagents',
        },
        custom: { transport: 'stdio', command: node, args: [entry] },
        absent: { transport: 'acp', command: node, args: [path.join(f.root, 'missing.mjs')] },
      },
    });
    const clients = await discoverLocalClients(worker, f.options);
    assert.deepEqual(clients.find((c) => c.id === 'codex')?.engines, ['codex']);
    assert.deepEqual(clients.find((c) => c.id === 'qoder')?.engines, ['adapter/qoder']);
    assert.equal(clients.find((c) => c.id === 'custom')?.installed, true);
    assert.equal(clients.find((c) => c.id === 'absent')?.installed, false);
    assert.equal(clients.find((c) => c.id === 'deepagents')?.installed, false);
    assert.doesNotMatch(JSON.stringify(clients), /never-return-this|--token/);
  } finally {
    await f.cleanup();
  }
});

test('known extension manifests count, while leftover settings and unrelated extensions do not', async () => {
  const f = await fixture();
  try {
    await f.file(path.join(f.extensions, 'saoudrizwan.claude-dev-3.0.0/package.json'));
    await f.file(path.join(f.extensions, 'unrelated.claude-dev-3.0.0/package.json'));
    await mkdir(path.join(f.extensions, 'rooveterinaryinc.roo-cline-1.0.0'), { recursive: true });
    await f.file(path.join(f.root, '.codex/config.toml'));
    await f.file(path.join(f.root, '.qoder/settings.json'));
    const clients = await discoverLocalClients(undefined, f.options);
    assert.equal(clients.find((c) => c.id === 'cline')?.evidence[0]?.kind, 'extension');
    for (const id of ['codex', 'qoder', 'roo-code'])
      assert.equal(clients.find((c) => c.id === id)?.installed, false, id);
  } finally {
    await f.cleanup();
  }
});

test(
  'ambiguous agent executable needs the Cursor package marker, and relative PATH directories are ignored',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      await f.executable('agent');
      let clients = await discoverLocalClients(undefined, f.options);
      assert.equal(clients.find((c) => c.id === 'cursor')?.installed, false);
      const cursor = await f.file(
        path.join(f.root, 'cursor/bin/agent'),
        '#!/bin/sh\nexit 1',
        0o700,
      );
      await symlink(cursor, path.join(f.bin, 'cursor-agent'));
      clients = await discoverLocalClients(undefined, {
        ...f.options,
        pathEnv: `.:relative:${f.bin}`,
      });
      assert.equal(clients.find((c) => c.id === 'cursor')?.installed, true);
      assert.equal(clients.find((c) => c.id === 'cursor')?.evidence.length, 1);
    } finally {
      await f.cleanup();
    }
  },
);

test('connection inventory is additive, owner-local, and rejects arbitrary filesystem query options', async () => {
  const f = await connectionFixture();
  try {
    const before = f.auth.list(principal);
    const response = await f.request('GET', '/v1/local/connections?refresh=1');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().target.id, 'dsh');
    assert.ok(response.json().clients.some((c: { id: string }) => c.id === 'codex'));
    assert.equal((await f.request('GET', '/v1/local/connections?home=/private')).statusCode, 400);
    assert.equal(f.driver.calls, 0);
    assert.equal(f.auth.list(principal).length, before.length);
  } finally {
    await f.cleanup();
  }
});
