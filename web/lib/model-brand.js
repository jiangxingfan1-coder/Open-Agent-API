// Presentation only. These aliases never determine model availability or routing.
export function modelBrand(model) {
  const name = String(model ?? '')
    .toLowerCase()
    .split('/')
    .pop();
  if (/^(claude|sonnet|haiku|opus)(?:[-_. ]|$)/.test(name)) return 'claude';
  if (/^(gemini|gemma)(?:[-_. ]|$)/.test(name)) return 'gemini';
  if (/^(gpt|chatgpt|codex|o[134])(?:[-_. ]|$)/.test(name)) return 'openai';
  if (/^deepseek(?:[-_. ]|$)/.test(name)) return 'deepseek';
  if (/^qwen(?:\d|[-_. ]|$)/.test(name)) return 'qwen';
  if (/^(kimi|moonshot)(?:[-_. ]|$)/.test(name)) return 'kimi';
  if (/^grok(?:[-_. ]|$)/.test(name)) return 'grok';
  if (/^(mistral|codestral|devstral|magistral|ministral)(?:[-_. ]|$)/.test(name)) return 'mistral';
  if (/^minimax(?:[-_. ]|$)/.test(name)) return 'minimax';
  if (/^(glm|zai)(?:[-_. ]|$)/.test(name)) return 'zai';
  if (/^llama(?:\d|[-_. ]|$)/.test(name)) return 'meta';
  return null;
}
