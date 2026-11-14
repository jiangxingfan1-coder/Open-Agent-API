/**
 * 内置原生接入（Antigravity、Codex）用来解读智能体信号的措辞表与映射表。
 */
/** How Antigravity words a denied operation, on stderr or in a tool step's `tool_info.error`. */
export const DENIAL = /soft.denied|permission.+denied|requires approval/i;
export const errorText = (error: unknown) =>
  (typeof error === 'string' ? error : (JSON.stringify(error) ?? '')).slice(0, 4096);

/** Codex item types that are tool activity (`kind: "tool"`); every other item is `kind: "status"`. */
export const CODEX_TOOL_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
]);
