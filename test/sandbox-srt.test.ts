import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectProcess } from '../src/engines/process.js';
import { SrtLauncher, runtimeReadPaths } from '../src/engines/sandbox.js';

// Real OS-sandbox boundary checks with @anthropic-ai/sandbox-runtime (srt).
// OPENS PORTS: srt's HTTP and SOCKS proxies listen on localhost while these tests run (the
// equivalent of createServer( for the port-classification grep). No request leaves this machine:
// every network probe is expected to be denied before any connection is made.

// Skipped (with the reason shown) where the OS sandbox cannot run: an unsupported platform, or a
// host missing srt's own dependencies (on Linux: bubblewrap, socat and ripgrep). The gateway itself
// reports the same condition as `sandbox_unavailable` instead of running unsandboxed.
async function unavailableReason(): Promise<string> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return 'unsupported platform';
  try {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
    if (!SandboxManager.isSupportedPlatform()) return 'srt does not support this platform';
    const errors = SandboxManager.checkDependencies().errors;
    return errors.length ? `srt dependencies missing: ${errors.join('; ')}` : '';
  } catch (err) {
    return `srt could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
}
const skipReason = await unavailableReason();

async function withLauncher(fn: (launcher: SrtLauncher, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-srt-'));
  const launcher = new SrtLauncher({ dataDir: path.join(root, 'worker') });
  try {
    await fn(launcher, root);
  } finally {
    await launcher.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function sandboxedNode(
  launcher: SrtLauncher,
  workspace: string,
  source: string,
  allowedDomains: string[] = [],
) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace, { recursive: true });
  return JSON.parse(
    await collectProcess(
      process.execPath,
      ['-e', source],
      workspace,
      '',
      AbortSignal.timeout(30_000),
      { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, LANG: 'en_US.UTF-8' },
      {
        launcher,
        policy: { workspace, readOnly: runtimeReadPaths(), allowedDomains, cpuSeconds: 20 },
      },
    ),
  ) as Record<string, unknown>;
}

test(
  'srt self-check verifies the boundary before the sandbox is advertised',
  { skip: skipReason || false },
  async () => {
    await withLauncher(async (launcher) => {
      const report = await launcher.selfCheck();
      assert.ok(report, `self-check failed: ${JSON.stringify(launcher.lastCheck)}`);
      assert.deepEqual(report.kinds, ['script']);
      assert.equal(report.backend, 'srt');
    });
  },
);

test(
  'a sandboxed script cannot read projects, write outside its workspace, see secrets or dial out',
  { skip: skipReason || false },
  async () => {
    await withLauncher(async (launcher, root) => {
      process.env.OAA_SRT_TEST_SECRET = 'must-not-be-visible';
      const outside = path.join(root, 'outside.txt');
      // This repository lives outside the workspace (on macOS under /Volumes or /Users): unreadable.
      const projectFile = path.resolve('package.json');
      try {
        const out = await sandboxedNode(
          launcher,
          path.join(root, 'workspace'),
          `
const fs=require('node:fs'),net=require('node:net');const o={};
try{fs.readFileSync(${JSON.stringify(projectFile)});o.project='read'}catch(e){o.project=e.code}
try{fs.readdirSync(${JSON.stringify(os.homedir())});o.home='listed'}catch(e){o.home=e.code}
try{fs.writeFileSync(${JSON.stringify(outside)},'x');o.outside='written'}catch(e){o.outside=e.code}
fs.writeFileSync('inside.txt','ok');o.inside=fs.readFileSync('inside.txt','utf8');
o.secret=process.env.OAA_SRT_TEST_SECRET??null;o.envKeys=Object.keys(process.env).sort();
const dial=(host,port)=>new Promise(r=>{const s=net.connect({host,port});s.setTimeout(1500);s.on('connect',()=>{s.destroy();r('connected')});s.on('timeout',()=>{s.destroy();r('timeout')});s.on('error',e=>r(e.code))});
(async()=>{o.loopback=await dial('127.0.0.1',8787);o.remote=await dial('192.0.2.1',443);process.stdout.write(JSON.stringify(o))})();`,
        );
        assert.notEqual(out.project, 'read', 'project files outside the workspace');
        assert.notEqual(out.home, 'listed', 'home directory');
        assert.notEqual(out.outside, 'written');
        await assert.rejects(() => readFile(outside));
        assert.equal(out.inside, 'ok', 'the workspace stays writable');
        assert.equal(out.secret, null, 'only the passed environment is visible');
        assert.ok(!(out.envKeys as string[]).some((k) => k.startsWith('OAA_SRT')));
        // Direct connections, including to the local gateway port, are refused by the sandbox.
        assert.ok(['EPERM', 'EACCES'].includes(String(out.loopback)), `loopback: ${out.loopback}`);
        assert.ok(['EPERM', 'EACCES'].includes(String(out.remote)), `remote: ${out.remote}`);
      } finally {
        delete process.env.OAA_SRT_TEST_SECRET;
      }
    });
  },
);

test(
  'the proxy refuses domains outside the call’s allow list',
  { skip: skipReason || false },
  async () => {
    await withLauncher(async (launcher, root) => {
      // Ask the srt proxy (via the HTTPS_PROXY it injected) to tunnel to a domain that is not listed.
      const out = await sandboxedNode(
        launcher,
        path.join(root, 'workspace'),
        `
const http=require('node:http');const p=new URL(process.env.HTTPS_PROXY);
const req=http.request({host:p.hostname,port:p.port,method:'CONNECT',path:'not-allowed.example:443',headers:p.username?{'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')}:{}});
req.on('connect',(res,s)=>{s.destroy();process.stdout.write(JSON.stringify({status:res.statusCode}))});
req.on('response',res=>process.stdout.write(JSON.stringify({status:res.statusCode})));
req.on('error',e=>process.stdout.write(JSON.stringify({error:e.code})));req.end();`,
        ['allowed.example'],
      );
      assert.notEqual(out.status, 200, JSON.stringify(out));
    });
  },
);

test(
  'only one sandboxed process runs at a time (no borrowing of another call’s allow list)',
  { skip: skipReason || false },
  async () => {
    await withLauncher(async (launcher, root) => {
      const policy = { workspace: root, readOnly: [], allowedDomains: [], cpuSeconds: 5 };
      const first = await launcher.wrap('/bin/true', [], {}, policy, new AbortController().signal);
      let secondReady = false;
      const second = launcher
        .wrap('/bin/true', [], {}, policy, new AbortController().signal)
        .then((w) => {
          secondReady = true;
          return w;
        });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(secondReady, false, 'the second call waits for the first to be released');
      first.release();
      (await second).release();
      assert.equal(secondReady, true);
    });
  },
);

test(
  'distinct caller subjects run concurrently on separate srt proxy slots without domain cross-use',
  { skip: skipReason || false },
  async () => {
    await withLauncher(async (launcher, root) => {
      const wsA = path.join(root, 'ws-alice');
      const wsB = path.join(root, 'ws-bob');
      const holdA = await launcher.wrap(
        '/bin/sleep',
        ['5'],
        {},
        {
          workspace: root,
          readOnly: [],
          allowedDomains: ['alice-only.example'],
          cpuSeconds: 5,
          subject: 'key:alice',
        },
        new AbortController().signal,
      );
      try {
        // While Alice's slot is held open, Bob acquires a separate OS sandbox slot immediately
        // and cannot tunnel to Alice's `alice-only.example` domain.
        await import('node:fs/promises').then((fs) => fs.mkdir(wsB, { recursive: true }));
        const probe = `
const http=require('node:http');const p=new URL(process.env.HTTPS_PROXY);
const req=http.request({host:p.hostname,port:p.port,method:'CONNECT',path:'alice-only.example:443',headers:p.username?{'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')}:{}});
req.on('connect',(res,s)=>{s.destroy();process.stdout.write(JSON.stringify({port:p.port,status:res.statusCode}))});
req.on('response',res=>process.stdout.write(JSON.stringify({port:p.port,status:res.statusCode})));
req.on('error',e=>process.stdout.write(JSON.stringify({port:p.port,error:e.code})));req.end();`;
        const text = await collectProcess(
          process.execPath,
          ['-e', probe],
          wsB,
          '',
          AbortSignal.timeout(15_000),
          { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: wsB, LANG: 'en_US.UTF-8' },
          {
            launcher,
            policy: {
              workspace: wsB,
              readOnly: runtimeReadPaths(),
              allowedDomains: ['bob-only.example'],
              cpuSeconds: 10,
              subject: 'key:bob',
            },
          },
        );
        const out = JSON.parse(text) as { port?: string; status?: number; error?: string };
        assert.notEqual(out.status, 200, `Bob must not reach Alice's domain: ${text}`);
        void wsA;
      } finally {
        holdA.release();
      }
    });
  },
);
