import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ERROR_CATALOG,
  ERROR_CATALOG_REVISION,
  ERROR_CATEGORIES,
  errorEntry,
} from '../src/core/errors.js';
import { GATEWAY_FEATURES } from '../src/gateway/server.js';
import { setup } from './helpers.js';

// 不以 `new Fault('字面量', …)` 形式出现、而是拼接或另行赋值的错误码。新增这类码时同步登记在这里。
const DYNAMIC_ERROR_CODES: { code: string; source: string }[] = [
  // gateway/server.ts 的 frameworkCodes：Fastify 框架错误映射
  { code: 'invalid_json', source: "'invalid_json'" },
  { code: 'payload_too_large', source: "'payload_too_large'" },
  { code: 'unsupported_media_type', source: "'unsupported_media_type'" },
  { code: 'invalid_url', source: "'invalid_url'" },
  { code: 'invalid_multipart', source: "'invalid_multipart'" },
  { code: 'route_not_found', source: "'route_not_found'" },
  // 运行的错误码（store / run-state 直接写入运行记录）
  { code: 'gateway_restarted', source: "'gateway_restarted'" },
  { code: 'run_timeout', source: "'run_timeout'" },
  // fabric/network.ts：worker 结果透传的码与缺省值
  { code: 'worker_failed', source: "'worker_failed'" },
  { code: 'worker_capacity_exceeded', source: "'worker_capacity_exceeded'" },
  // providers/http-stream.ts 的 limitCode 及其调用方传入的值
  { code: 'upstream_output_limit', source: "'upstream_output_limit'" },
  { code: 'adapter_output_limit', source: "'adapter_output_limit'" },
  // kernel/kernel.ts：子运行没有错误码时的 `subagent_${status}`（非 completed 的终态）
  ...['failed', 'cancelled', 'interrupted', 'incomplete'].map((status) => ({
    code: `subagent_${status}`,
    source: 'subagent_${',
  })),
];

type Ts = typeof import('typescript');
type Node = import('typescript').Node;

async function sourceFiles(): Promise<{ file: string; text: string }[]> {
  const files = (await readdir(path.resolve('src'), { recursive: true })).filter((f) =>
    f.endsWith('.ts'),
  );
  return Promise.all(
    files.map(async (file) => ({
      file,
      text: await readFile(path.resolve('src', file), 'utf8'),
    })),
  );
}

/** 每个 `new RunErrorFault('字面量', …)`（只终结运行、不决定 HTTP 状态）的码；非字面量的码记为 undefined。 */
async function runErrorUsages(): Promise<{ code?: string; where: string }[]> {
  const ts = createRequire(path.resolve('package.json'))('typescript') as Ts;
  const usages: { code?: string; where: string }[] = [];
  for (const { file, text } of await sourceFiles()) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'RunErrorFault') {
        const arg = node.arguments?.[0];
        const code = arg && ts.isStringLiteral(arg) ? arg.text : undefined;
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        usages.push({ code, where });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return usages;
}

/** 每个 `new Fault(…)` 的字面量码，以及能从第三个参数确定的 HTTP 状态（确定不了为 undefined）。 */
async function faultUsages(): Promise<{ code: string; status?: number; where: string }[]> {
  const ts = createRequire(path.resolve('package.json'))('typescript') as Ts;
  const usages: { code: string; status?: number; where: string }[] = [];
  const literal = (n: Node): string | undefined =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
  const unwrap = (n: Node): Node => (ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n);
  // 叶子都是数字字面量时返回全部状态，否则 undefined（变量、表达式，尽力而为跳过）。
  const numbers = (n: Node): number[] | undefined => {
    n = unwrap(n);
    if (ts.isNumericLiteral(n)) return [Number(n.text)];
    if (ts.isConditionalExpression(n)) {
      const a = numbers(n.whenTrue);
      const b = numbers(n.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    return undefined;
  };
  for (const { file, text } of await sourceFiles()) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node: Node) => {
      if (
        ts.isNewExpression(node) &&
        node.expression.getText(source) === 'Fault' &&
        node.arguments?.[0]
      ) {
        const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const codeArg = unwrap(node.arguments[0]);
        const statusArg = node.arguments[2] ? unwrap(node.arguments[2]) : undefined;
        const statusesOf = (n: Node | undefined) => (n ? numbers(n) : [400]);
        if (ts.isConditionalExpression(codeArg)) {
          // `cond ? 'a' : 'b'` 与 `cond ? 1 : 2` 条件相同时按分支配对。
          const paired =
            statusArg &&
            ts.isConditionalExpression(statusArg) &&
            statusArg.condition.getText(source) === codeArg.condition.getText(source);
          for (const [branch, statusBranch] of [
            [codeArg.whenTrue, paired ? statusArg.whenTrue : statusArg],
            [codeArg.whenFalse, paired ? statusArg.whenFalse : statusArg],
          ] as const) {
            const code = literal(unwrap(branch));
            if (!code) continue;
            const statuses = statusesOf(statusBranch);
            if (!statuses) usages.push({ code, where });
            else for (const status of statuses) usages.push({ code, status, where });
          }
        } else {
          const code = literal(codeArg);
          if (code) {
            const statuses = statusesOf(statusArg);
            if (!statuses) usages.push({ code, where });
            else for (const status of statuses) usages.push({ code, status, where });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return usages;
}

const hanCount = (text: string) => [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).length;

test('error catalog: every Fault literal code in src is registered', async () => {
  const usages = await faultUsages();
  assert.ok(usages.length > 300, `expected the full Fault inventory, found ${usages.length}`);
  const missing = [...new Set(usages.map((u) => u.code))].filter((code) => !errorEntry(code));
  assert.deepEqual(missing.sort(), [], `register these codes in src/core/errors.ts`);
});

test('error catalog: dynamic codes are registered and still produced by the source', async () => {
  const all = (await sourceFiles()).map((f) => f.text).join('\n');
  for (const { code, source } of DYNAMIC_ERROR_CODES) {
    assert.ok(errorEntry(code), `dynamic code ${code} is registered`);
    assert.ok(all.includes(source), `dynamic code ${code} still appears in src (${source})`);
  }
});

test('error catalog: codes are unique, categorized, documented and described', async () => {
  const docs = await readFile(path.resolve('docs/protocol.md'), 'utf8');
  const codes = ERROR_CATALOG.map((e) => e.code);
  const duplicates = codes.filter((code, i) => codes.indexOf(code) !== i);
  assert.deepEqual(duplicates, [], 'no duplicate codes');
  for (const entry of ERROR_CATALOG) {
    assert.match(entry.code, /^[a-z][a-z0-9_]*$/, `${entry.code} is snake_case`);
    assert.ok(entry.category in ERROR_CATEGORIES, `${entry.code} has a known category`);
    assert.ok(docs.includes(`\`${entry.code}\``), `${entry.code} appears in docs/protocol.md`);
    assert.ok(entry.zh.trim().length > 0, `${entry.code} has a zh description`);
    assert.ok(hanCount(entry.zh) <= 40, `${entry.code} zh is at most 40 Han characters`);
    if (entry.next !== undefined) assert.ok(entry.next.trim().length > 0, `${entry.code} next`);
    assert.ok(entry.en.trim().length > 0, `${entry.code} has an en description`);
    assert.equal(hanCount(entry.en), 0, `${entry.code} en has no Han characters`);
    assert.equal(entry.next === undefined, entry.nextEn === undefined, `${entry.code} next/nextEn`);
    if (entry.nextEn !== undefined) {
      assert.ok(entry.nextEn.trim().length > 0, `${entry.code} nextEn`);
      assert.equal(hanCount(entry.nextEn), 0, `${entry.code} nextEn has no Han characters`);
    }
    if (entry.statuses) {
      assert.ok(entry.status !== null && entry.statuses.includes(entry.status), entry.code);
      assert.deepEqual([...new Set(entry.statuses)], [...entry.statuses], entry.code);
    }
  }
  assert.ok(ERROR_CATALOG.length > 200, `expected the full catalog, found ${codes.length}`);
});

test('error catalog: every HTTP status used in the source is listed for its code', async () => {
  const mismatched: string[] = [];
  for (const usage of await faultUsages()) {
    if (usage.status === undefined) continue;
    const entry = errorEntry(usage.code);
    if (!entry) continue;
    const allowed = entry.statuses ?? (entry.status === null ? [] : [entry.status]);
    if (!allowed.includes(usage.status))
      mismatched.push(`${usage.code} ${usage.status} (${usage.where})`);
  }
  assert.deepEqual(mismatched, [], 'add these statuses to the entry (statuses)');
});

test('error catalog: run-only codes (status null) are thrown as RunErrorFault, never as Fault', async () => {
  const runErrors = await runErrorUsages();
  assert.ok(runErrors.length >= 3, `expected the run-only throws, found ${runErrors.length}`);
  const problems: string[] = [];
  for (const { code, where } of runErrors) {
    if (!code) problems.push(`RunErrorFault without a literal code (${where})`);
    else if (errorEntry(code)?.status !== null || errorEntry(code)?.statuses)
      problems.push(
        `${code} is thrown as RunErrorFault but its catalog status is not null (${where})`,
      );
  }
  // 运行类（category run）里状态为 null 的码不能用 `new Fault` 抛出：不论第三个参数是数字字面量、
  // 命名常量还是省略。worker / 客户端本地的 null 码（category node、client）不在此列。
  for (const usage of await faultUsages()) {
    const entry = errorEntry(usage.code);
    if (entry?.category === 'run' && entry.status === null)
      problems.push(
        `${usage.code} has catalog status null but is thrown as Fault (${usage.where})`,
      );
  }
  assert.deepEqual(problems, [], 'use RunErrorFault for run-only codes and keep status null');
});

// 状态为 null 的 run 码里，原因在服务一侧（不是这次调用自身的上限 / 额度）的码。新增 null 的 run 码时，
// 要么在 src/core/errors.ts 的 CALLER_LIMIT 登记，要么登记在这里，否则下面的测试失败。
const SERVICE_SIDE_RUN_CODES = ['gateway_restarted', 'run_timeout', 'parent_interrupted'];

test('error catalog: every run-only code is classified as a caller limit or a service-side cause', async () => {
  const nullRun = ERROR_CATALOG.filter((e) => e.category === 'run' && e.status === null);
  const limits = nullRun.filter((e) => e.callerLimit).map((e) => e.code);
  const unclassified = nullRun
    .filter((e) => !e.callerLimit && !SERVICE_SIDE_RUN_CODES.includes(e.code))
    .map((e) => e.code);
  assert.deepEqual(unclassified, [], 'add to CALLER_LIMIT or SERVICE_SIDE_RUN_CODES');
  for (const code of SERVICE_SIDE_RUN_CODES) {
    assert.equal(errorEntry(code)?.status, null, code);
    assert.ok(!errorEntry(code)?.callerLimit, code);
  }
  // callerLimit 只给 status null 的 run 码，且正好是以 RunErrorFault 抛出的那些。
  for (const e of ERROR_CATALOG.filter((x) => x.callerLimit))
    assert.ok(e.category === 'run' && e.status === null, e.code);
  const thrown = [...new Set((await runErrorUsages()).map((u) => u.code))].sort();
  assert.deepEqual(limits.sort(), thrown);
});

test('GET /v1/errors returns the catalog with a revision ETag and 304', async () => {
  assert.ok(GATEWAY_FEATURES.includes('error-catalog-v1'));
  assert.match(ERROR_CATALOG_REVISION, /^[0-9a-f]{16}$/);
  const s = await setup();
  try {
    const health = await s.app.inject({ method: 'GET', url: '/health' });
    assert.ok((health.json().features as string[]).includes('error-catalog-v1'));
    const anonymous = await s.app.inject({ method: 'GET', url: '/v1/errors' });
    assert.equal(anonymous.statusCode, 401);

    const first = await s.request('GET', '/v1/errors');
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json() as {
      object: string;
      revision: string;
      categories: Record<string, string>;
      data: { code: string; status: number | null; retryable: boolean; zh: string }[];
    };
    assert.equal(body.object, 'list');
    assert.equal(body.revision, ERROR_CATALOG_REVISION);
    assert.deepEqual(body.categories, ERROR_CATEGORIES);
    assert.equal(body.data.length, ERROR_CATALOG.length);
    assert.deepEqual(
      body.data.find((e) => e.code === 'rate_limited'),
      JSON.parse(JSON.stringify(errorEntry('rate_limited'))),
    );
    const etag = first.headers.etag;
    assert.equal(typeof etag, 'string');
    assert.ok(String(etag).includes(ERROR_CATALOG_REVISION));

    const cached = await s.request('GET', '/v1/errors', undefined, undefined, {
      'if-none-match': String(etag),
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');
    const weak = await s.request('GET', '/v1/errors', undefined, undefined, {
      'if-none-match': `W/${String(etag)}`,
    });
    assert.equal(weak.statusCode, 304);
    const stale = await s.request('GET', '/v1/errors', undefined, undefined, {
      'if-none-match': '"errors-0000000000000000"',
    });
    assert.equal(stale.statusCode, 200);

    // 只有 files 权限的密钥不能读目录（需要 read）。
    const created = await s.request('POST', '/v1/keys', {
      name: 'files-only',
      agents: ['*'],
      scopes: ['files'],
    });
    assert.equal(created.statusCode, 200, created.body);
    const denied = await s.request('GET', '/v1/errors', undefined, created.json().token);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'scope_denied');
  } finally {
    await s.cleanup();
  }
});
