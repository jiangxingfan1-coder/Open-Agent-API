// Send a local image to an agent with the OpenAI Node SDK (Chat Completions and Responses).
//
// What it shows: the image travels inline as a base64 `data:` URL (an https URL or an uploaded file id work too, see
// docs/images.md). The gateway checks the real bytes: only PNG, JPEG, GIF and WebP are accepted, the declared type
// must match the bytes (`image_invalid` otherwise), and an agent that cannot use images refuses the request clearly
// (400 `unsupported_content`, `error.param` names the part) before a run exists.
// Needs:    npm install openai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
//           image but its fixed answer does not describe it.
// Run:      node image_openai.mjs [path/to/image.png]        (default: sample.png next to this script)
// Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Describe this image in one sentence.';
const FILE = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.png');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const mime = MIME[path.extname(FILE).toLowerCase()] ?? 'image/png';
const dataUrl = `data:${mime};base64,${(await readFile(FILE)).toString('base64')}`;

const client = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: KEY, maxRetries: 0, timeout: 300_000 });

try {
  // Chat Completions: an `image_url` content part next to the text.
  const chat = await client.chat.completions.create({
    model: AGENT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  console.log('chat:', chat.choices[0].message.content);

  // Responses: an `input_image` part.
  const response = await client.responses.create({
    model: AGENT,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT },
          { type: 'input_image', image_url: dataUrl },
        ],
      },
    ],
  });
  console.log('responses:', response.output_text);
} catch (error) {
  if (error instanceof OpenAI.BadRequestError) {
    console.error(`refused (${error.code}, param ${error.param}): ${error.message}`);
    process.exit(2);
  }
  throw error;
}
console.log('ok');
