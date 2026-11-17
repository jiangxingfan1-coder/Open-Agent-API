import path from 'node:path';

/** Installation evidence only. Model servers are probed separately, never launched by discovery. */
export const MODEL_RUNTIMES = [
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    docs: 'https://docs.ollama.com/api/openai-compatibility',
    commands: ['ollama'],
    apps: ['Ollama.app'],
    download: 'https://ollama.com/download',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    docs: 'https://lmstudio.ai/docs/developer/openai-compat',
    commands: ['lms', 'llmster'],
    apps: ['LM Studio.app'],
    download: 'https://lmstudio.ai/download',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    docs: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
    commands: ['llama-server'],
    apps: [],
    download: 'https://github.com/ggml-org/llama.cpp/releases',
  },
  {
    id: 'jan',
    name: 'Jan',
    baseUrl: 'http://127.0.0.1:1337/v1',
    docs: 'https://docs.jan.ai/desktop/api-server',
    commands: ['jan'],
    apps: ['Jan.app'],
    download: 'https://jan.ai/download',
  },
  {
    id: 'gpt4all',
    name: 'GPT4All',
    baseUrl: 'http://127.0.0.1:4891/v1',
    docs: 'https://docs.gpt4all.io/gpt4all_api_server/home.html',
    commands: ['gpt4all'],
    apps: ['GPT4All.app'],
    download: 'https://www.nomic.ai/gpt4all',
  },
  {
    id: 'localai',
    name: 'LocalAI',
    baseUrl: 'http://127.0.0.1:8080/v1',
    docs: 'https://localai.io/docs/features/text-generation/',
    commands: ['local-ai'],
    apps: [],
    download: 'https://localai.io/docs/getting-started/',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000/v1',
    docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server/',
    commands: ['vllm'],
    apps: [],
    download: 'https://docs.vllm.ai/en/latest/getting_started/installation/',
  },
] as const;

export function modelRuntimeDirs(home: string, platform: NodeJS.Platform): string[] {
  return [
    path.join(home, '.lmstudio/bin'),
    path.join(home, '.cache/lm-studio/bin'),
    ...(platform === 'darwin'
      ? ['/Applications', path.join(home, 'Applications')].flatMap((root) => [
          path.join(root, 'Ollama.app/Contents/Resources'),
          path.join(root, 'GPT4All.app/Contents/MacOS'),
        ])
      : platform === 'win32'
        ? [
            path.join(home, 'AppData/Local/Programs/Ollama'),
            path.join(home, 'AppData/Local/Programs/LM Studio'),
            path.join(home, 'AppData/Local/Programs/jan'),
          ]
        : []),
  ];
}
