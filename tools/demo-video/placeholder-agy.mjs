// 演示视频的「占位智能体」：Antigravity（agy）命令行 stream-json 协议的本地替身，只在 `record.mjs --agent fixture`
// 时被当作 agy 的可执行文件使用。它让占位录制走与真实录制完全相同的网关配置：同样的 native.antigravity 引擎、
// 同样的参数、同样的 --model 校验，只是把可执行文件换成这个脚本。
// 不调用任何模型、不联网。对演示用的几句提示词给出固定的回答，并按 --delay-ms 假装「思考」一会儿。
// 回答不是任何模型的输出：record.mjs 会把这次录制标成 agent.real=false，渲染器据此在画面上打「占位素材」。
import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DELAY_MS = Number(flag('--delay-ms')) || 0;
const model = flag('--model');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// [提示词里的关键词, 中文回答, 英文回答]：提示词里有汉字就用中文回答，否则用英文回答（record.mjs --lang en 的提示词集）。
const ANSWERS = [
  [
    'P1/P2/P3',
    ['P1 修登录页 bug（客户昨天投诉）', 'P1 周五前回报价', 'P3 订咖啡豆'].join('\n') + '\n',
    ['P1: Fix the login page bug', 'P2: Send the quote by Friday', 'P3: Order coffee beans'].join(
      '\n',
    ) + '\n',
  ],
  ['不超过 20 个字', '我是本地替身，只给固定回答。\n', undefined],
  ['under 12 words', undefined, 'I am a local stand-in; I only give fixed answers.\n'],
];

// 与真实 agy 一样：先报初始化信息（含生效的模型），再等一条 user 事件。
out({
  event: 'init',
  init: { tools: [], permission_mode: 'plan', ...(model ? { model } : {}) },
});
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.event !== 'user') return;
  const text = String(message.message?.content ?? '');
  const han = /[\u3400-\u9fff]/.test(text);
  const hit = ANSWERS.find(([key]) => text.includes(key));
  const answer =
    (han ? hit?.[1] : hit?.[2]) ?? (han ? '收到。（本地替身）\n' : 'Received. (local stand-in)\n');
  await sleep(DELAY_MS);
  for (const part of answer.match(/[^\n]+\n?/g) ?? [answer])
    out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: part } });
  out({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: answer,
      conversation_id: `placeholder-${process.pid}`,
      usage: { input_tokens: 58, output_tokens: 36, total_tokens: 94 },
    },
  });
});
