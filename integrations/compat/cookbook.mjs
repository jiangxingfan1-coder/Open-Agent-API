// The cookbook examples (examples/cookbook/) as scenarios of the compatibility lab.
//
// Each scenario runs one example file against the lab's isolated gateway (loopback, offline sample agent and the
// deterministic fixture model; no model service is called) and asserts the exit code and key lines of its output.
// Examples read the same environment variables a user sets (OAA_BASE_URL, OAA_API_KEY, OAA_AGENT, ...); the lab only
// adds OAA_PROMPT / OAA_LONG_PROMPT where it needs a directive of the fixture model (see lib/fixture-model.mjs) and
// OAA_AGENT to choose which lab agent the example talks to.
//
// test/cookbook.test.ts checks that every runnable file under examples/cookbook/ has a scenario here, or is listed in
// NOT_IN_LAB with the reason: an example can not silently drop out of verification.

/** `agent` is a key of the lab gateway's agents: fixture, sample, textOnly (no image input), native (cannot bridge). */
const FIXTURE = 'fixture';
const SAMPLE = 'sample';
const TEXT_ONLY = 'textOnly';
const NATIVE = 'native';

const OK = /^ok$/m;
const HELLO = /Hello world from the fixture\./;
const WEATHER = 'CALLTOOL weather in Paris';
const SHOW_IMAGES = { OAA_PROMPT: 'SHOW_IMAGES' };
const IMAGE_SEEN = /Images: 1 \[image\/png:\d+\]/;
const SAMPLE_TEXT = /offline sample agent/;
/** {BASE} and {KEY} are replaced by the lab gateway's address and key. */
const ENV_SDK = {
  OPENAI_BASE_URL: '{BASE}/v1',
  OPENAI_API_KEY: '{KEY}',
  ANTHROPIC_BASE_URL: '{BASE}',
  ANTHROPIC_API_KEY: '{KEY}',
};

/** One scenario: { file, agent, env?, args?, exit?, expect?, title? }. The id is `<file>` plus the title, if any. */
const s = (file, agent, options = {}) => ({ file, agent, env: {}, args: [], exit: 0, expect: [OK], ...options });

export const SCENARIOS = [
  // 01 first call: every protocol, blocking and streaming
  ...['hello_openai.py', 'hello_anthropic.py', 'hello_genai.py', 'hello_openai.mjs', 'hello_anthropic.mjs', 'hello_genai.mjs', 'hello.sh'].map(
    (file) => s(`01-first-call/${file}`, FIXTURE, { expect: [OK, HELLO] }),
  ),
  s('01-first-call/hello.sh', SAMPLE, { title: 'with the offline sample agent', expect: [OK, SAMPLE_TEXT] }),
  s('01-first-call/hello_openai.py', SAMPLE, { title: 'with the offline sample agent', expect: [OK, SAMPLE_TEXT] }),
  s('01-first-call/hello_anthropic.mjs', SAMPLE, { title: 'with the offline sample agent', expect: [OK, SAMPLE_TEXT] }),

  // 02 long tasks: background + poll, cancel, previous_response_id
  ...['long_task_openai.py', 'long_task_openai.mjs', 'long_task.sh'].map((file) =>
    s(`02-long-running/${file}`, FIXTURE, {
      env: { OAA_LONG_PROMPT: 'SLOW' },
      expect: [OK, /2\. cancel -> cancelled|cancel -> cancelled/, /continue -> completed/],
    }),
  ),
  s('02-long-running/long_task_openai.py', SAMPLE, {
    title: 'with the offline sample agent (cancel ends incomplete, no session continuation)',
    expect: [OK, /cancel -> incomplete/, /native_resume_unsupported/],
  }),
  s('02-long-running/long_task.sh', SAMPLE, {
    title: 'with the offline sample agent (cancel ends incomplete, no session continuation)',
    expect: [OK, /cancel -> (incomplete|completed)/, /native_resume_unsupported/],
  }),

  // 03 approvals: poll + API decision, and the event callback. The sample agent asks for approval when the task says "approve".
  ...['approve_openai.py', 'approve_openai.mjs', 'approve.sh'].flatMap((file) => [
    s(`03-approvals/${file}`, SAMPLE, { title: 'approve', args: ['approve'], expect: [OK, /completed/] }),
    s(`03-approvals/${file}`, SAMPLE, { title: 'deny', args: ['deny'], expect: [OK, /permission_denied/] }),
  ]),
  s('03-approvals/approve_openai.py', FIXTURE, { title: 'an agent that never asks', expect: [/no approval was needed/] }),
  s('03-approvals/webhook_approve.mjs', SAMPLE, { title: 'approve', args: ['approve'], expect: [OK, /event run\.requires_action/, /final event: run\.completed/] }),
  s('03-approvals/webhook_approve.mjs', SAMPLE, { title: 'deny', args: ['deny'], expect: [OK, /final event: run\.failed/, /denied: permission_denied/] }),

  // 04 caller tools: the fixture model calls get_weather when the prompt says CALLTOOL
  ...['tools_openai.py', 'tools_anthropic.py', 'tools_genai.py', 'tools_openai.mjs', 'tools_anthropic.mjs', 'tools_genai.mjs'].map((file) =>
    s(`04-caller-tools/${file}`, FIXTURE, {
      env: { OAA_PROMPT: WEATHER },
      expect: [OK, /tool call: get_weather/, /answer: Tool result: .*Paris/, ...(file.startsWith('tools_genai') ? [] : [/X-OAA-Client-Tools: bridge/])],
    }),
  ),
  s('04-caller-tools/tools_openai.py', SAMPLE, {
    title: 'the sample agent never calls a tool (exit 3)',
    exit: 3,
    expect: [/did not call your tool/],
  }),
  s('04-caller-tools/tools_openai.mjs', NATIVE, {
    title: 'an agent that cannot take tools over is refused clearly (exit 2)',
    exit: 2,
    expect: [/cannot take caller tools over/],
  }),

  // 05 structured output: valid JSON, a correction round (BADJSON), and the 422 failure (ALWAYSBAD)
  ...['structured_openai.py', 'structured_anthropic.py', 'structured_genai.py', 'structured_openai.mjs', 'structured.sh'].flatMap((file) => [
    s(`05-structured-output/${file}`, FIXTURE, { expect: [OK, /title/] }),
    s(`05-structured-output/${file}`, FIXTURE, {
      title: 'the agent never fits the schema (422, exit 3)',
      env: { OAA_PROMPT: 'ALWAYSBAD who wrote Hamlet?' },
      exit: 3,
      expect: [/structured_output_invalid/],
    }),
  ]),
  s('05-structured-output/structured_openai.py', FIXTURE, {
    title: 'the first answer is prose, the correction round fixes it',
    env: { OAA_PROMPT: 'BADJSON who wrote Hamlet?' },
    expect: [OK, /json: /],
  }),
  s('05-structured-output/structured_openai.py', SAMPLE, {
    title: 'an agent that cannot be asked twice (exit 3)',
    exit: 3,
    expect: [/structured_output_invalid/, /not asked again/],
  }),

  // 06 images: the fixture reports what it received; the text-only agent refuses before a run exists
  ...['image_openai.py', 'image_anthropic.py', 'image_genai.py', 'image_openai.mjs', 'image_anthropic.mjs', 'image_genai.mjs', 'image.sh'].flatMap((file) => [
    s(`06-images/${file}`, FIXTURE, { env: SHOW_IMAGES, expect: [OK, IMAGE_SEEN] }),
    s(`06-images/${file}`, TEXT_ONLY, { title: 'an agent without image input (exit 2)', exit: 2, expect: [/does not accept images/] }),
  ]),

  // 07 errors and retries
  s('07-errors-and-retries/retries_openai.py', FIXTURE, { expect: [OK, /unknown agent: stop/, /simulated 429 \+ Retry-After: 1: succeeded on attempt 2/, /simulated 422 .*stop/] }),
  s('07-errors-and-retries/retries_openai.mjs', FIXTURE, { expect: [OK, /unknown agent: stop/, /simulated 429 \+ Retry-After: 1: succeeded on attempt 2/, /simulated 422 .*stop/] }),
  s('07-errors-and-retries/errors.sh', FIXTURE, { expect: [OK, /agent_not_found: retryable=false/, /rate_limited: retryable=true/, /attempt 1: HTTP 200/] }),

  // 08 connecting tools: the SDKs read their base URL and key from the environment
  s('08-connect-tools/env_check.py', FIXTURE, { env: ENV_SDK, expect: [OK, /openai: Hello/, /anthropic: Hello/] }),
  s('08-connect-tools/env_check.mjs', FIXTURE, { env: ENV_SDK, expect: [OK, /openai: Hello/, /anthropic: Hello/] }),
];

/** Files under examples/cookbook/ that are not run by the lab, and why. */
export const NOT_IN_LAB = [
  {
    file: '08-connect-tools/continue.config.yaml',
    reason: 'A configuration entry for the Continue extension. The lab has no Continue; test/cookbook.test.ts parses it and checks every key against docs/compatibility.md and the recorded replay (integrations/compat/replays/continue.json), which the lab replays against the gateway.',
  },
  {
    file: '08-connect-tools/zed.settings.json',
    reason: 'A configuration entry for the Zed editor. The lab has no Zed; test/cookbook.test.ts parses it and checks it against docs/compatibility.md and the recorded replay (integrations/compat/replays/zed.json), which the lab replays against the gateway.',
  },
  {
    file: '08-connect-tools/librechat.yaml',
    reason: 'A configuration entry for LibreChat. The lab has no LibreChat; test/cookbook.test.ts parses it and checks it against docs/compatibility.md and the recorded replay (integrations/compat/replays/librechat.json), which the lab replays against the gateway.',
  },
  {
    file: '06-images/sample.png',
    reason: 'The picture the image examples send; the lab runs those examples with it, so it is exercised, but it is data, not an example.',
  },
];

/** The id a scenario is reported under in the matrix. */
export const scenarioId = (scenario) => (scenario.title ? `${scenario.file} (${scenario.title})` : scenario.file);

/** Which runtime runs a file: by extension. */
export const runtimeOf = (file) => (file.endsWith('.py') ? 'python' : file.endsWith('.mjs') ? 'node' : 'shell');
