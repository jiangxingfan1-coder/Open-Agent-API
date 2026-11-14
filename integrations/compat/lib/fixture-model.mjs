// Deterministic fixture model for the compatibility lab. It never calls a network service.
// The reply is chosen by directives in the latest user message, so every client script can ask
// for exactly the behaviour it needs. Directives are plain words in the prompt:
//
//   (none)        "Hello world from the fixture." (streamed in 8-character chunks)
//   LONG          a long multi-paragraph answer (many stream chunks)
//   LENGTH        a partial answer that ends with finish_reason "length"
//   FAIL          the model driver throws: the run fails
//   SLOW          waits up to 30 s, but stops at once when the run is cancelled
//   JSON          answers with a JSON object {"answer":"ok","n":1}
//   SHOW_PROMPT   answers with every message the agent received as "role: content" lines
//   CALLTOOL      calls the caller-declared tools (bridge mode): the first one, or every one with PARALLEL
//
// When the conversation already holds tool results, the answer is "Tool result: <results>".
// Token usage is derived from the text length, so it is deterministic and non-zero.

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const LONG_TEXT = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}: the compatibility lab streams this deterministic sentence so that clients see many chunks.`,
).join('\n\n');

const tokensOf = (text) => Math.max(1, Math.ceil(text.length / 4));

/** Build arguments for a caller tool from its JSON Schema: strings, numbers and booleans only. */
function argumentsFor(schema) {
  const props = schema && typeof schema === 'object' ? (schema.properties ?? {}) : {};
  const args = {};
  for (const [name, spec] of Object.entries(props)) {
    const type = spec && typeof spec === 'object' ? spec.type : undefined;
    if (type === 'number' || type === 'integer') args[name] = 1;
    else if (type === 'boolean') args[name] = true;
    else if (type === 'array') args[name] = [];
    else if (type === 'object') args[name] = {};
    else args[name] = name === 'city' ? 'Paris' : 'test';
  }
  return args;
}

export class FixtureModel {
  calls = 0;
  /** Every message list the agent received (the lab uses it to check what reached the agent). */
  seen = [];

  async call(agent, messages, signal, delta) {
    this.calls++;
    this.seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
    const lastUserIndex = messages.findLastIndex((m) => m.role === 'user');
    const prompt = lastUserIndex >= 0 ? messages[lastUserIndex].content : '';
    const results = messages.slice(lastUserIndex + 1).filter((m) => m.role === 'tool');
    const inputTokens = tokensOf(messages.map((m) => m.content).join('\n'));
    const finish = (text, extra = {}) => {
      for (const part of text.match(/.{1,8}/gs) ?? []) delta(part);
      return {
        text,
        calls: extra.calls ?? [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: tokensOf(text),
          total_tokens: inputTokens + tokensOf(text),
        },
        finish: extra.finish ?? (extra.calls?.length ? 'tool_calls' : 'stop'),
      };
    };
    if (results.length) return finish(`Tool result: ${results.map((m) => m.content).join(' | ')}`);
    if (/\bFAIL\b/.test(prompt)) throw new Error('fixture model failure requested');
    if (/\bSLOW\b/.test(prompt)) {
      await sleep(30_000, signal);
      return finish('slow answer');
    }
    if (/\bLENGTH\b/.test(prompt)) return finish('partial text', { finish: 'length' });
    if (/\bLONG\b/.test(prompt)) return finish(LONG_TEXT);
    if (/\bJSON\b/.test(prompt)) return finish('{"answer":"ok","n":1}');
    if (/\bSHOW_PROMPT\b/.test(prompt))
      return finish(messages.map((m) => `${m.role}: ${m.content}`).join('\n'));
    if (/\bCALLTOOL\b/.test(prompt)) {
      const clientTools = agent.tools.filter((t) => t.capability?.id?.startsWith('client/'));
      if (clientTools.length) {
        const chosen = /\bPARALLEL\b/.test(prompt) ? clientTools : clientTools.slice(0, 1);
        return finish('', {
          calls: chosen.map((t, i) => ({
            id: `call_${i + 1}`,
            name: t.name,
            arguments: argumentsFor(t.capability.inputSchema),
          })),
        });
      }
    }
    return finish('Hello world from the fixture.');
  }
}
