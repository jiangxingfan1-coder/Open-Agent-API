import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The container entrypoint (scripts/docker-entrypoint.mjs) run for real against the compiled gateway:
// first start, restart, signals and CLI passthrough. The "container" is a temp directory; the gateway
// listens on 127.0.0.1 only (OAA_HOST), on an ephemeral port, never 8787. Needs `npm run build` first.
// This file listens (to find a free port), so test:offline skips it and `npm test` runs it.

const skip = process.platform === 'win32' ? 'POSIX signals needed' : false;
const entrypoint = path.resolve('scripts/docker-entrypoint.mjs');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

type Running = { child: ChildProcess; log: () => string; exited: Promise<number | null> };

function start(dir: string, port: number, extra: Record<string, string> = {}): Running {
  let log = '';
  const child = spawn(process.execPath, [entrypoint], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      OAA_APP_DIR: path.resolve('.'),
      OAA_DATA_DIR: path.join(dir, '.oaa'),
      OAA_HOST: '127.0.0.1',
      OAA_PORT: String(port),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (log += d));
  child.stderr!.on('data', (d: Buffer) => (log += d));
  return {
    child,
    log: () => log,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  };
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const chat = async (port: number, key: string, text: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'agent/sample', messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
};

test(
  'docker entrypoint: first start, API call, restart, host allowlist, SIGTERM, CLI passthrough',
  { skip },
  async () => {
    assert.ok(existsSync('dist/src/cli.js'), 'run npm run build first');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-docker-'));
    const port = await freePort();
    const keyFile = path.join(dir, '.oaa', 'keys', 'quickstart.key');
    const adminFile = path.join(dir, '.oaa', 'admin.token');
    let first: Running | undefined;
    let second: Running | undefined;
    try {
      first = start(dir, port, { OAA_ALLOWED_HOSTS: 'api.example.com' });
      await until('the summary line', () => first!.log().includes('curl http'));
      const out = first.log();
      assert.match(out, /Initialized the data directory/);
      assert.ok(out.includes(adminFile) && out.includes(keyFile), 'key file locations are printed');
      const admin = (await readFile(adminFile, 'utf8')).trim();
      const key = (await readFile(keyFile, 'utf8')).trim();
      assert.ok(!out.includes(admin) && !out.includes(key), 'neither key is printed');
      assert.equal(statSync(keyFile).mode & 0o077, 0, 'key file is private');

      const answer = await chat(port, key, 'Hello');
      assert.equal(answer.status, 200, answer.body);
      assert.match(answer.body, /offline sample agent/, 'the sample agent subprocess answered');

      const config = JSON.parse(await readFile(path.join(dir, '.oaa', 'config.json'), 'utf8')) as {
        host: string;
        port: number;
        allowedHosts: string[];
      };
      assert.deepEqual(config.allowedHosts, ['127.0.0.1', 'localhost', '[::1]', 'api.example.com']);
      const probe = (host: string) =>
        new Promise<number>((resolve, reject) => {
          // fetch cannot set Host, so speak HTTP directly.
          const socket = net.connect(port, '127.0.0.1', () =>
            socket.write(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
          );
          let data = '';
          socket.on('data', (d) => (data += d));
          socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1])));
          socket.on('error', reject);
        });
      assert.equal(await probe('api.example.com'), 200);
      assert.equal(await probe('evil.example.net'), 403);

      first.child.kill('SIGTERM');
      assert.equal(await first.exited, 0, 'SIGTERM ends the container cleanly');
      await until(
        'the port to close',
        async () =>
          !(await chat(port, key, 'x').then(
            () => true,
            () => false,
          )),
      );

      // Restart on the same data: nothing is created twice, the caller key keeps working.
      second = start(dir, port, { OAA_ALLOWED_HOSTS: 'api.example.com' });
      await until('the summary line after restart', () => second!.log().includes('curl http'));
      assert.match(second.log(), /Using the existing data directory/);
      assert.equal((await readFile(keyFile, 'utf8')).trim(), key);
      assert.equal((await chat(port, key, 'again')).status, 200);
      second.child.kill('SIGTERM');
      assert.equal(await second.exited, 0);

      // `docker run IMAGE <args>` hands the arguments to the oaa CLI.
      const help = spawnSync(process.execPath, [entrypoint, '--help'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', OAA_APP_DIR: path.resolve('.') },
      });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /oaa quickstart/);
    } finally {
      for (const run of [first, second])
        if (run && run.child.exitCode === null) run.child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('docker entrypoint: a bad OAA_PORT stops before anything starts', { skip }, () => {
  const r = spawnSync(process.execPath, [entrypoint], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', OAA_PORT: 'not-a-port', OAA_APP_DIR: path.resolve('.') },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OAA_PORT/);
});
