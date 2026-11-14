// Let the agent call a function in YOUR program (caller tools), with the OpenAI Node SDK, Chat Completions.
//
// What it shows: you declare `tools` exactly as you would for a model. When the agent wants one, the response
// ends with finish_reason "tool_calls"; you run the function and send the result back as a `tool` message, and the
// SAME run carries on (same run id, no replay). The loop ends when the agent answers without a tool call.
// Needs:    npm install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
//           The response header X-OAA-Client-Tools says what happened: "bridge" = handed to the agent,
//           "ignored" = this agent has its own tools and does not use yours (the script stops with a message).
//           The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
// Run:      node tools_openai.mjs
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'What is the weather in Paris right now? Use the get_weather tool.';

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 300_000 });

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather of a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name, e.g. Paris' } },
        required: ['city'],
      },
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
  let completion, response;
  try {
    ({ data: completion, response } = await client.chat.completions
      .create({ model: AGENT, messages, tools: TOOLS })
      .withResponse());
  } catch (error) {
    // A native engine (Codex, Claude Code, ...) runs its own tool loop and cannot take yours: the gateway
    // refuses clearly (400 unsupported_parameter) and names the ways out.
    if (error instanceof OpenAI.BadRequestError) {
      console.error(`this agent cannot take caller tools over: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  if (turn === 0) {
    const mode = response.headers.get('x-oaa-client-tools');
    console.log('X-OAA-Client-Tools:', mode);
    if (mode !== 'bridge') {
      console.error(`this agent did not take the tools over (${mode}); use a built-in agent for this recipe`);
      process.exit(2);
    }
  }
  const choice = completion.choices[0];
  if (choice.finish_reason !== 'tool_calls') {
    console.log('answer:', choice.message.content);
    answered = true;
    break;
  }
  // Keep the assistant turn in the history, then answer every call it made (parallel calls arrive together).
  messages.push(choice.message);
  for (const call of choice.message.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    const result = FUNCTIONS[call.function.name](args);
    callsMade++;
    console.log(`tool call: ${call.function.name}(${JSON.stringify(args)}) -> ${JSON.stringify(result)}`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
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
