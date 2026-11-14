// Send a local image to an agent with the Anthropic Node SDK (Messages).
//
// What it shows: an `image` content block with a base64 source (a `url` or an uploaded `file` source work too, see
// docs/images.md). The gateway checks the real bytes: only PNG, JPEG, GIF and WebP are accepted and the declared
// `media_type` must match them (`image_invalid` otherwise). An agent that cannot use images refuses the request
// clearly (400 `unsupported_content`) before a run exists.
// Needs:    npm install @anthropic-ai/sdk   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
//           image but its fixed answer does not describe it.
// Run:      node image_anthropic.mjs [path/to/image.png]        (default: sample.png next to this script)
// Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Describe this image in one sentence.';
const FILE = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.png');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const mediaType = MIME[path.extname(FILE).toLowerCase()] ?? 'image/png';
const data = (await readFile(FILE)).toString('base64');

const client = new Anthropic({ baseURL: BASE, apiKey: KEY, maxRetries: 0, timeout: 300_000 });

try {
  const message = await client.messages.create({
    model: AGENT,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  console.log('messages:', message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
} catch (error) {
  if (error instanceof Anthropic.BadRequestError) {
    console.error(`refused: ${error.error?.error?.message ?? error.message}`);
    process.exit(2);
  }
  throw error;
}
console.log('ok');
