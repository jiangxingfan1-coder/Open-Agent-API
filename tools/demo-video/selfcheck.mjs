// 录制流水线的自检：不调用任何真实智能体，覆盖「真实录制的网关配置 + 审批段」与补录审批段。
//
//   npm run build && node tools/demo-video/selfcheck.mjs
//
// 做的事（会在 127.0.0.1 临时监听随机端口，跑完即释放，数据都在系统临时目录里并在结束时删除）：
//   1. 用 --agent fixture 并带上与真实录制相同的 --model gemini-3.8-flash-low 跑一遍完整录制。fixture 与真实录制
//      走同一份网关配置（native.antigravity 引擎、同样的参数与 --model 校验），只把 agy 换成 placeholder-agy.mjs；
//      审批段若被模型名卡住（model_not_supported）会在这里暴露，而不是等到花了钱的真实录制里才发现。
//   2. 检查 recording.json：三次调用都成功、四份快照齐全、审批任务从待审批到完成、没有遗留子进程、没有路径与密钥。
//   3. 对第 1 步的录制做一次 --approval-only --merge 补录：原文件不变，副本里审批段与快照是新的。
//   4. 对一份「审批段失败」的录制（模拟真实录制里出现的那种）补录，确认问题记录被正确更新。
//   2b. 英文提示词集（--lang en）：同样用占位智能体录一遍，检查语言标记、没有汉字、代码段放得进画面。
//   5. 单独检查遮蔽函数：file:// 链接、~/ 路径、本机绝对路径、密钥一律不能漏。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbidden, makeScrubber, PATH_PLACEHOLDER_EN } from './lib/scrub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(HERE, 'record.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'oaa-demo-selfcheck-'));
const failures = [];
const check = (name, ok, detail) => {
  process.stdout.write(
    `${ok ? '通过' : '失败'}  ${name}${ok || detail === undefined ? '' : `：${detail}`}\n`,
  );
  if (!ok) failures.push(name);
};
const record = (args) => {
  const r = spawnSync(process.execPath, [RECORD, ...args], { encoding: 'utf8', timeout: 240_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

try {
  // 1–2. 完整录制（fixture，真实录制的模型参数）
  const full = path.join(work, 'full');
  const a = record([
    '--agent',
    'fixture',
    '--model',
    'gemini-3.8-flash-low',
    '--placeholder-delay-ms',
    '300',
    '--out',
    full,
  ]);
  check('完整录制退出码为 0', a.code === 0, a.out.slice(-400));
  const rec = readJson(path.join(full, 'recording.json'));
  check('没有问题记录', rec.problems.length === 0, rec.problems.join('；'));
  check('请求的模型与真实录制一致', rec.agent.requested_model === 'gemini-3.8-flash-low');
  check(
    '三次调用都成功',
    ['openai', 'anthropic', 'gemini'].every((k) => rec.calls[k]?.ok === true),
  );
  check(
    '四份快照齐全',
    ['tasks', 'approval_pending', 'approval_approved', 'approval_done'].every(
      (k) => rec.snapshots[k]?.routes,
    ),
  );
  check(
    '审批任务从待审批到完成',
    rec.approval.parked_status === 'requires_action' && rec.approval.final_status === 'completed',
  );
  check(
    '批准请求成功',
    rec.approval.decisions?.length > 0 &&
      rec.approval.decisions.every((d) => d.http_status === 200),
  );
  check('没有遗留子进程', rec.child_processes.left_running === 0);
  check(
    '录制里没有路径或密钥',
    findForbidden(readFileSync(path.join(full, 'recording.json'), 'utf8')) === null,
  );

  // 2b. 英文提示词集（--lang en）：同样不调用真实智能体；提示词、回答、显示名与说明里都不该有汉字，代码段每行放得进画面
  const en = path.join(work, 'en');
  const e = record([
    '--agent',
    'fixture',
    '--lang',
    'en',
    '--model',
    'gemini-3.8-flash-low',
    '--placeholder-delay-ms',
    '300',
    '--out',
    en,
  ]);
  check('英文录制退出码为 0', e.code === 0, e.out.slice(-400));
  const recEn = readJson(path.join(en, 'recording.json'));
  const HAN = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
  check(
    '英文录制标明语言并且没有问题记录',
    recEn.lang === 'en' && recEn.problems.length === 0,
    recEn.problems.join('；'),
  );
  check(
    '英文录制：提示词、回答、显示名、说明里没有汉字',
    !HAN.test(
      JSON.stringify({
        code: recEn.code,
        calls: recEn.calls,
        approval: recEn.approval,
        agent: recEn.agent,
        gateway: recEn.gateway,
      }),
    ),
  );
  check(
    '英文录制：三次调用都成功，审批从待审批到完成',
    ['openai', 'anthropic', 'gemini'].every((k) => recEn.calls[k]?.ok === true) &&
      recEn.approval.parked_status === 'requires_action' &&
      recEn.approval.final_status === 'completed',
  );
  check(
    '英文录制：示例代码每行不超过 90 个字符（放得进画面）',
    recEn.code.snippet_after.split('\n').every((l) => l.length <= 90),
  );
  check(
    '中文录制的代码段仍是一行提示词',
    rec.code.snippet_after.split('\n').some((l) => l.startsWith("const task = '")),
  );
  check(
    '补录审批段不接受 --lang',
    record([
      '--approval-only',
      '--merge',
      path.join(full, 'recording.json'),
      '--lang',
      'en',
      '--out',
      path.join(work, 'y'),
    ]).code === 2,
  );

  // 3. 补录审批段：原文件不变
  const before = sha(path.join(full, 'recording.json'));
  const again = path.join(work, 'again');
  const b = record([
    '--approval-only',
    '--merge',
    path.join(full, 'recording.json'),
    '--out',
    again,
  ]);
  check('补录退出码为 0', b.code === 0, b.out.slice(-400));
  check('原录制文件没有被改动', sha(path.join(full, 'recording.json')) === before);
  const merged = readJson(path.join(again, 'recording.json'));
  check(
    '补录没有发起任何主智能体调用',
    merged.agent_invocations.main === rec.agent_invocations.main &&
      merged.agent_invocations.approval === 1,
  );
  check(
    '补录保留了前面的真实调用与任务快照',
    merged.calls.openai.text === rec.calls.openai.text &&
      merged.snapshots.tasks.captured_at === rec.snapshots.tasks.captured_at,
  );
  check(
    '补录的审批段是新的',
    merged.approval.run_id !== rec.approval.run_id &&
      merged.snapshots.approval_done.captured_at > rec.snapshots.approval_done.captured_at,
  );
  check('补录标注了来源', merged.merged?.approval_only === true && merged.problems.length === 0);
  check(
    '补录时拒绝 --agent / --confirm-live-cost',
    record([
      '--approval-only',
      '--merge',
      path.join(full, 'recording.json'),
      '--agent',
      'antigravity',
      '--out',
      path.join(work, 'x'),
    ]).code === 2,
  );

  // 4. 审批段失败的录制（真实录制里出现过的样子）补录后，问题记录应被更新
  const broken = {
    ...rec,
    problems: ['等待「待审批」超时'],
    approval: { ...rec.approval, final_status: undefined },
    snapshots: { tasks: rec.snapshots.tasks },
  };
  const brokenFile = path.join(work, 'broken.json');
  writeFileSync(brokenFile, JSON.stringify(broken));
  const fixed = path.join(work, 'fixed');
  const c = record(['--approval-only', '--merge', brokenFile, '--out', fixed]);
  const repaired = readJson(path.join(fixed, 'recording.json'));
  check(
    '补录能修复审批段失败的录制',
    c.code === 0 &&
      repaired.problems.length === 0 &&
      repaired.approval.final_status === 'completed' &&
      !!repaired.snapshots.approval_pending,
    c.out.slice(-300),
  );

  // 5. 遮蔽函数
  const home = process.env.HOME ?? '/Users/someone';
  const scrub = makeScrubber({
    redact: (t) => t,
    masks: [
      ['/tmp/out-dir', '/demo'],
      [home, '~'],
    ],
  });
  const sample = {
    text: `我已生成计划 [plan.md](file://${home}/.gemini/brain/abc/plan.md)，另见 ${home}/work/a.txt 与 /tmp/out-dir/workspace/x，以及 ~/notes。`,
    ok: [
      'agent/demo-approval',
      'http://127.0.0.1:8787/v1/chat/completions',
      'POST /v1/models/agent/x:generateContent',
    ],
  };
  const out = scrub(sample);
  const scrubEn = makeScrubber({
    redact: (t) => t,
    masks: [[home, '~']],
    placeholder: PATH_PLACEHOLDER_EN,
  });
  check(
    '英文遮蔽用英文占位',
    scrubEn({ t: `see file://${home}/x/plan.md` }).t === `see ${PATH_PLACEHOLDER_EN}`,
    JSON.stringify(scrubEn({ t: `see file://${home}/x/plan.md` })),
  );
  check('遮蔽后没有路径', findForbidden(JSON.stringify(out)) === null, JSON.stringify(out));
  check('遮蔽不误伤正常文字', out.ok.join('|') === sample.ok.join('|'));
  check(
    '兜底检查能抓到各种路径',
    [
      'file://~/x',
      '~/.gemini/a',
      '/Users/a/b',
      '/Volumes/D/p',
      '/private/tmp/x',
      'C:\\Users\\a',
    ].every((t) => findForbidden(t) !== null),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  process.stderr.write(`\n自检失败 ${failures.length} 项：${failures.join('；')}\n`);
  process.exit(1);
}
process.stdout.write('\n自检全部通过。\n');
