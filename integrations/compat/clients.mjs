// Registry of the live clients the compatibility lab runs against the gateway.
// `runtime: 'python'` scripts run with the lab's Python (COMPAT_PYTHON, else .venv, else python3);
// `runtime: 'node'` scripts run with the current Node and resolve packages from integrations/compat/node_modules.
// The request-shape replays of chat clients (replays/*.json) are not listed here: run.mjs loads them itself.
export const CLIENTS = [
  { id: 'openai-python', label: 'openai (Python SDK)', group: 'official-sdk', runtime: 'python', script: 'clients/openai_py.py' },
  { id: 'anthropic-python', label: 'anthropic (Python SDK)', group: 'official-sdk', runtime: 'python', script: 'clients/anthropic_py.py' },
  { id: 'google-genai-python', label: 'google-genai (Python SDK)', group: 'official-sdk', runtime: 'python', script: 'clients/genai_py.py' },
  { id: 'openai-node', label: 'openai (Node SDK)', group: 'official-sdk', runtime: 'node', script: 'clients/openai_node.mjs' },
  { id: 'anthropic-node', label: '@anthropic-ai/sdk (Node SDK)', group: 'official-sdk', runtime: 'node', script: 'clients/anthropic_node.mjs' },
  { id: 'google-genai-node', label: '@google/genai (Node SDK)', group: 'official-sdk', runtime: 'node', script: 'clients/genai_node.mjs' },
  { id: 'vercel-ai-sdk', label: 'Vercel AI SDK (ai + @ai-sdk/*)', group: 'framework', runtime: 'node', script: 'clients/ai_sdk.mjs' },
  { id: 'langchain-python', label: 'LangChain (langchain-openai, langchain-anthropic)', group: 'framework', runtime: 'python', script: 'clients/langchain_py.py' },
  { id: 'litellm-python', label: 'LiteLLM (Python)', group: 'framework', runtime: 'python', script: 'clients/litellm_py.py' },
  { id: 'openai-agents-python', label: 'OpenAI Agents SDK (Python)', group: 'framework', runtime: 'python', script: 'clients/agents_py.py' },
  { id: 'llamaindex-python', label: 'LlamaIndex (OpenAI-like)', group: 'framework', runtime: 'python', script: 'clients/llamaindex_py.py' },
];
