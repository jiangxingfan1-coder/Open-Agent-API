import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// Docker files, read as text. No docker on a developer machine is needed and nothing is built or run:
// these checks catch a COPY of a path that does not exist, a missing USER / HEALTHCHECK, a compose port
// mapping that widens exposure, and a broken publish workflow before CI has to find out.

type Mod = Record<string, any>;
const entry: Mod = await import(pathToFileURL(path.resolve('scripts/docker-entrypoint.mjs')).href);
const dockerfile = await readFile('Dockerfile', 'utf8');
const ignore = (await readFile('.dockerignore', 'utf8'))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
// Joins `\` continuations so a multi-line RUN reads as one instruction.
const instructions = dockerfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')
  .replace(/\\\n\s*/g, ' ')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

/** A small .dockerignore matcher: root-anchored paths, `**` and `*` globs, `!` re-includes; last match wins. */
function ignored(rel: string): boolean {
  let result = false;
  for (const raw of ignore) {
    const negate = raw.startsWith('!');
    const pattern = (negate ? raw.slice(1) : raw).replace(/\/$/, '');
    const body = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(.*/)?');
    if (new RegExp(`^${body}(/.*)?$`).test(rel)) result = !negate;
  }
  return result;
}

test('Dockerfile: three stages, official Node 24 slim images, non-root runtime user', () => {
  const stages = instructions.filter((l) => /^FROM /.test(l));
  assert.deepEqual(
    stages.map((l) => l.replace(/^FROM\s+(\S+)\s+AS\s+(\S+)$/, '$1 $2')),
    ['node:24-slim build', 'node:24-slim deps', 'node:24-slim runtime'],
  );
  const runtime = instructions.slice(instructions.findIndex((l) => l.endsWith('AS runtime')));
  const at = (prefix: string) => runtime.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('USER node') > at('RUN ') && at('USER node') < at('ENTRYPOINT'));
  assert.ok(at('HEALTHCHECK') > at('USER node'));
  assert.match(runtime.join('\n'), /\/healthz/);
  assert.ok(at('EXPOSE 8787') > 0);
  // The data volume is declared after the chown so a new named volume is writable by the node user.
  assert.ok(at('VOLUME /data') > at('RUN '), 'VOLUME must come after the RUN that chowns /data');
  assert.match(runtime.find((l) => l.startsWith('RUN ')) ?? '', /chown node:node \/data/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/docker-entrypoint\.mjs"\]/);
});

test('Dockerfile: production install excludes dev dependencies (so no Claude Agent SDK) and optional packages', () => {
  const deps = instructions.find((l) => l.startsWith('RUN npm ci --omit=dev')) ?? '';
  assert.match(deps, /--omit=dev/);
  assert.match(deps, /--omit=optional/, 'a CLI --omit replaces the omit=optional of .npmrc');
  assert.match(deps, /test ! -e node_modules\/@anthropic-ai\/claude-agent-sdk/);
  assert.match(deps, /test ! -e node_modules\/typescript/);
  assert.ok(
    instructions.includes('RUN npm ci --ignore-scripts'),
    'the build stage installs everything',
  );
  assert.ok(instructions.includes('COPY package.json package-lock.json .npmrc ./'));
});

test('Dockerfile: every COPY source exists and is not excluded by .dockerignore', () => {
  let checked = 0;
  for (const line of instructions) {
    const m = /^COPY\s+(.+)$/.exec(line);
    if (!m || m[1]!.startsWith('--from')) continue;
    const parts = m[1]!.split(/\s+/);
    for (const src of parts.slice(0, -1)) {
      checked++;
      if (src.includes('*')) {
        // Only one glob is used (examples/*.oaa): it must match something that is not ignored.
        const dir = path.dirname(src);
        const re = new RegExp(`^${path.basename(src).replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
        const found = existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)) : [];
        assert.ok(found.length > 0, `COPY glob ${src} matches nothing`);
        for (const f of found)
          assert.ok(!ignored(`${dir}/${f}`), `${dir}/${f} is in .dockerignore`);
      } else {
        assert.ok(existsSync(src), `COPY source ${src} does not exist`);
        assert.ok(!ignored(src), `COPY source ${src} is excluded by .dockerignore`);
      }
    }
  }
  assert.ok(checked >= 12, `only ${checked} COPY sources were checked`);
  // And the things that must stay out of the build context, at any depth.
  for (const secret of [
    'node_modules',
    'dist',
    '.git',
    '.oaa',
    '.oaa-dev/keys/a.key',
    'admin.token',
    'x/admin.token',
    'keys/x.key',
    'a/b/c.pem',
    '.env',
    'x/.env.local',
  ])
    assert.ok(ignored(secret), `${secret} must be ignored`);
  assert.ok(!ignored('scripts/docker-entrypoint.mjs') && ignored('scripts/release-plan.mjs'));
});

test('docker-compose.yml: loopback-only port mapping, data volume, no real secrets', async () => {
  const text = await readFile('docker-compose.yml', 'utf8');
  const compose = parse(text) as {
    services: { oaa: Record<string, any> };
    volumes: Record<string, unknown>;
  };
  const svc = compose.services.oaa;
  assert.deepEqual(svc.ports, ['127.0.0.1:8787:8787'], 'published on loopback only');
  assert.deepEqual(svc.volumes, ['oaa-data:/data']);
  assert.ok('oaa-data' in compose.volumes);
  assert.equal(svc.init, true);
  assert.deepEqual(svc.cap_drop, ['ALL']);
  assert.ok(svc.build);
  // Keys appear only as commented placeholders, never as live values.
  for (const [name, value] of Object.entries((svc.environment ?? {}) as Record<string, string>))
    assert.ok(!/KEY|TOKEN|SECRET/i.test(name), `${name} must not be a live variable: ${value}`);
  assert.match(text, /# OPENAI_API_KEY: "sk-replace-with-your-key"/);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(text, /0\.0\.0\.0:\d+:\d+/, 'never map to all interfaces');
});

test('docker entrypoint: settings from the environment and config patching', () => {
  assert.deepEqual(entry.settingsFromEnv({}), {
    dataDir: '/data/.oaa',
    host: '0.0.0.0',
    port: 8787,
    extraHosts: [],
  });
  assert.deepEqual(
    entry.settingsFromEnv({
      OAA_DATA_DIR: '/x',
      OAA_HOST: '127.0.0.1',
      OAA_PORT: '9000',
      OAA_ALLOWED_HOSTS: ' api.example.com , ,b.example.com',
    }),
    {
      dataDir: '/x',
      host: '127.0.0.1',
      port: 9000,
      extraHosts: ['api.example.com', 'b.example.com'],
    },
  );
  for (const bad of ['0', '70000', 'abc', '1.5'])
    assert.throws(() => entry.settingsFromEnv({ OAA_PORT: bad }), /OAA_PORT/);
  const settings = entry.settingsFromEnv({ OAA_ALLOWED_HOSTS: 'api.example.com' });
  const raw = {
    host: '127.0.0.1',
    port: 1,
    allowedHosts: ['127.0.0.1', 'localhost', 'mine.local'],
  };
  entry.applySettings(raw, settings);
  assert.equal(raw.host, '0.0.0.0');
  assert.equal(raw.port, 8787);
  assert.deepEqual(raw.allowedHosts, [
    '127.0.0.1',
    'localhost',
    '[::1]',
    'mine.local',
    'api.example.com',
  ]);
  const again = JSON.stringify(raw);
  entry.applySettings(raw, settings);
  assert.equal(JSON.stringify(raw), again, 'applying twice changes nothing');
  assert.deepEqual(entry.applySettings({}, settings).allowedHosts, [
    '127.0.0.1',
    'localhost',
    '[::1]',
    'api.example.com',
  ]);
});

test('docker workflow: publish on release or dispatch, verify on push and pull_request, least privilege', async () => {
  const text = await readFile('.github/workflows/docker.yml', 'utf8');
  const wf = parse(text);
  assert.deepEqual(wf.on.release.types, ['published']);
  assert.ok('workflow_dispatch' in wf.on && 'push' in wf.on && 'pull_request' in wf.on);
  assert.equal(Object.keys(wf.permissions).length, 0, 'top-level permissions are empty');
  const job = wf.jobs.image;
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  type Step = { name?: string; uses?: string; if?: string; with?: Record<string, any> };
  const steps = job.steps as Step[];
  const builds = steps.filter((s) => /build-push-action/.test(s.uses ?? ''));
  assert.equal(builds.length, 2);
  const [smoke, publish] = builds as [Step, Step];
  assert.equal(smoke.with?.platforms, 'linux/amd64');
  assert.equal(smoke.with?.push, false);
  assert.equal(smoke.with?.load, true);
  assert.equal(publish.with?.platforms, 'linux/amd64,linux/arm64');
  assert.equal(publish.with?.push, true);
  assert.equal(publish.if, "env.PUBLISH == 'true'");
  assert.ok(steps.indexOf(smoke) < steps.indexOf(publish), 'the smoke build comes first');
  const smokeAt = steps.findIndex((s) => /Smoke test the container/.test(s.name ?? ''));
  assert.ok(smokeAt > steps.indexOf(smoke) && smokeAt < steps.indexOf(publish));
  const login = steps.find((s) => /login-action/.test(s.uses ?? ''));
  assert.equal(login?.if, "env.PUBLISH == 'true'", 'no registry login on verification builds');
  assert.equal(login?.with?.password, '${{ secrets.GITHUB_TOKEN }}');
  // Names: lower-cased owner, version and latest tags, no latest for pre-releases.
  assert.match(text, /\$\{OWNER,,\}\/open-agent-api/);
  assert.match(text, /:latest/);
  assert.match(text, /PRERELEASE.*!= "true"/);
  assert.match(text, /does not match package\.json/);
  assert.match(String(publish.with?.tags), /steps\.meta\.outputs\.tags/);
});
