// Vercel AI SDK (`ai` + @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/anthropic, @ai-sdk/google)
// pointed at the gateway: non-streaming, streaming and a tool-calling loop per provider package.
import { readFile } from 'node:fs/promises';
import { createLab, env, check, equal, loadOrSkip } from '../lib/harness.mjs';

const version = async (name) => JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
const lab = createLab('vercel-ai-sdk', `ai ${await version('ai')}`);
const ai = await loadOrSkip(lab, 'ai');
if (!ai) process.exit(0);
const { generateText, generateObject, streamText, tool, isStepCount } = ai;
const { z } = await import('zod');
const { createOpenAI } = await import('@ai-sdk/openai');
const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
const { createAnthropic } = await import('@ai-sdk/anthropic');
const { createGoogleGenerativeAI } = await import('@ai-sdk/google');

const M = env.fixture;
const BRIDGE = { 'X-OAA-Client-Tools': 'bridge' };
const TEXT = 'Hello world from the fixture.';
const weather = () =>
  tool({
    description: 'Get the weather',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => `sunny in ${city}`,
  });

// One entry per provider package: how to build a model for the gateway, with and without the tool bridge.
const providers = {
  'openai.chat': (headers) => createOpenAI({ baseURL: `${env.baseUrl}/v1`, apiKey: env.apiKey, headers }).chat(M),
  'openai.responses': (headers) => createOpenAI({ baseURL: `${env.baseUrl}/v1`, apiKey: env.apiKey, headers }).responses(M),
  'openai-compatible': (headers) =>
    createOpenAICompatible({ name: 'oaa', baseURL: `${env.baseUrl}/v1`, apiKey: env.apiKey, headers, includeUsage: true, supportsStructuredOutputs: true }).chatModel(M),
  anthropic: (headers) => createAnthropic({ baseURL: `${env.baseUrl}/v1`, apiKey: env.apiKey, headers })(M),
  google: (headers) => createGoogleGenerativeAI({ baseURL: `${env.baseUrl}/v1beta`, apiKey: env.apiKey, headers })(M),
};

for (const [name, build] of Object.entries(providers)) {
  // Stream progress (docs/progress.md): same text on and off; reasoning parts where the provider maps them.
  await lab.scenario(`${name}.stream_progress`, async () => {
    const run = async (headers) => {
      const result = streamText({ model: build(headers), prompt: 'LONG' });
      return { text: await result.text, reasoning: (await result.reasoningText) ?? '' };
    };
    const on = await run({ 'X-OAA-Progress': 'reasoning', 'Accept-Language': 'en' });
    const off = await run({ 'X-OAA-Progress': 'off' });
    equal(on.text, off.text, 'text with progress on');
    equal(off.reasoning, '', 'no reasoning when off');
    return on.reasoning ? `reasoning shown: ${JSON.stringify(on.reasoning.slice(0, 40))}` : 'progress ignored';
  });
  await lab.scenario(`${name}.generateText`, async () => {
    const r = await generateText({ model: build(), prompt: 'hi' });
    equal(r.text, TEXT, 'text');
    check((r.usage?.totalTokens ?? r.usage?.inputTokens) > 0, `usage ${JSON.stringify(r.usage)}`);
    equal(r.finishReason, 'stop', 'finishReason');
  });
  await lab.scenario(`${name}.streamText`, async () => {
    const result = streamText({ model: build(), prompt: 'LONG' });
    let text = '';
    let parts = 0;
    for await (const delta of result.textStream) {
      text += delta;
      parts++;
    }
    check(parts > 3 && text.includes('Paragraph 6'), `streamed ${parts} parts`);
    equal(await result.finishReason, 'stop', 'finishReason');
    check((await result.usage).totalTokens > 0, 'usage');
  });
  await lab.scenario(`${name}.system_and_history`, async () => {
    const r = await generateText({
      model: build(),
      system: 'SYSTEM_MARK',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'SHOW_PROMPT' },
      ],
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 200,
      stopSequences: ['END'],
      seed: 3,
      presencePenalty: 0.1,
      frequencyPenalty: 0.1,
    });
    for (const mark of ['SYSTEM_MARK', 'first question', 'first answer']) check(r.text.includes(mark), `${mark} lost: ${r.text.slice(0, 120)}`);
  });
  // Image input (docs/images.md): an image part (bytes) in each provider's own wire shape.
  await lab.scenario(`${name}.image_input`, async () => {
    const r = await generateText({
      model: build(),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'SHOW_IMAGES' }, { type: 'image', image: Buffer.from(env.png, 'base64'), mediaType: 'image/png' }] }],
    });
    check(/^Images: 1 \[image\/png:\d+\]$/.test(r.text), `reply: ${r.text}`);
  });
  await lab.scenario(`${name}.tool_loop_without_any_header`, async () => {
    const r = await generateText({
      model: build(),
      prompt: 'CALLTOOL',
      tools: { get_weather: weather() },
      stopWhen: isStepCount(4),
    });
    check(r.steps.length >= 2, `only ${r.steps.length} step(s): ${r.text}`);
    check(r.toolResults?.length || r.steps.some((s) => s.toolResults?.length), 'no tool result recorded');
    check(r.text.startsWith('Tool result:') && r.text.includes('sunny in Paris'), `final text: ${r.text}`);
  });
}

for (const [name, build] of Object.entries(providers)) {
  await lab.scenario(`${name}.generateObject`, async () => {
    // @ai-sdk/anthropic would default to a forced JSON tool; its native output format goes through output_config.
    const { object } = await generateObject({
      model: build(),
      schema: z.object({ name: z.string(), age: z.number().int() }),
      prompt: 'BADJSON who?',
      providerOptions: { anthropic: { structuredOutputMode: 'outputFormat' } },
    });
    equal(`${object.name}/${object.age}`, 'x/1', 'object');
  });
}

lab.done();
