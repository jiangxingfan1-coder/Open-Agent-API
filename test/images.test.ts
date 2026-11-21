/**
 * Image input (docs/images.md): parsing of every entry, format sniffing and limits, URL policy,
 * capability-based routing, provider wire shapes, ACP image blocks and the workspace-file
 * fallback, continuation, quota and access control. Offline: the gateway runs through
 * `app.inject`, the model is a deterministic fixture that echoes what it received, and the ACP
 * agent is the local stdio fixture.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { agent, FixtureModel, principal, secondToken, token, waitFor } from './helpers.js';
import { makeBundle } from '../src/lang/bundle.js';
import { gatewaySchema, workerSchema } from '../src/config/config.js';
import { WorkerRuntime } from '../src/fabric/worker.js';
import { createGateway } from '../src/gateway/server.js';
import type { ModelImage, ModelMessage, NodeAdvertisement } from '../src/core/contracts.js';
import { decodeImageData } from '../src/gateway/image-input.js';
import { normalizeImageType, sniffImage } from '../src/gateway/image-sniff.js';
import {
  claudeImage,
  geminiImage,
  nativeImage,
  openAIImage,
  splitDataUrl,
} from '../src/gateway/image-parts.js';
import { checkFetchedImage, checkImageUrl, fetchImage } from '../src/gateway/image-fetch.js';
import type { ImageInput } from '../src/kernel/invocation.js';
import {
  anthropicUserBlocks,
  chatUserContent,
  geminiUserParts,
  providerImageInput,
  responsesUserContent,
  withImageData,
} from '../src/providers/image-wire.js';
import { imagesSupported, modelPlacement } from '../src/fabric/placement.js';
import { advertisedExecution } from '../src/fabric/network.js';
import { imageInputAdvert, imageNote } from '../src/fabric/image-capabilities.js';
import { conversionProfile } from '../src/engines/conformance.js';
import {
  acpImageBlocks,
  claudePrompt,
  codexInput,
  imageDeliveryHint,
  workspaceImagePath,
} from '../src/engines/image-blocks.js';
import { Fault } from '../src/core/util.js';

// A real 1x1 PNG and the leading bytes of the other accepted formats.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B64 = PNG.toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);

const code =
  (expected: string, param?: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof Fault, String(error));
    assert.equal(error.code, expected, error.message);
    if (param) assert.equal((error as { param?: string }).param, param);
    return true;
  };

test('images: format sniffing accepts PNG, JPEG, GIF and WebP only', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(GIF), 'image/gif');
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7 not an image')), undefined);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(normalizeImageType('IMAGE/JPG'), 'image/jpeg');
  assert.equal(normalizeImageType('image/svg+xml'), undefined);
});

test('images: inline data is size-checked before decoding and must match its declared type', () => {
  const limits = { maxImageBytes: 1024 };
  assert.equal(decodeImageData(PNG_B64, 'image/png', 'p', limits).mime, 'image/png');
  assert.equal(decodeImageData(PNG_B64, undefined, 'p', limits).bytes.length, PNG.length);
  // URL-safe alphabet without padding (google-genai) decodes to the same bytes.
  const urlSafe = PNG.toString('base64url');
  assert.deepEqual(decodeImageData(urlSafe, 'image/png', 'p', limits).bytes, PNG);
  // Far over the limit: refused by length alone (a 1 MiB string is never decoded).
  assert.throws(
    () => decodeImageData('A'.repeat(1024 * 1024), 'image/png', 'p', limits),
    code('image_too_large', 'p'),
  );
  assert.throws(
    () => decodeImageData('not base64!', undefined, 'p', limits),
    code('image_invalid'),
  );
  assert.throws(
    () =>
      decodeImageData(Buffer.from('plain text here!').toString('base64'), undefined, 'p', limits),
    code('image_invalid'),
  );
  assert.throws(
    () => decodeImageData(PNG_B64, 'image/jpeg', 'messages.0.content.1', limits),
    (e: unknown) =>
      code('image_invalid', 'messages.0.content.1')(e) && /does not match/.test(String(e)),
  );
  assert.throws(
    () => decodeImageData(PNG_B64, 'image/svg+xml', 'p', limits),
    code('image_invalid'),
  );
});

test('images: every entry normalizes its image parts and leaves a marker in the text', () => {
  const images: ImageInput[] = [];
  assert.equal(
    openAIImage(
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      'a',
      images,
    ),
    '[Image #1]',
  );
  openAIImage({ type: 'image_url', image_url: 'https://img.example/x.png' }, 'b', images);
  openAIImage({ type: 'input_image', file_id: 'file_1' }, 'c', images);
  openAIImage({ type: 'input_image', image_url: `data:image/jpeg;base64,${PNG_B64}` }, 'd', images);
  claudeImage(
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    'e',
    images,
  );
  claudeImage(
    { type: 'image', source: { type: 'url', url: 'https://img.example/y.png' } },
    'f',
    images,
  );
  claudeImage({ type: 'image', source: { type: 'file', file_id: 'file_2' } }, 'g', images);
  geminiImage({ inlineData: { mimeType: 'image/webp', data: PNG_B64 } }, 'h', images);
  geminiImage({ fileData: { fileUri: 'oaa://files/file_3', mimeType: 'image/png' } }, 'i', images);
  geminiImage(
    { fileData: { fileUri: 'https://img.example/z.png', mimeType: 'image/png' } },
    'j',
    images,
  );
  nativeImage({ data: PNG_B64, media_type: 'image/png' }, 'k', images);
  assert.deepEqual(
    images.map((i) =>
      'data' in i ? `data:${i.media_type}` : 'url' in i ? `url:${i.url}` : `file:${i.file_id}`,
    ),
    [
      'data:image/png',
      'url:https://img.example/y.png'.replace('y', 'x'),
      'file:file_1',
      'data:image/jpeg',
      'data:image/png',
      'url:https://img.example/y.png',
      'file:file_2',
      'data:image/webp',
      'file:file_3',
      'url:https://img.example/z.png',
      'data:image/png',
    ],
  );
  assert.deepEqual(
    images.map((i) => i.param),
    [...'abcdefghijk'],
  );
  // A non-image fileData stays a plain attachment; a non-image inlineData is refused.
  assert.equal(
    geminiImage({ fileData: { fileUri: 'oaa://files/f', mimeType: 'text/plain' } }, 'x', []),
    undefined,
  );
  assert.throws(
    () => geminiImage({ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }, 'x', []),
    code('unsupported_content', 'x'),
  );
  assert.throws(() => splitDataUrl('data:image/png,rawbytes', 'x'), code('image_invalid', 'x'));
  // Only the header of a huge data: URL is inspected.
  assert.equal(
    splitDataUrl(`data:image/png;base64,${'A'.repeat(4_000_000)}`, 'x').media_type,
    'image/png',
  );
});

test('images: URL policy — https only, no credentials, public profile refuses private addresses', () => {
  assert.throws(
    () => checkImageUrl('http://img.example/a.png', { profile: 'local' }, 'u'),
    code('image_invalid', 'u'),
  );
  assert.throws(
    () => checkImageUrl('https://u:p@img.example/a.png', { profile: 'local' }, 'u'),
    code('image_invalid'),
  );
  assert.equal(
    checkImageUrl('https://127.0.0.1/a.png', { profile: 'local' }, 'u').hostname,
    '127.0.0.1',
  );
  for (const host of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '[::1]', 'localhost'])
    assert.throws(
      () => checkImageUrl(`https://${host}/a.png`, { profile: 'public' }, 'u'),
      code('image_fetch_failed', 'u'),
      host,
    );
  assert.equal(
    checkImageUrl('https://93.184.216.34/a.png', { profile: 'public' }, 'u').protocol,
    'https:',
  );
  assert.throws(
    () => checkFetchedImage(302, { location: 'https://x' }, Buffer.alloc(0), 'u'),
    /redirects are not followed/,
  );
  assert.throws(
    () => checkFetchedImage(200, { 'content-type': 'text/html' }, PNG, 'u'),
    code('image_fetch_failed'),
  );
  assert.throws(
    () => checkFetchedImage(200, { 'content-type': 'image/jpeg' }, PNG, 'u'),
    /does not match/,
  );
  assert.equal(
    checkFetchedImage(200, { 'content-type': 'image/png; q=1' }, PNG, 'u').mime,
    'image/png',
  );
});

/** A stand-in for https.request: answers once with the given status, headers and body. */
function fakeTransport(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  seen: RequestOptions[] = [],
) {
  return ((_url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    seen.push(options);
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      const res = new EventEmitter() as IncomingMessage;
      res.statusCode = status;
      res.headers = headers;
      res.resume = () => res;
      res.destroy = () => res;
      queueMicrotask(() => {
        callback(res);
        res.emit('data', body);
        res.emit('end');
      });
      return req;
    }) as ClientRequest['end'];
    req.destroy = () => req;
    return req;
  }) as unknown as typeof import('node:https').request;
}

test('images: gateway fetch (opt-in) checks the answer, caps bytes and never follows redirects', async () => {
  const policy = { profile: 'public' as const, maxBytes: 1024, timeoutMs: 2000 };
  const seen: RequestOptions[] = [];
  const ok = await fetchImage(
    'https://img.example/a.png',
    policy,
    'u',
    fakeTransport(200, { 'content-type': 'image/png' }, PNG, seen),
  );
  assert.equal(ok.mime, 'image/png');
  assert.equal(typeof seen[0]!.lookup, 'function', 'the connection uses the checked lookup');
  assert.equal(seen[0]!.agent, false);
  await assert.rejects(
    fetchImage(
      'https://img.example/a.png',
      policy,
      'u',
      fakeTransport(301, { location: 'https://evil' }, Buffer.alloc(0)),
    ),
    code('image_fetch_failed', 'u'),
  );
  await assert.rejects(
    fetchImage(
      'https://img.example/a.png',
      policy,
      'u',
      fakeTransport(200, { 'content-type': 'image/png' }, Buffer.alloc(4096)),
    ),
    code('image_too_large', 'u'),
  );
  // The checked lookup refuses a name that resolves to a loopback address under `public`.
  const lookup = seen[0]!.lookup!;
  const denied = await new Promise<unknown>((resolve) =>
    lookup('localhost', { all: true }, (error) => resolve(error)),
  );
  assert.ok(denied instanceof Error);
});

test('images: provider wire shapes for OpenAI Responses / Chat, Anthropic and Gemini', () => {
  const file: ModelImage = { kind: 'file', fileId: 'file_a', mime: 'image/png' };
  const url: ModelImage = { kind: 'url', url: 'https://img.example/a.png' };
  const [m] = withImageData(
    [{ role: 'user', content: 'look', images: [file, url] }],
    [{ id: 'file_a', name: 'image-1.png', content: PNG_B64, sha256: '' }],
  ) as [ModelMessage];
  assert.deepEqual(responsesUserContent(m), [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: `data:image/png;base64,${PNG_B64}` },
    { type: 'input_image', image_url: 'https://img.example/a.png' },
  ]);
  assert.deepEqual(chatUserContent(m), [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    { type: 'image_url', image_url: { url: 'https://img.example/a.png' } },
  ]);
  assert.deepEqual(anthropicUserBlocks(m).slice(1), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    { type: 'image', source: { type: 'url', url: 'https://img.example/a.png' } },
  ]);
  assert.deepEqual(geminiUserParts({ ...m, images: [m.images![0]!] })[1], {
    inlineData: { mimeType: 'image/png', data: PNG_B64 },
  });
  assert.throws(() => geminiUserParts(m), code('image_invalid'));
  // A text-only message is unchanged.
  assert.equal(chatUserContent({ role: 'user', content: 'hi' }), 'hi');
  assert.throws(
    () => withImageData([{ role: 'user', content: '', images: [file] }], []),
    code('file_not_found'),
  );
  // Defaults by provider kind; an explicit setting wins.
  const p = (kind: string, imageInput?: string) =>
    providerImageInput(
      workerSchema.parse({
        nodeId: 'n',
        dataDir: 'd',
        providers: { x: { kind, ...(imageInput ? { imageInput } : {}) } },
      }).providers.x!,
    );
  assert.deepEqual(
    ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate'].map((k) => p(k)),
    ['none', 'url', 'url', 'inline'],
  );
  assert.equal(p('openai-chat', 'inline'), 'inline');
});

test('images: placement requires image-input-v1 for the provider or engine; old nodes never qualify', () => {
  const advert = (
    imageInput?: NodeAdvertisement['execution'] extends infer E
      ? E extends { imageInput?: infer I }
        ? I
        : never
      : never,
  ): NodeAdvertisement => ({
    nodeId: 'n1',
    providers: ['vision', 'inline', 'text'],
    natives: ['adapter/acp', 'adapter/a2a'],
    capabilities: [],
    warm: [],
    concurrency: 1,
    execution: {
      builtins: [],
      scripts: [],
      toolSelection: true,
      nativeModels: {},
      ...(imageInput ? { imageInput } : {}),
    },
  });
  const caps = {
    providers: { vision: 'url' as const, inline: 'inline' as const, text: 'none' as const },
    native: { 'adapter/acp': 'agent-declared' as const },
  };
  const kernel = (provider: string) => agent({ provider });
  assert.equal(imagesSupported(advert(caps), kernel('vision'), 'url'), true);
  assert.equal(imagesSupported(advert(caps), kernel('inline'), 'inline'), true);
  assert.equal(imagesSupported(advert(caps), kernel('inline'), 'url'), false);
  assert.equal(imagesSupported(advert(caps), kernel('text'), 'inline'), false);
  assert.equal(imagesSupported(advert(caps), agent({ engine: 'adapter/acp' }), 'inline'), true);
  assert.equal(imagesSupported(advert(caps), agent({ engine: 'adapter/acp' }), 'url'), false);
  assert.equal(imagesSupported(advert(caps), agent({ engine: 'adapter/a2a' }), 'inline'), false);
  assert.equal(imagesSupported(advert(), kernel('vision'), 'inline'), false, 'an older node');
  const reasons = modelPlacement(
    { owner: 'owner', agent: kernel('text'), files: [], images: 'inline' },
    {
      credential: { nodeId: 'n1', owner: 'owner', token: 't', capabilities: ['*'], agents: ['*'] },
      advertisement: advert(caps),
    },
  );
  assert.ok(reasons.some((r) => r.code === 'image_input_unsupported'));
  // The worker sends imageInput only after the gateway offered image-input-v1.
  const full = advert(caps).execution!;
  assert.equal(advertisedExecution(full, { byok: false, sandbox: false })!.imageInput, undefined);
  assert.deepEqual(
    advertisedExecution(full, { byok: false, sandbox: false, imageInput: true })!.imageInput,
    caps,
  );
});

test('images: worker declaration, conversion profile and the workspace note', () => {
  const worker = workerSchema.parse({
    nodeId: 'n',
    dataDir: 'd',
    providers: { oa: { kind: 'openai-responses' }, chat: { kind: 'openai-chat' } },
    native: {
      codex: { enabled: true, executable: 'codex' },
      antigravity: { enabled: true, executable: 'agy' },
    },
    adapters: {
      acp: { transport: 'acp', command: 'x', enabled: true },
      noimg: { transport: 'acp', command: 'x', enabled: true, imageFiles: false },
      cli: { transport: 'stdio', command: 'x', enabled: true },
      off: { transport: 'stdio', command: 'x', enabled: true, imageFiles: false },
      remote: { transport: 'a2a', url: 'https://a2a.example', enabled: true },
      web: { transport: 'http', url: 'https://adapter.example', enabled: true },
    },
  });
  const drivers = new Map([['fixture', new FixtureModel()]]);
  const declared = imageInputAdvert(worker, drivers);
  assert.deepEqual(declared.providers, { oa: 'url', chat: 'none', fixture: 'none' });
  assert.deepEqual(declared.native, {
    codex: 'native',
    antigravity: 'workspace-file',
    'adapter/acp': 'agent-declared',
    'adapter/noimg': 'agent-declared',
    'adapter/cli': 'workspace-file',
  });
  const profile = (engine: string, evidence?: { image?: boolean }) =>
    conversionProfile(engine, worker, evidence).image_input;
  assert.equal(profile('kernel'), 'route');
  assert.equal(profile('codex'), 'native');
  assert.equal(profile('claude'), 'native');
  assert.equal(profile('antigravity'), 'workspace-file');
  assert.equal(profile('adapter/acp'), 'agent-declared');
  assert.equal(profile('adapter/acp', { image: true }), 'native');
  assert.equal(profile('adapter/acp', { image: false }), 'workspace-file');
  assert.equal(profile('adapter/noimg', { image: false }), 'none');
  assert.equal(profile('adapter/cli'), 'workspace-file');
  assert.equal(profile('adapter/off'), 'none');
  assert.equal(profile('adapter/remote'), 'none');
  assert.equal(profile('adapter/web'), 'none');
  assert.equal(imageNote({}), '');
  assert.match(
    imageNote({
      images: [{ fileId: 'file_1', mime: 'image/png', workspacePath: 'inputs/file_1/image-1.png' }],
    }),
    /\[Image #1\] inputs\/file_1\/image-1\.png \(image\/png\)/,
  );
});

test('images: engine forms — ACP blocks, Agent SDK prompt, Codex localImage, no path traversal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-img-'));
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'inputs', 'file_1'), { recursive: true });
    await writeFile(path.join(dir, 'inputs', 'file_1', 'image-1.png'), PNG);
    const images = [
      { fileId: 'file_1', mime: 'image/png', workspacePath: 'inputs/file_1/image-1.png' },
    ];
    assert.deepEqual(
      await acpImageBlocks({ promptCapabilities: { image: true } }, undefined, dir, images),
      [{ type: 'image', mimeType: 'image/png', data: PNG_B64 }],
    );
    assert.deepEqual(
      await acpImageBlocks({ promptCapabilities: { image: false } }, undefined, dir, images),
      [],
    );
    await assert.rejects(acpImageBlocks({}, false, dir, images), code('unsupported_content'));
    assert.equal(await claudePrompt('hi', dir, undefined), 'hi');
    const stream = (await claudePrompt('hi', dir, images)) as AsyncIterable<{
      message: { content: unknown[] };
    }>;
    const messages = [];
    for await (const m of stream) messages.push(m);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.message.content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
    });
    assert.deepEqual(codexInput('hi', dir, images)[1], {
      type: 'localImage',
      path: path.join(dir, 'inputs', 'file_1', 'image-1.png'),
    });
    // Failures of the documented-only paths say that the turn carried images.
    const hinted = imageDeliveryHint(
      new Fault('native_incomplete', 'boom', 502),
      'Codex',
      'localImage',
      images,
    );
    assert.ok(hinted instanceof Fault && hinted.code === 'native_incomplete');
    assert.match(
      hinted.message,
      /carried 1 image\(s\), sent to Codex as localImage; .*documentation only/,
    );
    assert.equal(imageDeliveryHint('x', 'Codex', 'localImage', undefined), 'x');
    await assert.rejects(
      claudePrompt('hi', dir, [
        { fileId: 'f', mime: 'image/png', workspacePath: 'inputs/f/missing.png' },
      ]),
      code('image_delivery_failed'),
    );
    for (const bad of ['../outside.png', 'inputs/../../x.png', path.resolve('/etc/passwd')])
      assert.throws(() => workspaceImagePath(dir, bad), code('invalid_path'), bad);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Gateway integration (app.inject).

type Seen = { provider: string; images: ModelImage[]; text: string };

/** A fixture driver with declared image input that echoes the images it received. */
function visionModel(name: string, imageInput: 'none' | 'inline' | 'url', seen: Seen[]) {
  const model = new FixtureModel((_a, messages) => {
    const images = messages.flatMap((m) => m.images ?? []);
    seen.push({ provider: name, images, text: messages.map((m) => m.content).join('\n') });
    const summary = images
      .map((i) =>
        i.kind === 'url'
          ? `url:${i.url}`
          : `${i.mime}:${Buffer.from(i.data ?? '', 'base64').length}`,
      )
      .join(',');
    return { text: `seen ${images.length} [${summary}]` };
  });
  return Object.assign(model, { imageInput });
}

async function imageGateway(
  extra: Record<string, unknown> = {},
  adapters: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-images-'));
  const seen: Seen[] = [];
  const workerConfig = workerSchema.parse({
    nodeId: 'local',
    dataDir: path.join(dir, 'worker'),
    adapters,
  });
  const drivers = new Map([
    ['fixture', visionModel('fixture', 'none', seen)],
    ['vision', visionModel('vision', 'url', seen)],
    ['inline', visionModel('inline', 'inline', seen)],
  ]);
  // Test-specific drivers are looked up lazily so a test can install its own before the call.
  const installed = new Map<string, FixtureModel>();
  for (const name of ['tooling', 'strict'])
    drivers.set(
      name,
      Object.assign(new FixtureModel(async (...args) => installed.get(name)!.respond(...args)), {
        imageInput: 'url' as const,
      }),
    );
  const runtime = new WorkerRuntime(workerConfig, new Map(), drivers);
  const config = gatewaySchema.parse({
    dataDir: path.join(dir, 'gateway'),
    port: 0,
    keys: [
      { name: 'test', owner: 'owner', tokenEnv: 'OAA_TEST_TOKEN', scopes: principal.scopes },
      {
        name: 'second',
        owner: 'owner',
        tokenEnv: 'OAA_SECOND_TOKEN',
        scopes: principal.scopes.filter((s) => s !== 'admin'),
      },
    ],
    localWorker: workerConfig,
    ...extra,
  });
  process.env.OAA_TEST_TOKEN = token;
  process.env.OAA_SECOND_TOKEN = secondToken;
  const gateway = await createGateway(config, runtime);
  await gateway.app.ready();
  const publish = (overrides: Record<string, unknown>) =>
    gateway.store.publish('owner', makeBundle(agent(overrides)));
  publish({ id: 'agent/vision', provider: 'vision', model: 'v1' });
  publish({ id: 'agent/inline', provider: 'inline', model: 'g1' });
  publish({ id: 'agent/text', provider: 'fixture', model: 'fixture' });
  publish({ id: 'agent/tooling', provider: 'tooling', model: 't' });
  publish({ id: 'agent/strict', provider: 'strict', model: 's' });
  // Primary route is text-only; the image-capable route is chosen when images are present.
  publish({
    id: 'agent/mixed',
    provider: 'fixture',
    model: 'fixture',
    routes: [{ id: 'eyes', provider: 'vision', model: 'v2' }],
  });
  const request = (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    who = token,
    headers: Record<string, string> = {},
  ) =>
    gateway.app.inject({
      method,
      url,
      payload: payload as never,
      headers: { authorization: `Bearer ${who}`, ...headers },
    });
  return {
    ...gateway,
    seen,
    request,
    publish,
    runtime_drivers_set: (name: string, model: FixtureModel) => installed.set(name, model),
    runs: () => gateway.store.summaries('owner', ['*'], 200).length,
    cleanup: async () => {
      await gateway.app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const dataUrl = (b: Buffer = PNG, type = 'image/png') =>
  `data:${type};base64,${b.toString('base64')}`;

test('images: OpenAI Chat / Responses, Claude and Gemini images reach a vision route in its own shape', async () => {
  const s = await imageGateway();
  try {
    const chat = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: dataUrl() } },
          ],
        },
      ],
    });
    assert.equal(chat.statusCode, 200, chat.body);
    assert.match(
      chat.json().choices[0].message.content,
      new RegExp(`seen 1 \\[image/png:${PNG.length}\\]`),
    );
    // The prompt text carries a marker, never the base64.
    assert.ok(!s.seen.at(-1)!.text.includes(PNG_B64));
    assert.match(s.seen.at(-1)!.text, /\[Image #1\]/);

    const responses = await s.request('POST', '/v1/responses', {
      model: 'agent/vision',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'two' },
            { type: 'input_image', image_url: dataUrl() },
            { type: 'input_image', image_url: 'https://img.example/b.png' },
          ],
        },
      ],
    });
    assert.equal(responses.statusCode, 200, responses.body);
    assert.match(
      JSON.stringify(responses.json().output),
      /seen 2 \[image\/png:\d+,url:https:\/\/img\.example\/b\.png\]/,
    );

    const claude = await s.request(
      'POST',
      '/v1/messages',
      {
        model: 'agent/vision',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
              { type: 'image', source: { type: 'url', url: 'https://img.example/c.png' } },
              { type: 'text', text: 'compare' },
            ],
          },
        ],
      },
      token,
      { 'anthropic-version': '2023-06-01' },
    );
    assert.equal(claude.statusCode, 200, claude.body);
    assert.match(claude.json().content[0].text, /seen 2/);

    const gemini = await s.request('POST', '/v1beta/models/agent%2Finline:generateContent', {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'describe' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }],
        },
      ],
    });
    assert.equal(gemini.statusCode, 200, gemini.body);
    assert.match(gemini.json().candidates[0].content.parts[0].text, /seen 1 \[image\/png/);
    assert.equal(s.seen.at(-1)!.provider, 'inline');

    // UAP and the native body take image blocks too.
    const uap = await s.request('POST', '/v1/uap', {
      target: 'agent/vision',
      input: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'u' },
            { type: 'image', data: PNG_B64, media_type: 'image/png' },
          ],
        },
      ],
    });
    assert.equal(uap.statusCode, 200, uap.body);
    assert.match(uap.json().output.text, /seen 1/);
    // The native body (/v1/invoke): top-level images, by data and by uploaded file id.
    const upload = await s.request('POST', '/v1/files', {
      filename: 'n.png',
      content: PNG_B64,
      encoding: 'base64',
    });
    const native = await s.request('POST', '/v1/invoke', {
      agent: 'agent/vision',
      input: 'native',
      images: [{ data: PNG_B64, media_type: 'image/png' }, { file_id: upload.json().id }],
    });
    assert.equal(native.statusCode, 200, native.body);
    assert.match(
      JSON.stringify(native.json().output),
      new RegExp(`seen 2 \\[image/png:${PNG.length},image/png:${PNG.length}\\]`),
    );
    const refused = await s.request('POST', '/v1/invoke', {
      agent: 'agent/text',
      input: 'native',
      images: [{ file_id: upload.json().id }, { data: PNG_B64, media_type: 'image/png' }],
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error.code, 'unsupported_content');
    assert.equal(refused.json().error.param, 'images.0', refused.body);
  } finally {
    await s.cleanup();
  }
});

test('images: stored as caller-private input files, deduplicated, shown in state and timeline', async () => {
  const s = await imageGateway();
  try {
    const first = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl() } },
            { type: 'text', text: 'one' },
          ],
        },
      ],
    });
    assert.equal(first.statusCode, 200, first.body);
    const runId = first.headers['x-run-id'] as string;
    const state = (await s.request('GET', `/v1/runs/${runId}/state`)).json();
    assert.equal(state.images.length, 1);
    assert.deepEqual(Object.keys(state.images[0]).sort(), [
      'bytes',
      'file_id',
      'kind',
      'mime',
      'name',
    ]);
    assert.equal(state.images[0].bytes, PNG.length);
    const timeline = (await s.request('GET', `/v1/runs/${runId}/timeline`)).json();
    assert.equal(timeline.images[0].file_id, state.images[0].file_id);
    // No base64 in events.
    const events = await s.request('GET', `/v1/responses/${runId}/events`);
    assert.ok(!events.body.includes(PNG_B64));
    // The same bytes again reuse the stored file.
    const again = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl() } },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    });
    const state2 = (await s.request('GET', `/v1/runs/${again.headers['x-run-id']}/state`)).json();
    assert.equal(state2.images[0].file_id, state.images[0].file_id);
    // The owner reads the file; another caller of the same owner does not see it.
    const own = await s.request('GET', `/v1/files/${state.images[0].file_id}/content`);
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.rawPayload, PNG);
    const other = await s.request(
      'GET',
      `/v1/files/${state.images[0].file_id}/content`,
      undefined,
      secondToken,
    );
    assert.equal(other.statusCode, 404);
    // ... and cannot reference it as an image either.
    const borrowed = await s.request(
      'POST',
      '/v1/responses',
      {
        model: 'agent/vision',
        input: [
          { role: 'user', content: [{ type: 'input_image', file_id: state.images[0].file_id }] },
        ],
      },
      secondToken,
    );
    assert.equal(borrowed.statusCode, 404, borrowed.body);
  } finally {
    await s.cleanup();
  }
});

test('images: uploaded images are referenced by file id; non-image files are refused as images', async () => {
  const s = await imageGateway();
  try {
    const up = await s.request('POST', '/v1/files', {
      filename: 'shot.png',
      content: PNG_B64,
      encoding: 'base64',
    });
    assert.equal(up.statusCode, 200, up.body);
    const r = await s.request(
      'POST',
      '/v1/messages',
      {
        model: 'agent/vision',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', file_id: up.json().id } },
              { type: 'text', text: 'x' },
            ],
          },
        ],
      },
      token,
      { 'anthropic-version': '2023-06-01' },
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.json().content[0].text, /seen 1 \[image\/png/);
    const txt = await s.request('POST', '/v1/files', {
      filename: 'a.txt',
      content: 'hello',
      encoding: 'utf8',
    });
    const bad = await s.request('POST', '/v1/responses', {
      model: 'agent/vision',
      input: [{ role: 'user', content: [{ type: 'input_image', file_id: txt.json().id }] }],
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'image_invalid');
    assert.equal(bad.json().error.param, 'input.0.content.0');
  } finally {
    await s.cleanup();
  }
});

test('images: routing skips text-only routes; agents without image input refuse clearly', async () => {
  const s = await imageGateway();
  try {
    const mixed = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/mixed',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl() } },
            { type: 'text', text: 'pick' },
          ],
        },
      ],
    });
    assert.equal(mixed.statusCode, 200, mixed.body);
    assert.equal(s.seen.at(-1)!.provider, 'vision');
    const before = s.runs();
    const text = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/text',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: dataUrl() } },
          ],
        },
      ],
    });
    assert.equal(text.statusCode, 400);
    assert.equal(text.json().error.code, 'unsupported_content');
    assert.equal(text.json().error.param, 'messages.0.content.1');
    assert.match(text.json().error.message, /does not accept images/);
    // Claude and Gemini keep their own error body shapes.
    const claude = await s.request(
      'POST',
      '/v1/messages',
      {
        model: 'agent/text',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
            ],
          },
        ],
      },
      token,
      { 'anthropic-version': '2023-06-01' },
    );
    assert.equal(claude.statusCode, 400);
    assert.equal(claude.json().type, 'error');
    assert.equal(claude.json().error.code, 'unsupported_content');
    const gemini = await s.request('POST', '/v1beta/models/agent%2Ftext:generateContent', {
      contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] }],
    });
    assert.equal(gemini.statusCode, 400);
    assert.equal(gemini.json().error.details[0].reason, 'unsupported_content');
    // A URL on an inline-only provider (no gateway fetch): refused with the way out.
    const url = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/inline',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://img.example/a.png' } }],
        },
      ],
    });
    assert.equal(url.statusCode, 400);
    assert.match(url.json().error.message, /inline/);
    assert.equal(s.runs(), before, 'no run was created');
    // /v1/models tells callers in advance.
    const models = (await s.request('GET', '/v1/models')).json().data as {
      id: string;
      image_input: boolean;
    }[];
    const by = Object.fromEntries(models.map((m) => [m.id, m.image_input]));
    assert.deepEqual(
      [by['agent/vision'], by['agent/inline'], by['agent/text'], by['agent/mixed']],
      [true, true, false, true],
    );
    const health = (await s.request('GET', '/health')).json();
    assert.ok(health.features.includes('image-input-v1'));
  } finally {
    await s.cleanup();
  }
});

test('images: limits — count, per-image size, total size, declared type, storage quota', async () => {
  const s = await imageGateway({
    images: { maxImagesPerRequest: 2, maxImageBytes: 2048, maxTotalBytes: 3000 },
    maxStoredBytesPerSubject: 2_000_000,
  });
  try {
    const send = (parts: Record<string, unknown>[]) =>
      s.request('POST', '/v1/chat/completions', {
        model: 'agent/vision',
        messages: [{ role: 'user', content: parts }],
      });
    const img = (b: Buffer = PNG, type = 'image/png') => ({
      type: 'image_url',
      image_url: { url: dataUrl(b, type) },
    });
    const many = await send([img(), img(), img()]);
    assert.equal(many.statusCode, 400);
    assert.equal(many.json().error.code, 'too_many_images');
    assert.equal(many.json().error.param, 'messages.0.content.2');
    const big = Buffer.concat([PNG, Buffer.alloc(3000)]);
    const large = await send([img(big)]);
    assert.equal(large.statusCode, 413);
    assert.equal(large.json().error.code, 'image_too_large');
    const half = Buffer.concat([PNG, Buffer.alloc(1800)]);
    const total = await send([img(half), img(Buffer.concat([half, Buffer.from([1])]))]);
    assert.equal(total.json().error.code, 'image_too_large');
    const lie = await send([img(PNG, 'image/gif')]);
    assert.equal(lie.statusCode, 400);
    assert.equal(lie.json().error.code, 'image_invalid');
    assert.equal(lie.json().error.param, 'messages.0.content.0');
  } finally {
    await s.cleanup();
  }
  const q = await imageGateway({ maxStoredBytesPerSubject: PNG.length + 10 });
  try {
    const ok = await q.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl() } }] }],
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const over = await q.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(OTHER_PNG) } }] },
      ],
    });
    assert.equal(over.statusCode, 413);
    assert.equal(over.json().error.code, 'storage_quota_exceeded');
  } finally {
    await q.cleanup();
  }
});

test('images: previous_response_id keeps earlier images by reference without storing them again', async () => {
  const s = await imageGateway();
  try {
    const first = await s.request('POST', '/v1/responses', {
      model: 'agent/vision',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: dataUrl() },
            { type: 'input_text', text: 'first' },
          ],
        },
      ],
    });
    assert.equal(first.statusCode, 200, first.body);
    const files = () =>
      (s.store.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
    const stored = files();
    const second = await s.request('POST', '/v1/responses', {
      model: 'agent/vision',
      previous_response_id: first.json().id,
      input: 'and now?',
    });
    assert.equal(second.statusCode, 200, second.body);
    // The model is stateless: the history image is sent again (by reference), nothing new stored.
    assert.equal(s.seen.at(-1)!.images.length, 1);
    assert.equal(files(), stored);
    const state = (await s.request('GET', `/v1/runs/${second.json().id}/state`)).json();
    assert.equal(state.images, undefined, 'the follow-up itself carries no new image');
  } finally {
    await s.cleanup();
  }
});

test('images: ACP agent with promptCapabilities.image gets image blocks; without it, workspace files', async () => {
  const fixture = path.resolve('test/fixtures/acp-agent.mjs');
  const s = await imageGateway(
    {},
    {
      eyes: {
        transport: 'acp',
        command: process.execPath,
        args: [fixture, 'images'],
        enabled: true,
      },
      plain: {
        transport: 'acp',
        command: process.execPath,
        args: [fixture, 'stream'],
        enabled: true,
      },
      strict: {
        transport: 'acp',
        command: process.execPath,
        args: [fixture, 'stream'],
        enabled: true,
        imageFiles: false,
      },
    },
  );
  try {
    for (const name of ['eyes', 'plain', 'strict'])
      s.publish({
        id: `agent/${name}`,
        engine: `adapter/${name}`,
        model: 'default',
        instructions: '',
      });
    const ask = (id: string) =>
      s.request('POST', '/v1/chat/completions', {
        model: id,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ECHO-IMAGES' },
              { type: 'image_url', image_url: { url: dataUrl() } },
            ],
          },
        ],
      });
    const eyes = await ask('agent/eyes');
    assert.equal(eyes.statusCode, 200, eyes.body);
    assert.match(eyes.json().choices[0].message.content, /images=1;files=2\/2/);
    const plain = await ask('agent/plain');
    assert.equal(plain.statusCode, 200, plain.body);
    // No image block, but the named workspace file exists and the agent can open it.
    assert.match(plain.json().choices[0].message.content, /images=0;files=2\/2/);
    const strict = await ask('agent/strict');
    assert.notEqual(strict.statusCode, 200);
    assert.match(strict.body, /unsupported_content/);
  } finally {
    await s.cleanup();
  }
});

test('images: external agents that only take text (A2A, HTTP adapters) refuse before a run exists', async () => {
  const s = await imageGateway(
    {},
    {
      remote: { transport: 'a2a', url: 'https://a2a.example/rpc', enabled: true },
    },
  );
  try {
    s.publish({ id: 'agent/remote', engine: 'adapter/remote', model: 'default', instructions: '' });
    const before = s.runs();
    const r = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/remote',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl() } }] }],
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error.code, 'unsupported_content');
    assert.equal(s.runs(), before);
    await waitFor(() => true);
  } finally {
    await s.cleanup();
  }
});

test('images: request logs and error bodies never carry the base64', async () => {
  const s = await imageGateway();
  try {
    const ok = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl() } }] }],
    });
    assert.ok(!ok.body.includes(PNG_B64));
    const r = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/text',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl() } }] }],
    });
    assert.ok(!r.body.includes(PNG_B64));
    const bad = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: dataUrl(PNG, 'image/webp') } }],
        },
      ],
    });
    assert.ok(!bad.body.includes(PNG_B64));
    // Run payloads keep references only.
    const payloads = s.store.db.prepare('SELECT payload FROM runs').all() as { payload: string }[];
    assert.ok(!payloads.some((r) => r.payload.includes(PNG_B64)));
  } finally {
    await s.cleanup();
  }
});

const storedBytes = (s: { store: { db: { prepare: (q: string) => { get: () => unknown } } } }) =>
  Number(
    (
      s.store.db
        .prepare("SELECT coalesce(sum(json_extract(payload,'$.bytes')),0) AS n FROM files")
        .get() as { n: number }
    ).n,
  );

test('images: a refused request leaves the caller storage unchanged; reused files stay', async () => {
  const s = await imageGateway();
  try {
    const send = (model: string, image = PNG) =>
      s.request('POST', '/v1/chat/completions', {
        model,
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(image) } }] },
        ],
      });
    const before = storedBytes(s);
    const refused = await send('agent/text');
    assert.equal(refused.statusCode, 400);
    assert.equal(storedBytes(s), before, 'nothing new was kept');
    // An image stored by an accepted request is reused, and a later refusal does not delete it.
    assert.equal((await send('agent/vision')).statusCode, 200);
    const kept = storedBytes(s);
    assert.equal((await send('agent/text')).statusCode, 400);
    assert.equal(storedBytes(s), kept);
    const runId = (await send('agent/vision')).headers['x-run-id'] as string;
    const state = (await s.request('GET', `/v1/runs/${runId}/state`)).json();
    assert.equal(
      (await s.request('GET', `/v1/files/${state.images[0].file_id}/content`)).statusCode,
      200,
    );
  } finally {
    await s.cleanup();
  }
});

for (const share of [false, true])
  test(`images: expiring admission does not block cleanup or delete another waiting run's input (shared=${share})`, async (t) => {
    const s = await imageGateway(),
      db = s.store.db;
    const other = new DatabaseSync(path.join(s.store.root, 'state.sqlite'));
    let locked = false,
      attempted = false;
    const release = () => {
      if (locked) {
        locked = false;
        other.exec('ROLLBACK');
      }
    };
    try {
      db.exec('PRAGMA busy_timeout=150');
      const create = s.store.createRun.bind(s.store);
      t.mock.method(s.store, 'createRun', (...args: Parameters<typeof create>) => {
        if (!attempted) {
          attempted = true;
          other.exec('BEGIN IMMEDIATE');
          locked = true;
        }
        return create(...args);
      });
      const send = () =>
        s.request('POST', '/v1/chat/completions', {
          model: 'agent/vision',
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(PNG) } }] },
          ],
        });
      const first = send();
      await waitFor(() => attempted);
      db.exec('PRAGMA busy_timeout=1500');
      const second = share ? send() : undefined;
      const refused = await first;
      assert.equal(refused.statusCode, 503, refused.body);
      assert.equal(refused.json().error.code, 'admission_busy');
      assert.equal(s.runs(), 0);
      release();
      if (second) {
        const accepted = await second;
        assert.equal(accepted.statusCode, 200, accepted.body);
        assert.equal(s.runs(), 1);
        assert.equal(storedBytes(s), PNG.length);
        const file = s.store.run(String(accepted.headers['x-run-id'])).fileIds[0]!;
        assert.equal((await s.request('GET', `/v1/files/${file}/content`)).statusCode, 200);
      } else await waitFor(() => storedBytes(s) === 0);
    } finally {
      release();
      other.close();
      await s.cleanup();
    }
  });

test('images: an unconfirmed HTTP admission never discards an input its committed run may own', async (t) => {
  const s = await imageGateway();
  try {
    const db = s.store.db;
    let armed = false,
      readback = false;
    const io = () =>
      Object.assign(new Error('fixture write acknowledgement unavailable'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 10,
      });
    db.function('mark_run', () => {
      armed = true;
      return 1;
    });
    db.exec(
      'CREATE TEMP TRIGGER mark_admission AFTER INSERT ON runs BEGIN SELECT mark_run(); END;',
    );
    const exec = db.exec.bind(db),
      prepare = s.store.prepare.bind(s.store);
    t.mock.method(db, 'exec', (sql: string) => {
      if (armed && sql === 'COMMIT') {
        armed = false;
        exec(sql);
        readback = true;
        throw io();
      }
      return exec(sql);
    });
    t.mock.method(s.store, 'prepare', (sql: string) => {
      if (readback) {
        readback = false;
        throw io();
      }
      return prepare(sql);
    });
    const response = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/vision',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(PNG) } }] },
      ],
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, 'effect_outcome_unknown');
    assert.equal(response.headers['x-should-retry'], 'false');
    assert.equal(s.seen.length, 0);
    const [run] = s.store.allRuns();
    assert.equal(run?.status, 'queued');
    assert.equal(response.json().error.run_id, run!.id);
    assert.equal(storedBytes(s), PNG.length);
    assert.equal((await s.request('GET', `/v1/files/${run!.fileIds[0]}/content`)).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

test('images: with caller tools (auto bridge) the image stays in the bridged and resumed turns', async () => {
  const s = await imageGateway();
  const calls: number[] = [];
  const tooling = Object.assign(
    new FixtureModel((a, messages) => {
      calls.push(messages.flatMap((m) => m.images ?? []).length);
      if (messages.some((m) => m.role === 'tool'))
        return { text: `done with ${calls.at(-1)} image(s)` };
      const fn = a.tools.find((t) => t.capability.id.startsWith('client/'));
      return { calls: [{ id: 'c1', name: fn!.name, arguments: { q: 'x' } }] };
    }),
    { imageInput: 'url' as const },
  );
  s.runtime_drivers_set('tooling', tooling);
  try {
    const tool = {
      type: 'function',
      function: {
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    };
    const user = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: dataUrl() } },
      ],
    };
    const first = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tooling',
      messages: [user],
      tools: [tool],
    });
    assert.equal(first.statusCode, 200, first.body);
    const call = first.json().choices[0].message.tool_calls[0];
    assert.equal(first.json().choices[0].finish_reason, 'tool_calls');
    const files = storedBytes(s);
    const done = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/tooling',
      tools: [tool],
      messages: [
        user,
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'found' },
      ],
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.headers['x-run-id'], first.headers['x-run-id'], 'the same run continued');
    assert.match(done.json().choices[0].message.content, /done with 1 image/);
    assert.deepEqual(calls, [1, 1], 'the image is in the history of both model turns');
    assert.equal(storedBytes(s), files, 'the resent history image is not stored again');
  } finally {
    await s.cleanup();
  }
});

test('images: a structured-output repair turn keeps the image in history and stores nothing new', async () => {
  const s = await imageGateway();
  const calls: number[] = [];
  const strict = Object.assign(
    new FixtureModel((_a, messages) => {
      calls.push(messages.flatMap((m) => m.images ?? []).length);
      return { text: calls.length === 1 ? 'not json' : '{"answer":"cat"}' };
    }),
    { imageInput: 'url' as const },
  );
  s.runtime_drivers_set('strict', strict);
  try {
    const before = storedBytes(s);
    const r = await s.request('POST', '/v1/chat/completions', {
      model: 'agent/strict',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what animal?' },
            { type: 'image_url', image_url: { url: dataUrl() } },
          ],
        },
      ],
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(JSON.parse(r.json().choices[0].message.content), { answer: 'cat' });
    assert.deepEqual(calls, [1, 1], 'the repair turn still sees the image in its history');
    assert.equal(storedBytes(s), before + PNG.length, 'stored once');
    const state = (await s.request('GET', `/v1/runs/${r.headers['x-run-id']}/state`)).json();
    assert.equal(state.images.length, 1);
    assert.equal(state.output_contract.repairs, 1);
  } finally {
    await s.cleanup();
  }
});
