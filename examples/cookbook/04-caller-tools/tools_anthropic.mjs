// Let the agent call a function in YOUR program (caller tools), with the Anthropic Node SDK, Messages.
//
// What it shows: you declare `tools` as for Claude. When the agent wants one, the response ends with
// stop_reason "tool_use"; you run the function and answer with a `tool_result` block, and the SAME run carries on.
// Needs:    npm install @anthropic-ai/sdk   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
//           The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
// Run:      node tools_anthropic.mjs
// Note:     the tool_use id looks like "call_..." (not "toolu_..."); treat it as an opaque string.
import Anthropic from '@anthropic-ai/sdk';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'What is the weather in Paris right now? Use the get_weather tool.';

const client = new Anthropic({ baseURL: BASE, apiKey: KEY, maxRetries: 0, timeout: 300_000 });

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Get the current weather of a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name, e.g. Paris' } },
      required: ['city'],
    },
  },
];

/** Your functions. They run in your process, with your data and your credentials. */
const FUNCTIONS = {
  get_weather: ({ city }) => ({ city, temperature_c: 21, sky: 'sunny' }),
};

const messages = [{ role: 'user', content: PROMPT }];
let callsMade = 0;
let answered = false;
for (let turn = 0; turn < 8; turn++) {
  // A safety bound on the loop. withResponse() also gives the headers.
  const { data: message, response } = await client.messages
    .create({ model: AGENT, max_tokens: 1024, tools: TOOLS, messages })
    .withResponse();
  if (turn === 0) {
    const mode = response.headers.get('x-oaa-client-tools');
    console.log('X-OAA-Client-Tools:', mode);
    if (mode !== 'bridge') {
      console.error(`this agent did not take the tools over (${mode}); use a built-in agent for this recipe`);
      process.exit(2);
    }
  }
  if (message.stop_reason !== 'tool_use') {
    console.log('answer:', message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    answered = true;
    break;
  }
  // Keep the assistant turn (text and tool_use blocks), then answer every tool_use in ONE user message.
  messages.push({ role: 'assistant', content: message.content });
  const results = [];
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue;
    const result = FUNCTIONS[block.name](block.input);
    callsMade++;
    console.log(`tool call: ${block.name}(${JSON.stringify(block.input)}) -> ${JSON.stringify(result)}`);
    results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
  }
  messages.push({ role: 'user', content: results });
}
if (!answered) {
  console.error('the agent kept calling tools; stopping');
  process.exit(1);
}
if (callsMade === 0) {
  console.error('the agent did not call your tool; this recipe needs an agent that does');
  process.exit(3);
}
console.log('ok');
