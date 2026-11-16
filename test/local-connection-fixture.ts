import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { setup, agent, FixtureModel } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';

export async function dshFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oaa-dsh-fixture-'));
  await mkdir(path.join(home, 'profiles/desktop'), { recursive: true });
  await writeFile(
    path.join(home, 'profiles/desktop/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  for (const name of ['dsh-settings-file', 'dsh-credentials-local', 'dsh-llm-pi-ai']) {
    const dir = path.join(home, 'profiles/node_modules/@deepseek-ai', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@deepseek-ai/${name}` }),
    );
  }
  const profile =
    '# Existing profile must remain byte-for-byte unchanged\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      original:\n        apiKeyEnv: EXISTING_KEY\n';
  await writeFile(path.join(home, 'profiles/desktop/cordis.patch.yml'), profile, { mode: 0o600 });
  const settings = '# Retain this comment\nappearance:\n  theme: dark\n';
  const credentials =
    '# Private synthetic fixture\nversion: 1\nrefs:\n  EXISTING_KEY: preserve-fixture-secret\n';
  await writeFile(path.join(home, 'settings.yaml'), settings, { mode: 0o600 });
  await writeFile(path.join(home, '.credentials.yaml'), credentials, { mode: 0o600 });
  return {
    home,
    profile,
    settings,
    credentials,
    readSettings: async () =>
      parse(await readFile(path.join(home, 'settings.yaml'), 'utf8')) as Record<string, unknown>,
    readCredentials: async () =>
      parse(await readFile(path.join(home, '.credentials.yaml'), 'utf8')) as {
        version: number;
        refs: Record<string, string>;
      },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
export async function connectionFixture(driver = new FixtureModel()) {
  const dsh = await dshFixture();
  const s = await setup(driver, {}, { dshHome: dsh.home });
  await s.listen();
  s.store.publish('owner', makeBundle(agent({ modelPolicy: { mode: 'declared' } })));
  const configure = async (model = 'auto') => {
    const preview = await s.request('POST', '/v1/local/connections/preview', {
      agent: 'agent/test',
      model,
    });
    if (preview.statusCode !== 200) throw Error(preview.body);
    const result = await s.request('POST', '/v1/local/connections/apply', {
      plan_id: preview.json().plan_id,
    });
    return { preview, result };
  };
  return {
    ...s,
    dsh,
    configure,
    cleanup: async () => {
      await s.cleanup();
      await dsh.cleanup();
    },
  };
}
