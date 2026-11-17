/**
 * Model provider presets for `oaa connect <preset>`: data only, so adding a service is one entry.
 * Every endpoint and difference here was checked against the service's own documentation
 * (docs/models.md lists the sources and what was left out). Addresses are fixed in code and are
 * never fetched from the network. Model names change often, so at most one suggestion is kept and
 * `--model` always wins; `model: undefined` means the user must name one.
 */
import type { ProviderConfig } from '../config/config.js';
import { MODEL_RUNTIMES } from '../config/model-runtimes.js';

export type ProviderPreset = {
  /** Preset name used on the command line; must not collide with external agent names. */
  id: string;
  label: string;
  kind: ProviderConfig['kind'];
  baseUrl: string;
  /** Local service on the loopback interface: no key, probed automatically. */
  local: boolean;
  /** Suggested environment variable for the key (undefined: the service needs no key). */
  keyEnv?: string;
  imageInput?: ProviderConfig['imageInput'];
  maxTokensField?: ProviderConfig['maxTokensField'];
  /** false: the service does not document `stream_options.include_usage`. */
  streamUsage?: boolean;
  /** A model name the docs listed when this entry was checked; undefined: `--model` required. */
  model?: string;
  docs: string;
  /** OpenAI-compatible model listing (relative to baseUrl) for `--check` / local probes. */
  modelsPath?: string;
  note?: { zh: string; en: string };
};

const P = (preset: ProviderPreset) => preset;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  ...MODEL_RUNTIMES.map((runtime) =>
    P({
      id: runtime.id,
      label: runtime.name,
      kind: 'openai-chat',
      baseUrl: runtime.baseUrl,
      local: true,
      imageInput: runtime.id === 'ollama' ? 'inline' : 'none',
      maxTokensField: 'max_tokens',
      ...(['jan', 'gpt4all'].includes(runtime.id) ? { streamUsage: false } : {}),
      docs: runtime.docs,
      modelsPath: 'models',
    }),
  ),
  P({
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    kind: 'openai-chat',
    baseUrl: '',
    local: false,
    keyEnv: 'OPENAI_COMPATIBLE_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    modelsPath: 'models',
    note: {
      zh: '需要 --base-url；不带 --key-env / --key-file 时按无密钥服务处理。',
      en: 'Needs --base-url; without --key-env / --key-file the endpoint is treated as keyless.',
    },
  }),
  P({
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    local: false,
    keyEnv: 'OPENAI_API_KEY',
    imageInput: 'url',
    docs: 'https://platform.openai.com/docs/api-reference/responses',
    modelsPath: 'models',
  }),
  P({
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    local: false,
    keyEnv: 'ANTHROPIC_API_KEY',
    imageInput: 'url',
    model: 'claude-sonnet-5-5',
    docs: 'https://platform.claude.com/docs/en/api/messages',
  }),
  P({
    id: 'gemini-api',
    label: 'Google Gemini API',
    kind: 'gemini-generate',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    local: false,
    keyEnv: 'GEMINI_API_KEY',
    imageInput: 'inline',
    docs: 'https://ai.google.dev/gemini-api/docs',
  }),
  P({
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    local: false,
    keyEnv: 'OPENROUTER_API_KEY',
    imageInput: 'url',
    maxTokensField: 'max_tokens',
    docs: 'https://openrouter.ai/docs/api/reference/overview',
    modelsPath: 'models',
  }),
  P({
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    local: false,
    keyEnv: 'DEEPSEEK_API_KEY',
    imageInput: 'url',
    maxTokensField: 'max_tokens',
    model: 'deepseek-flash',
    docs: 'https://api-docs.deepseek.com/api/create-chat-completion',
    modelsPath: 'models',
  }),
  P({
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    kind: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    local: false,
    keyEnv: 'MOONSHOT_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    docs: 'https://platform.kimi.com/docs/guide/start-using-kimi-api',
    modelsPath: 'models',
  }),
  P({
    id: 'zhipu',
    label: 'Zhipu (BigModel)',
    kind: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    local: false,
    keyEnv: 'ZHIPU_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    model: 'glm-5.3',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  }),
  P({
    id: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    local: false,
    keyEnv: 'SILICONFLOW_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    docs: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',
    modelsPath: 'models',
  }),
  P({
    id: 'groq',
    label: 'Groq',
    kind: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    local: false,
    keyEnv: 'GROQ_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_completion_tokens',
    streamUsage: false,
    docs: 'https://console.groq.com/docs/openai',
    modelsPath: 'models',
  }),
  P({
    id: 'together',
    label: 'Together AI',
    kind: 'openai-chat',
    baseUrl: 'https://api.together.ai/v1',
    local: false,
    keyEnv: 'TOGETHER_API_KEY',
    imageInput: 'url',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    docs: 'https://docs.together.ai/docs/openai-api-compatibility',
    modelsPath: 'models',
  }),
  P({
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    local: false,
    keyEnv: 'MISTRAL_API_KEY',
    imageInput: 'none',
    maxTokensField: 'max_tokens',
    streamUsage: false,
    docs: 'https://docs.mistral.ai/api/',
    modelsPath: 'models',
  }),
];

export function findPreset(name: string): ProviderPreset | undefined {
  const key = name.trim().toLowerCase();
  return PROVIDER_PRESETS.find((p) => p.id === key);
}

/** The provider entry written to `localWorker.providers` (key reference only, never the key). */
export function presetProviderEntry(
  preset: ProviderPreset,
  options: { baseUrl?: string; keyEnv?: string; keyFile?: string },
): Record<string, unknown> {
  const keyless =
    !options.keyEnv &&
    !options.keyFile &&
    (preset.local || !preset.keyEnv || preset.id === 'openai-compatible');
  return {
    kind: preset.kind,
    baseUrl: options.baseUrl ?? preset.baseUrl,
    ...(keyless
      ? { apiKeyEnv: '', noApiKey: true }
      : options.keyFile
        ? { apiKeyEnv: '', apiKeyFile: options.keyFile }
        : { apiKeyEnv: options.keyEnv ?? preset.keyEnv }),
    ...(preset.maxTokensField ? { maxTokensField: preset.maxTokensField } : {}),
    ...(preset.imageInput ? { imageInput: preset.imageInput } : {}),
    ...(preset.streamUsage === false ? { streamUsage: false } : {}),
    preset: preset.id,
  };
}
