import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dshFixture } from './local-connection-fixture.js';
import { agent, FixtureModel, principal, setup } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { sha } from '../src/core/util.js';
import { DshClient } from '../src/config/dsh-client.js';
import { Auth } from '../src/gateway/auth.js';
import { LocalConnections } from '../src/gateway/local-connections.js';
import {
  LocalConnectionState,
  type ManagedTargetRecord,
} from '../src/gateway/local-connection-state.js';
import { resolveCliJsPath } from '../src/gateway/local-mcp-targets.js';

async function multiFixture(driver = new FixtureModel()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-multi-conn-'));
  const dsh = await dshFixture();
  const paths = {
    opencodeConfig: path.join(root, 'opencode', 'opencode.json'),
    codexHome: path.join(root, 'codex'),
    mcpConfigs: {
      'claude-desktop': path.join(root, 'claude-desktop', 'claude_desktop_config.json'),
      cursor: path.join(root, 'cursor', 'mcp.json'),
      windsurf: path.join(root, 'windsurf', 'mcp_config.json'),
      'claude-code': path.join(root, 'claude-code', '.claude.json'),
    },
  };
  const s = await setup(
    driver,
    {
      localWorker: {
        nodeId: 'local',
        dataDir: path.join(root, 'worker'),
        native: {
          codex: { executable: 'codex', enabled: true },
          claude: { executable: 'claude', enabled: true },
        },
        adapters: {
          'opencode-acp': {
            transport: 'acp',
            command: 'opencode',
            args: ['acp'],
            preset: 'opencode-acp',
          },
        },
      },
    },
    { dshHome: dsh.home, localTargets: paths },
  );
  await s.listen();
  s.store.publish('owner', makeBundle(agent({ modelPolicy: { mode: 'declared' } })));
  return {
    ...s,
    root,
    dsh,
    paths,
    cleanup: async () => {
      await s.cleanup();
      await dsh.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('OpenCode API target previews idempotently, merges without overwriting unrelated providers, scopes key and disconnects cleanly', async () => {
  const s = await multiFixture();
  try {
    await mkdir(path.dirname(s.paths.opencodeConfig), { recursive: true });
    const initialConfig = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4',
      provider: {
        anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}' } },
      },
    };
    await writeFile(s.paths.opencodeConfig, JSON.stringify(initialConfig, null, 2) + '\n', {
      mode: 0o600,
    });

    const beforeKeys = s.auth.list(principal).length;
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      target: 'opencode',
      channel: 'api',
      agent: 'agent/test',
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().target, 'opencode');
    assert.equal(preview.json().channel, 'api');
    assert.equal(preview.json().action, 'connect');
    assert.match(preview.json().summary, /@ai-sdk\/openai-compatible/);
    assert.match(preview.json().summary, /\{file:/);
    assert.equal(s.auth.list(principal).length, beforeKeys);

    // Concurrent/repeated apply is idempotent and mints exactly one minimal-scope key.
    const [first, second] = await Promise.all([
      s.request('POST', '/v1/local/connections/apply', {
        plan_id: preview.json().plan_id,
        target: 'opencode',
        channel: 'api',
      }),
      s.request('POST', '/v1/local/connections/apply', {
        plan_id: preview.json().plan_id,
      }),
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    const applied = first.json();
    assert.equal(applied.key_id, second.json().key_id);
    assert.equal(s.auth.list(principal).length, beforeKeys + 1);

    const keyMeta = s.auth.list(principal).find((k) => k.id === applied.key_id)!;
    assert.deepEqual(keyMeta.scopes, ['read', 'invoke', 'files']);
    assert.deepEqual(keyMeta.agents, ['agent/test']);
    assert.equal(keyMeta.scopes.includes('admin'), false);
    assert.equal(keyMeta.scopes.includes('approve'), false);

    const keyFile = applied.key_file as string;
    const rawToken = (await readFile(keyFile, 'utf8')).trim();
    assert.ok(rawToken.length > 20);
    if (process.platform !== 'win32') {
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    }

    const writtenRaw = await readFile(s.paths.opencodeConfig, 'utf8');
    // Zero plaintext token leakage in client config, API responses, or state record!
    assert.doesNotMatch(writtenRaw, new RegExp(rawToken));
    assert.doesNotMatch(preview.body + first.body, new RegExp(rawToken));
    const stateRecordRaw = await readFile(
      path.join(s.config.dataDir, 'local-connections', 'targets', `${applied.id}.json`),
      'utf8',
    );
    assert.doesNotMatch(stateRecordRaw, new RegExp(rawToken));

    const written = JSON.parse(writtenRaw);
    assert.equal(written.$schema, initialConfig.$schema);
    assert.equal(written.model, initialConfig.model);
    assert.deepEqual(written.provider.anthropic, initialConfig.provider.anthropic);
    const oaaEntry = written.provider['open-agent-api'];
    assert.equal(oaaEntry.npm, '@ai-sdk/openai-compatible');
    assert.equal(oaaEntry.options.apiKey, `{file:${keyFile}}`);
    assert.ok(oaaEntry.models['agent/test']);

    // Verify dedicated key enforces agent & scope boundaries.
    const invokeOk = await s.request(
      'POST',
      '/v1/chat/completions',
      { model: 'agent/test', messages: [{ role: 'user', content: 'hello' }] },
      rawToken,
    );
    assert.equal(invokeOk.statusCode, 200, invokeOk.body);
    assert.equal((await s.request('GET', '/v1/keys', undefined, rawToken)).statusCode, 403);
    s.store.publish('owner', makeBundle(agent({ id: 'agent/other' })));
    assert.equal(
      (
        await s.request(
          'POST',
          '/v1/chat/completions',
          { model: 'agent/other', messages: [{ role: 'user', content: 'denied' }] },
          rawToken,
        )
      ).statusCode,
      403,
    );

    // Health check without invoking generation.
    const callsBeforeCheck = s.driver.calls;
    const checked = await s.request('POST', `/v1/local/connections/${applied.id}/check`, {
      target: 'opencode',
      channel: 'api',
    });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().ok, true);
    assert.equal(s.driver.calls, callsBeforeCheck);

    // Sync after publishing a new route reuses the same key.
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          modelPolicy: { mode: 'declared' },
          routes: [{ id: 'pro', provider: 'fixture', model: 'pro-v2', priority: 1 }],
        }),
      ),
    );
    const syncPreview = await s.request('POST', '/v1/local/connections/preview', {
      target: 'opencode',
      agent: 'agent/test',
      model: 'pro',
    });
    assert.equal(syncPreview.json().action, 'sync');
    const synced = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: syncPreview.json().plan_id,
    });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().key_id, applied.key_id);
    assert.ok(
      JSON.parse(await readFile(s.paths.opencodeConfig, 'utf8')).provider['open-agent-api'].models[
        'agent/test@pro'
      ],
    );

    // Clean disconnect removes only open-agent-api, revokes key, and deletes private key file.
    const removed = await s.request(
      'DELETE',
      `/v1/local/connections/${applied.id}?target=opencode&channel=api`,
    );
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().key_revoked, true);
    assert.equal(removed.json().configuration_removed, true);
    assert.equal((await s.request('GET', '/v1/models', undefined, rawToken)).statusCode, 401);
    await assert.rejects(access(keyFile));
    assert.deepEqual(JSON.parse(await readFile(s.paths.opencodeConfig, 'utf8')), initialConfig);
  } finally {
    await s.cleanup();
  }
});

test('Codex TOML target appends managed section, protects external edits, and refuses complex conflicting syntax', async () => {
  const s = await multiFixture();
  try {
    const codexFile = path.join(s.paths.codexHome, 'config.toml');
    await mkdir(s.paths.codexHome, { recursive: true });
    const existingToml = [
      '# Preserve top-level Codex settings and multiline prompt',
      'model = "gpt-5-codex"',
      'instructions = """',
      '[not_a_table_inside_multiline_string]',
      'Keep exact bytes',
      '"""',
      '',
      '[model_providers.custom]',
      'name = "Custom Upstream"',
      'base_url = "https://api.example.com/v1"',
      'env_key = "CUSTOM_KEY"',
      '',
    ].join('\n');
    await writeFile(codexFile, existingToml, { mode: 0o600 });

    const preview = await s.request('POST', '/v1/local/connections/preview', {
      target: 'codex',
      channel: 'api',
      agent: 'agent/test',
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().env_key, 'OAA_CODEX_API_KEY');
    const applied = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    assert.equal(applied.statusCode, 200, applied.body);

    const token = (await readFile(applied.json().key_file, 'utf8')).trim();
    const afterInstall = await readFile(codexFile, 'utf8');
    assert.ok(afterInstall.startsWith(existingToml.trimEnd()));
    assert.match(afterInstall, /\[model_providers\.oaa\]/);
    assert.match(afterInstall, /name = "Open Agent API"/);
    assert.match(afterInstall, /env_key = "OAA_CODEX_API_KEY"/);
    assert.doesNotMatch(afterInstall, new RegExp(token));

    const checkOk = await s.request('POST', `/v1/local/connections/${applied.json().id}/check`);
    assert.equal(checkOk.json().ok, true);

    // Simulate user manually editing [model_providers.oaa] -> conflict protection!
    const userEdited = afterInstall.replace('name = "Open Agent API"', 'name = "User Edited OAA"');
    await writeFile(codexFile, userEdited);
    const listed = await s.request('GET', '/v1/local/connections');
    assert.equal(
      listed.json().data.find((d: { id: string }) => d.id === applied.json().id)?.status,
      'conflict',
    );
    const conflictPreview = await s.request('POST', '/v1/local/connections/preview', {
      target: 'codex',
      agent: 'agent/test',
    });
    assert.equal(conflictPreview.statusCode, 409);

    // Disconnect revokes key & deletes key file, but preserves user-edited TOML!
    const removed = await s.request('DELETE', `/v1/local/connections/${applied.json().id}`);
    assert.equal(removed.json().key_revoked, true);
    assert.equal(removed.json().configuration_removed, false);
    assert.equal(removed.json().status, 'conflict');
    assert.equal(await readFile(codexFile, 'utf8'), userEdited);
    await assert.rejects(access(applied.json().key_file));

    // Complex conflicting TOML syntax is refused without overwriting.
    for (const complex of [
      'model_providers = { oaa = { name = "inline" } }\n',
      '[model_providers.oaa.http_headers]\nX-Test = "1"\n',
      '[model_providers]\noaa.name = "dotted"\n',
      'broken = "unclosed string\n',
    ]) {
      await writeFile(codexFile, complex);
      const res = await s.request('POST', '/v1/local/connections/preview', {
        target: 'codex',
        agent: 'agent/test',
      });
      assert.equal(res.statusCode, 400, complex);
      assert.equal(await readFile(codexFile, 'utf8'), complex);
    }
  } finally {
    await s.cleanup();
  }
});

test('MCP bridge one-click injection works across claude-desktop, cursor, windsurf, and claude-code without exposing raw tokens', async () => {
  const s = await multiFixture();
  try {
    // Seed Cursor with an existing MCP server; leave Windsurf missing to test clean file removal on disconnect.
    await mkdir(path.dirname(s.paths.mcpConfigs.cursor), { recursive: true });
    const existingCursor = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    };
    await writeFile(s.paths.mcpConfigs.cursor, JSON.stringify(existingCursor, null, 2) + '\n');

    for (const target of ['claude-desktop', 'cursor', 'windsurf', 'claude-code'] as const) {
      const agentArg = target === 'claude-code' ? 'agent/test' : undefined;
      const preview = await s.request('POST', '/v1/local/connections/preview', {
        target,
        channel: 'mcp',
        ...(agentArg ? { agent: agentArg } : {}),
      });
      assert.equal(preview.statusCode, 200, `${target}: ${preview.body}`);
      assert.equal(preview.json().channel, 'mcp');
      assert.equal(preview.json().agent, agentArg ?? '*');

      const applied = await s.request('POST', '/v1/local/connections/apply', {
        plan_id: preview.json().plan_id,
      });
      assert.equal(applied.statusCode, 200, `${target}: ${applied.body}`);

      const row = applied.json();
      const keyEntry = s.auth.list(principal).find((k) => k.id === row.key_id)!;
      assert.deepEqual(keyEntry.scopes, ['read', 'invoke', 'files']);
      assert.equal(keyEntry.scopes.includes('approve'), false);
      assert.equal(keyEntry.scopes.includes('admin'), false);
      assert.deepEqual(keyEntry.agents, [agentArg ?? '*']);

      const rawToken = (await readFile(row.key_file, 'utf8')).trim();
      if (process.platform !== 'win32') {
        assert.equal((await stat(row.key_file)).mode & 0o777, 0o600);
      }

      const configPath = s.paths.mcpConfigs[target];
      const fileText = await readFile(configPath, 'utf8');
      assert.doesNotMatch(fileText, new RegExp(rawToken), `${target} leaked plaintext token`);
      const parsed = JSON.parse(fileText);
      const injected = parsed.mcpServers['open-agent-api'];
      assert.equal(injected.command, process.execPath);
      assert.deepEqual(injected.args, [
        resolveCliJsPath(),
        'mcp',
        '--url',
        row.base_url,
        '--token-file',
        row.key_file,
      ]);
      if (target === 'cursor') {
        assert.deepEqual(parsed.mcpServers.filesystem, existingCursor.mcpServers.filesystem);
      }

      const checked = await s.request('POST', `/v1/local/connections/${row.id}/check`);
      assert.equal(checked.statusCode, 200, checked.body);
      assert.equal(checked.json().ok, true);

      const removed = await s.request('DELETE', `/v1/local/connections/${row.id}`);
      assert.equal(removed.json().configuration_removed, true);
      assert.equal(removed.json().key_revoked, true);
      await assert.rejects(access(row.key_file));

      if (target === 'cursor') {
        assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), existingCursor);
      } else {
        // Newly created MCP config files with no other entries disappear cleanly on rollback/disconnect.
        await assert.rejects(access(configPath));
      }
    }
  } finally {
    await s.cleanup();
  }
});

test('anti-self-loop protection refuses wiring opencode, codex, or claude back into themselves directly or via delegates', async () => {
  const s = await multiFixture();
  try {
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/opencode', engine: 'adapter/opencode-acp', model: 'default' })),
    );
    s.store.publish(
      'owner',
      makeBundle(
        agent({
          id: 'agent/via-opencode',
          delegates: [{ name: 'sub', agent: 'agent/opencode' }],
        }),
      ),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/codex', engine: 'codex', model: 'default' })),
    );
    s.store.publish(
      'owner',
      makeBundle(agent({ id: 'agent/claude', engine: 'claude', model: 'default' })),
    );

    for (const id of ['agent/opencode', 'agent/via-opencode']) {
      const blocked = await s.request('POST', '/v1/local/connections/preview', {
        target: 'opencode',
        agent: id,
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.equal(blocked.json().error.code, 'local_connection_unavailable');
    }

    const codexLoop = await s.request('POST', '/v1/local/connections/preview', {
      target: 'codex',
      agent: 'agent/codex',
    });
    assert.equal(codexLoop.statusCode, 409, codexLoop.body);

    for (const claudeTarget of ['claude-code', 'claude-desktop'] as const) {
      const claudeLoop = await s.request('POST', '/v1/local/connections/preview', {
        target: claudeTarget,
        agent: 'agent/claude',
      });
      assert.equal(claudeLoop.statusCode, 409, claudeLoop.body);
    }

    // Channel mismatch validation.
    assert.equal(
      (
        await s.request('POST', '/v1/local/connections/preview', {
          target: 'opencode',
          channel: 'mcp',
          agent: 'agent/test',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await s.request('POST', '/v1/local/connections/preview', {
          target: 'cursor',
          channel: 'api',
          agent: 'agent/test',
        })
      ).statusCode,
      400,
    );
  } finally {
    await s.cleanup();
  }
});

test('journal recovery reconciles committed and interrupted multi-target installations and revokes orphan keys', async () => {
  const s = await multiFixture();
  try {
    // 1. Committed Cursor MCP installation stuck in `installing` phase -> finalized to `active`.
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      target: 'cursor',
      channel: 'mcp',
    });
    const applied = (
      await s.request('POST', '/v1/local/connections/apply', { plan_id: preview.json().plan_id })
    ).json();

    const state = new LocalConnectionState(s.config.dataDir);
    const committedRow = (await state.listManaged()).find((r) => r.id === applied.id)!;
    committedRow.phase = 'installing';
    await state.saveManaged(committedRow);

    // 2. Interrupted OpenCode installation (client config never written) -> rolled back to `failed` and key revoked.
    const interruptedId = 'c'.repeat(24);
    const interruptedKey = s.auth.create(
      principal,
      'Interrupted OpenCode',
      ['agent/test'],
      ['read', 'invoke', 'files'],
      undefined,
      'own',
      'workspace',
      { toolMode: 'managed', allowedModes: ['managed'], audience: 'private' },
      interruptedId,
    );
    await state.writeKeyFile(interruptedId, String(interruptedKey.token));
    const interruptedRecord: ManagedTargetRecord = {
      version: 1,
      id: interruptedId,
      target: 'opencode',
      channel: 'api',
      owner: 'owner',
      agent: 'agent/test',
      model: 'auto',
      toolMode: 'managed',
      execution: 'workspace',
      configFile: s.paths.opencodeConfig,
      baseUrl: 'http://127.0.0.1:8787/v1',
      keyId: String(interruptedKey.id),
      phase: 'installing',
      sourceRevision: 'fixture',
      createdAt: 1,
      updatedAt: 1,
      owned: {
        entryId: 'open-agent-api',
        entryHash: sha('unwritten'),
        tokenHash: sha(String(interruptedKey.token)),
        createdConfig: true,
        modelCount: 1,
        primaryModel: 'agent/test',
        keyFile: state.keyFilePath(interruptedId),
      },
    };
    await state.saveManaged(interruptedRecord);

    // 3. Untracked orphan key minted before journal persistence -> revoked.
    const orphanKey = s.auth.create(
      principal,
      'Orphan MCP',
      ['*'],
      ['read', 'invoke', 'files'],
      undefined,
      'own',
      'workspace',
      undefined,
      'd'.repeat(24),
    );

    const freshAuth = new Auth(s.store);
    await freshAuth.load(s.config);
    const manager = new LocalConnections(
      freshAuth,
      s.config.dataDir,
      new DshClient(s.dsh.home),
      'owner',
      () => {
        throw new Error('No source lookup during recovery');
      },
      s.paths,
    );
    await manager.ready;

    const recoveredRows = await state.listManaged();
    assert.equal(recoveredRows.find((r) => r.id === applied.id)?.phase, 'active');
    assert.equal(recoveredRows.find((r) => r.id === interruptedId)?.phase, 'failed');
    assert.equal(
      freshAuth.list(principal).some((k) => k.id === applied.key_id),
      true,
    );
    assert.equal(
      freshAuth.list(principal).some((k) => k.id === interruptedKey.id || k.id === orphanKey.id),
      false,
    );
    await assert.rejects(access(state.keyFilePath(interruptedId)));
  } finally {
    await s.cleanup();
  }
});
