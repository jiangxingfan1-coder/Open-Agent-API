// Let the agent call a function in YOUR program (caller tools), with the Google GenAI Node SDK.
//
// What it shows: you declare `functionDeclarations` as for Gemini. When the agent wants one, the response carries
// function calls; you run the function and answer with a `functionResponse` part, and the SAME run carries on.
// Needs:    npm install @google/genai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that can take your tools over: a built-in (kernel) agent, or an ACP agent that supports MCP.
//           The offline sample agent (agent/sample) never calls your tools, so it cannot show this recipe.
// Run:      node tools_genai.mjs
import { GoogleGenAI } from '@google/genai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'What is the weather in Paris right now? Use the get_weather tool.';

const client = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: BASE, apiVersion: 'v1beta' } });

const config = {
  tools: [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get the current weather of a city.',
          parameters: {
            type: 'OBJECT',
            properties: { city: { type: 'STRING', description: 'City name, e.g. Paris' } },
            required: ['city'],
          },
        },
      ],
    },
  ],
};

/** Your functions. They run in your process, with your data and your credentials. */
const FUNCTIONS = {
  get_weather: ({ city }) => ({ city, temperature_c: 21, sky: 'sunny' }),
};

const contents = [{ role: 'user', parts: [{ text: PROMPT }] }];
let callsMade = 0;
let answered = false;
for (let turn = 0; turn < 8; turn++) {
  // A safety bound on the loop.
  const response = await client.models.generateContent({ model: AGENT, contents, config });
  const calls = response.functionCalls ?? [];
  if (!calls.length) {
    console.log('answer:', response.text);
    answered = true;
    break;
  }
  // Keep the model turn (with its function calls) in the history, then answer every call in one user turn.
  contents.push(response.candidates[0].content);
  const parts = [];
  for (const call of calls) {
    const result = FUNCTIONS[call.name](call.args);
    callsMade++;
    console.log(`tool call: ${call.name}(${JSON.stringify(call.args)}) -> ${JSON.stringify(result)}`);
    parts.push({ functionResponse: { id: call.id, name: call.name, response: { output: result } } });
  }
  contents.push({ role: 'user', parts });
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
