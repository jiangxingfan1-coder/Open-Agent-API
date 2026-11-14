// Send a local image to an agent with the Google GenAI Node SDK (generateContent).
//
// What it shows: an `inlineData` part with the file's base64 bytes (a `fileData` part with an https URL or an
// uploaded `oaa://files/<id>` works too, see docs/images.md). The gateway checks the real bytes: only PNG, JPEG, GIF
// and WebP are accepted and the declared mime type must match them. An agent that cannot use images refuses the
// request clearly (400) before a run exists.
// Needs:    npm install @google/genai   and   OAA_API_KEY      optional: OAA_BASE_URL, OAA_AGENT, OAA_PROMPT
// Agent:    one that takes images (`GET /v1/models` shows `image_input`). The offline sample agent accepts the
//           image but its fixed answer does not describe it.
// Run:      node image_genai.mjs [path/to/image.png]        (default: sample.png next to this script)
// Exit:     0 = answered; 2 = the request was refused (for example an agent without image input).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, GoogleGenAI } from '@google/genai';

const BASE = (process.env.OAA_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const KEY = process.env.OAA_API_KEY;
if (!KEY) throw new Error('Set OAA_API_KEY first (see the cookbook README).');
const AGENT = process.env.OAA_AGENT ?? 'agent/sample';
const PROMPT = process.env.OAA_PROMPT ?? 'Describe this image in one sentence.';
const FILE = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample.png');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const mimeType = MIME[path.extname(FILE).toLowerCase()] ?? 'image/png';
const data = (await readFile(FILE)).toString('base64');

const client = new GoogleGenAI({ apiKey: KEY, httpOptions: { baseUrl: BASE, apiVersion: 'v1beta' } });

try {
  const response = await client.models.generateContent({
    model: AGENT,
    contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { mimeType, data } }] }],
  });
  console.log('generateContent:', response.text);
} catch (error) {
  if (error instanceof ApiError && error.status === 400) {
    // The SDK puts the gateway's JSON error body in `message`.
    let detail = error.message;
    try {
      detail = JSON.parse(detail).error.message;
    } catch {
      // not JSON: keep the text
    }
    console.error(`refused (${error.status}): ${detail}`);
    process.exit(2);
  }
  throw error;
}
console.log('ok');
