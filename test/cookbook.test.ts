import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// The cookbook (examples/cookbook/): offline checks of its structure. The examples themselves are RUN by the
// compatibility lab (integrations/compat/cookbook.mjs, `npm run compat`) against an isolated gateway; these tests make
// sure that nothing escapes the lab, that every example is documented in both languages, that none carries a secret,
// and that the configuration snippets for third-party tools say what docs/compatibility.md says.

type Mod = Record<string, any>;
const lab = (await import(
  pathToFileURL(path.resolve('integrations/compat/cookbook.mjs')).href
)) as Mod;
const SCENARIOS = lab.SCENARIOS as Array<{
  file: string;
  agent: string;
  exit: number;
  args: string[];
  env: Record<string, string>;
  expect: RegExp[];
  title?: string;
}>;
const NOT_IN_LAB = lab.NOT_IN_LAB as Array<{ file: string; reason: string }>;

const ROOT = 'examples/cookbook';
const posix = (p: string) => p.split(path.sep).join('/');

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(posix(path.relative(ROOT, full)));
  }
  return out.sort();
}

const files = await walk(ROOT);
const isReadme = (f: string) => /^README(\.zh-CN)?\.md$/.test(f);
const runnable = files.filter((f) => /\.(py|mjs|sh)$/.test(f));

test('cookbook: every runnable example is run by the compatibility lab, and every exception says why', () => {
  const covered = new Set(SCENARIOS.map((s) => s.file));
  const excepted = new Map(NOT_IN_LAB.map((e) => [e.file, e.reason]));
  for (const f of runnable)
    assert.ok(
      covered.has(f),
      `${f} has no lab scenario (add one to integrations/compat/cookbook.mjs)`,
    );
  for (const f of files.filter((x) => !isReadme(x) && !runnable.includes(x)))
    assert.ok(
      excepted.has(f),
      `${f} is neither run by the lab nor listed in NOT_IN_LAB with a reason`,
    );
  for (const [f, reason] of excepted) {
    assert.ok(files.includes(f), `NOT_IN_LAB lists ${f}, which does not exist`);
    assert.ok(reason.length > 40, `the reason for ${f} must explain itself`);
    assert.ok(!covered.has(f), `${f} is both run and excepted`);
  }
  for (const s of SCENARIOS) {
    assert.ok(files.includes(s.file), `scenario for ${s.file}, which does not exist`);
    assert.ok(['fixture', 'sample', 'textOnly', 'native'].includes(s.agent), s.agent);
    assert.ok(s.expect.length > 0, `${s.file} asserts nothing about its output`);
  }
  const ids = SCENARIOS.map(lab.scenarioId as (s: unknown) => string);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids are unique');
  // The three recipes the brief names for a shared language each have all three runtimes somewhere.
  for (const runtime of ['python', 'node', 'shell'])
    assert.ok(
      SCENARIOS.some((s) => lab.runtimeOf(s.file) === runtime),
      `no ${runtime} scenario`,
    );
});

test('cookbook: every example starts with what it shows, what it needs and how to run it', async () => {
  for (const f of runnable) {
    const head = (await readFile(path.join(ROOT, f), 'utf8')).split('\n').slice(0, 24).join('\n');
    assert.match(head, /What it shows/i, `${f}: no "What it shows"`);
    assert.match(head, /^\W*(#|\/\/)?\s*Needs:/m, `${f}: no "Needs:" line`);
    assert.match(head, /^\W*(#|\/\/)?\s*Run:/m, `${f}: no "Run:" line`);
    assert.match(head, /Agent:/, `${f}: says nothing about which agents it works with`);
  }
});

test('cookbook: examples read the environment, default to a local quickstart gateway and carry no secret', async () => {
  for (const f of runnable) {
    const text = await readFile(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(
      text,
      /sk-oaa-[A-Za-z0-9]{12,}/,
      `${f} contains something that looks like a key`,
    );
    assert.doesNotMatch(text, /Bearer\s+sk-(?!oaa-not-a-real-key)/, `${f} hard-codes a bearer key`);
    assert.match(
      text,
      /OAA_API_KEY|OAA_ADMIN_KEY|OPENAI_API_KEY/,
      `${f} does not read a key from the environment`,
    );
    if (!f.startsWith('08-connect-tools/env_check')) {
      assert.match(text, /OAA_BASE_URL/, `${f} ignores OAA_BASE_URL`);
      assert.match(text, /127\.0\.0\.1:8787/, `${f} has no default for the base URL`);
      assert.match(text, /OAA_AGENT/, `${f} ignores OAA_AGENT`);
      assert.match(text, /agent\/sample/, `${f} has no default agent`);
    }
    // No example may switch off what keeps an agent run from being repeated by accident.
    if (/\.(py)$/.test(f) && /OpenAI\(|Anthropic\(/.test(text))
      assert.match(text, /max_retries=0/, `${f}: SDK retries must be off`);
    if (/\.mjs$/.test(f) && /new (OpenAI|Anthropic)\(/.test(text))
      assert.match(text, /maxRetries: 0/, `${f}: SDK retries must be off`);
  }
});

test('cookbook: a Python example is never named like a package it imports', () => {
  const clash = new Set(['openai', 'anthropic', 'google', 'genai', 'httpx', 'httpx2', 'pydantic']);
  for (const f of runnable.filter((x) => x.endsWith('.py')))
    assert.ok(!clash.has(path.basename(f, '.py')), `${f} would hide the package of the same name`);
});

test('cookbook: example files are syntactically valid (Node always; Python and sh when the interpreter is present)', (t) => {
  for (const f of runnable.filter((x) => x.endsWith('.mjs'))) {
    const r: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      ['--check', path.join(ROOT, f)],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const python = ['python3', 'python'].find(
    (p) => spawnSync(p, ['-c', 'pass'], { stdio: 'ignore' }).status === 0,
  );
  if (python) {
    for (const f of runnable.filter((x) => x.endsWith('.py'))) {
      const r: SpawnSyncReturns<string> = spawnSync(
        python,
        [
          '-I',
          '-c',
          'import ast, sys; ast.parse(open(sys.argv[1], encoding="utf8").read())',
          path.join(ROOT, f),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } else t.diagnostic('python was not found: the Python examples were not syntax-checked');
  const sh = process.platform === 'win32' ? undefined : '/bin/sh';
  if (sh && existsSync(sh)) {
    for (const f of runnable.filter((x) => x.endsWith('.sh'))) {
      const r: SpawnSyncReturns<string> = spawnSync(sh, ['-n', path.join(ROOT, f)], {
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  } else t.diagnostic('no POSIX shell: the curl examples were not syntax-checked');
});

test('cookbook: both READMEs list the same files, and every runnable example is in them', async () => {
  const linked = async (name: string) => {
    const text = await readFile(path.join(ROOT, name), 'utf8');
    return new Set(
      [...text.matchAll(/\]\(([^)\s#]+)\)/g)]
        .map((m) => m[1]!)
        .filter(
          (href) =>
            !href.startsWith('.') &&
            !/^[a-z]+:/.test(href) &&
            !href.endsWith('/') &&
            !isReadme(href),
        ),
    );
  };
  const en = await linked('README.md');
  const zh = await linked('README.zh-CN.md');
  assert.deepEqual(
    [...en].sort(),
    [...zh].sort(),
    'the English and Chinese README link the same files',
  );
  for (const f of runnable) assert.ok(en.has(f), `${f} is not linked from the README`);
  for (const f of files.filter((x) => !isReadme(x) && !runnable.includes(x) && !x.endsWith('.png')))
    assert.ok(en.has(f), `${f} is not linked from the README`);
  const first = async (name: string) =>
    (await readFile(path.join(ROOT, name), 'utf8')).split('\n').slice(0, 4).join('\n');
  assert.match(await first('README.md'), /^English · \[简体中文\]\(README\.zh-CN\.md\)$/m);
  assert.match(await first('README.zh-CN.md'), /^\[English\]\(README\.md\) · 简体中文$/m);
});

test('cookbook: the README says what the offline sample agent really does (checked against its source)', async () => {
  const source = await readFile('examples/sample-agent.mjs', 'utf8');
  // The README states that the sample agent cannot continue a session: that must stay true of the file it describes.
  assert.match(source, /loadSession:\s*false/);
  assert.doesNotMatch(source, /session\/load|session\/resume/);
  // It asks for approval when the task says so (the approvals examples depend on this).
  assert.match(source, /\/审批\|批准\|approv\/i/);
  // It never calls caller tools: no MCP handling at all.
  assert.doesNotMatch(source, /mcpServers|tools\/call/);
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const text = await readFile(path.join(ROOT, name), 'utf8');
    assert.match(text, /native_resume_unsupported/);
    assert.match(text, /structured_output_invalid/);
    assert.match(text, /effect_outcome_unknown/);
  }
});

// ───────────────────────── configuration snippets for third-party tools ─────────────────────────

const compat = await readFile('docs/compatibility.md', 'utf8');
const replay = async (name: string): Promise<{ setup: Record<string, string> }> =>
  JSON.parse(await readFile(`integrations/compat/replays/${name}.json`, 'utf8'));

test('cookbook: continue.config.yaml says what the Continue replay and the compatibility document say', async () => {
  const doc = parse(
    await readFile(path.join(ROOT, '08-connect-tools/continue.config.yaml'), 'utf8'),
  ) as { models: Array<Record<string, any>> };
  const model = doc.models[0]!;
  assert.equal(model.provider, 'openai');
  assert.equal(model.model, 'agent/sample');
  assert.match(model.apiBase, /^http:\/\/127\.0\.0\.1:8787\/v1$/);
  assert.deepEqual(model.capabilities, ['tool_use']);
  assert.deepEqual(model.roles, ['chat', 'edit', 'apply']);
  assert.ok(
    model.apiKey.includes('<') && !/sk-oaa-/.test(model.apiKey),
    'a placeholder, not a key',
  );
  const setup = (await replay('continue')).setup;
  assert.match(setup.baseUrl!, /include \/v1/);
  assert.match(setup.notes!, /provider: openai/);
  assert.match(setup.notes!, /capabilities: \[tool_use\]/);
  assert.match(compat, /`config\.yaml`, `models\[\]`/);
  assert.match(compat, /Add `capabilities: \[tool_use\]`/);
});

test('cookbook: zed.settings.json says what the Zed replay and the compatibility document say', async () => {
  const settings = JSON.parse(
    await readFile(path.join(ROOT, '08-connect-tools/zed.settings.json'), 'utf8'),
  ) as Mod;
  const provider = settings.language_models.openai_compatible.oaa;
  assert.equal(provider.api_url, 'http://127.0.0.1:8787/v1');
  assert.equal(provider.available_models[0].name, 'agent/sample');
  assert.equal(typeof provider.available_models[0].max_tokens, 'number');
  const setup = (await replay('zed')).setup;
  assert.match(setup.baseUrl!, /include \/v1/);
  assert.ok(setup.notes!.includes('"api_url":"http://localhost:8787/v1"'));
  assert.ok(setup.notes!.includes('"max_tokens":128000'));
  assert.match(compat, /language_models\.openai_compatible\.<name>/);
});

test('cookbook: librechat.yaml says what the LibreChat replay and the compatibility document say', async () => {
  const doc = parse(await readFile(path.join(ROOT, '08-connect-tools/librechat.yaml'), 'utf8')) as {
    endpoints: { custom: Array<Record<string, any>> };
  };
  const endpoint = doc.endpoints.custom[0]!;
  assert.equal(endpoint.baseURL, 'http://127.0.0.1:8787/v1');
  assert.deepEqual(endpoint.models.default, ['agent/sample']);
  assert.equal(endpoint.models.fetch, true);
  assert.equal(endpoint.titleConvo, false);
  assert.deepEqual(endpoint.dropParams, ['stop', 'user']);
  const setup = (await replay('librechat')).setup;
  assert.match(setup.baseUrl!, /WITH \/v1/);
  assert.match(setup.notes!, /titleConvo: false/);
  assert.match(setup.notes!, /dropParams: \['stop','user'\]/);
  assert.match(compat, /Set `titleConvo: false`/);
});

test('cookbook: the Base URLs the README gives for the tools match the compatibility document', async () => {
  const text = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  // The one tool that must NOT have /v1 and the one that accepts both.
  assert.match(text, /NextChat \|[^\n]*`http:\/\/<host>:8787` without `\/v1`/);
  assert.match(compat, /\| NextChat \|[^\n]*`http:\/\/<host>:8787` \*\*without `\/v1`\*\*/);
  assert.match(text, /Cherry Studio \|[^\n]*`http:\/\/<host>:8787` or `\.\.\.\/v1`/);
  // Cursor stays marked unverified.
  assert.match(text, /Cursor \|[^\n]*\*\*unverified\*\*/);
  // Every OpenAI-style tool row ends its URL with /v1 except the two above.
  for (const row of text
    .split('\n')
    .filter((l) =>
      /^\| (Open WebUI|LibreChat|Chatbox|LobeChat|Dify|n8n|Continue|Cline|Zed) /.test(l),
    ))
    assert.match(row, /8787\/v1`/, row.slice(0, 60));
});
