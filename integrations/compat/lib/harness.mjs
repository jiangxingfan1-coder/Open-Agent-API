// Result reporting for Node client scripts of the compatibility lab.
// A script creates one lab with `createLab('client-id', 'package version')`, runs scenarios with
// `lab.scenario(id, fn)` and calls `lab.done()`. Each scenario prints one machine-readable line
// (`@@COMPAT {json}`) that the launcher (run.mjs) collects into the matrix.
//
//   pass: the fn returned (its return value, if a string, is kept as the detail)
//   fail: the fn threw
//   na:   the client cannot do this by design (throw `new NotApplicable('why')`)
//   skip: the client could not run at all (missing package, ...)

export class NotApplicable extends Error {}

export const env = {
  baseUrl: process.env.OAA_BASE_URL ?? '',
  apiKey: process.env.OAA_API_KEY ?? '',
  fixture: process.env.OAA_AGENT_FIXTURE ?? 'agent/fixture',
  sample: process.env.OAA_AGENT_SAMPLE ?? 'agent/sample',
  native: process.env.OAA_AGENT_NATIVE ?? 'agent/native',
  acp: process.env.OAA_AGENT_ACP ?? 'agent/acp',
  textOnly: process.env.OAA_AGENT_TEXT ?? 'agent/text-only',
  /** A real 1x1 PNG for the image scenarios (docs/images.md). */
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
};

const emit = (record) => process.stdout.write(`@@COMPAT ${JSON.stringify(record)}\n`);

export function createLab(client, version = '') {
  const record = (scenario, status, detail = '', ms = 0) =>
    emit({ client, version, scenario, status, detail: String(detail).slice(0, 600), ms });
  return {
    client,
    record,
    async scenario(id, fn) {
      const started = Date.now();
      const ms = () => Date.now() - started;
      try {
        const detail = await fn();
        record(id, 'pass', typeof detail === 'string' ? detail : '', ms());
      } catch (error) {
        if (error instanceof NotApplicable) record(id, 'na', error.message, ms());
        else record(id, 'fail', describe(error), ms());
      }
    },
    skip(reason) {
      record('*', 'skip', reason);
    },
    done() {
      // Exit explicitly: SDK keep-alive sockets would hold the process open for many seconds.
      process.stdout.write('@@COMPAT-DONE\n', () => process.exit(0));
    },
  };
}

export function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const status = error.status ?? error.statusCode;
  return `${error.name}${status ? ` (HTTP ${status})` : ''}: ${error.message}`.replace(/\s+/g, ' ');
}

export function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

export function equal(actual, expected, what) {
  if (actual !== expected)
    throw new Error(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

/** Plain JSON call to the gateway (for side-effect checks such as counting runs). */
export async function gateway(path, init = {}) {
  const response = await fetch(`${env.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json', ...init.headers },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

/** Creates a restricted caller key through the gateway's own key API and returns its token. */
export async function makeKey({ agents = ['*'], scopes = ['read', 'invoke'], quota } = {}) {
  const { status, body } = await gateway('/v1/keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'compat-lab-scoped', agents, scopes, ...(quota ? { quota } : {}) }),
  });
  if (status !== 200 || !body?.token) throw new Error(`could not create a key: HTTP ${status} ${JSON.stringify(body)}`);
  return body.token;
}

/** Ids of the newest runs; compare with `runsCreated` (a plain count would saturate at the list limit). */
export async function snapshotRuns() {
  const { body } = await gateway('/v1/runs?limit=200');
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return new Set(list.map((r) => r.id));
}

export async function runsCreated(before) {
  const now = await snapshotRuns();
  return [...now].filter((id) => !before.has(id)).length;
}

/** Which of `names` can the module resolve? Used to skip a client when a package is missing. */
export async function loadOrSkip(lab, specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    lab.skip(`cannot import ${specifier}: ${error.message}`);
    lab.done();
    return undefined;
  }
}

/** Prompt for the ACP stand-in agent: it calls the named caller tools (in parallel groups, one group after another). */
export const acpScript = (...groups) => `Do the task.\nSCRIPT:${JSON.stringify({ groups })}`;
