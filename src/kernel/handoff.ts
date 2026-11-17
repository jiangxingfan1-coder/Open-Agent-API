import type { Run, AgentDefinition } from '../core/contracts.js';

export const portableSessions = (agent: AgentDefinition) =>
  !!(agent.access || agent.modelPolicy || agent.orchestration || agent.approvals === 'auto');

/**
 * 智能体交接：同一个会话里换另一个智能体（或换模型）接着干。
 *
 * 交接时只带「对话层面」的上下文——用户说了什么、智能体最终答了什么——不带上一个智能体的
 * 工具调用细节、系统指令或它私有的会话句柄。内核智能体把这段对话当作消息历史；外部智能体
 * （Claude Code、Codex、ACP、A2A 等）自己管理会话，所以改用一段文字「交接说明」放在输入前面。
 */

export type HandoffTurn = { role: 'user' | 'assistant'; content: string };

const BRIEF_LIMIT = 12_000;
const TURN_LIMIT = 2_000;
const FILE_LIMIT = 50;

/** 从上一轮运行里取出可交接的对话：用户消息和智能体的文字回复，按时间顺序。 */
export function conversationOf(previous: Run): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  for (const message of previous.checkpoint.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;
    turns.push({ role: message.role, content: message.content });
  }
  // 外部智能体的回复只存在于运行输出里，不在消息历史中；内核智能体两边都有，避免重复。
  const answer = previous.output
    .map((m) => m.text)
    .join('\n')
    .trim();
  const last = turns.at(-1);
  if (answer && !(last?.role === 'assistant' && last.content.trim() === answer))
    turns.push({ role: 'assistant', content: answer });
  return turns;
}

const clip = (text: string) => (text.length > TURN_LIMIT ? `${text.slice(0, TURN_LIMIT)}…` : text);

const names = (list: readonly string[]) => {
  const unique = [...new Set(list)];
  const shown = unique.slice(0, FILE_LIMIT).join('、');
  return unique.length > FILE_LIMIT ? `${shown} 等 ${unique.length} 个` : shown;
};

/** 给外部智能体的交接说明：有长度上限，只含对话文字和文件名，不读文件内容。 */
export function buildHandoffBrief(input: {
  fromAgent: string;
  conversation: readonly HandoffTurn[];
  inputFiles: readonly string[];
  artifacts: readonly string[];
}): string {
  const head = `[交接说明] 你正在接手一个进行中的任务。之前由智能体「${input.fromAgent}」处理。`;
  const tail = [
    ...(input.inputFiles.length ? [`已有文件：${names(input.inputFiles)}`] : []),
    ...(input.artifacts.length ? [`之前生成的文件：${names(input.artifacts)}`] : []),
    '请在此基础上继续完成下面的新要求，不要重复已经完成的工作。',
  ].join('\n');
  const lines = input.conversation.map(
    (turn) => `${turn.role === 'user' ? '用户' : '智能体'}：${clip(turn.content)}`,
  );
  // 超出上限时保留最近的对话。
  const budget = BRIEF_LIMIT - head.length - tail.length - 64;
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + 1;
    if (used + cost > budget) break;
    kept.unshift(lines[i]!);
    used += cost;
  }
  const omitted = kept.length < lines.length;
  return [
    head,
    kept.length
      ? `之前的对话（从旧到新${omitted ? '，更早的内容已省略' : ''}）：`
      : '之前的对话过长，已省略。',
    ...kept,
    tail,
  ].join('\n');
}
