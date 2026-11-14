import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// scripts/install.sh end to end, offline: the "release page" is a local directory reached through a
// file:// URL, and uname/ldd are shimmed so the script believes it runs on glibc Linux x86_64 (also on
// macOS CI). Nothing listens on a port; nothing leaves the temp directory.

type Mod = Record<string, any>;
const load = (file: string): Promise<Mod> => import(pathToFileURL(path.resolve(file)).href);
const plan = await load('scripts/release-plan.mjs');
const linux = await load('scripts/package-linux.mjs');
const skip = process.platform === 'win32' ? 'needs a POSIX shell' : false;
const installSh = await readFile('scripts/install.sh', 'utf8');
const VERSION = '9.9.9';

type Env = { home: string; shims: string; release: string; prefix: string; root: string };

async function setup(): Promise<Env> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oaa-install-'));
  const shims = path.join(root, 'shims');
  await mkdir(shims);
  const shim = async (name: string, body: string) => {
    await writeFile(path.join(shims, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(shims, name), 0o755);
  };
  await shim('uname', 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  await shim('ldd', 'echo "ldd (GNU libc) 2.35"');
  const env = {
    root,
    shims,
    home: path.join(root, 'home'),
    release: path.join(root, 'release'),
    prefix: path.join(root, '安装 前缀'),
  };
  await mkdir(env.home);
  await mkdir(env.release);
  return env;
}

/** Builds the release directory the way package-all does: a .tar.gz of Open-Agent-API-linux-x64 and SHA256SUMS. */
async function publish(env: Env, marker: string, version = VERSION, withRuntime = true) {
  const bundle = path.join(env.root, 'Open-Agent-API-linux-x64');
  await rm(bundle, { recursive: true, force: true });
  await mkdir(path.join(bundle, 'app', 'dist', 'src'), { recursive: true });
  await writeFile(
    path.join(bundle, 'app', 'dist', 'src', 'cli.js'),
    `console.log(${JSON.stringify(marker)} + ' ' + process.argv.slice(2).join(' '));\n`,
  );
  await writeFile(path.join(bundle, 'oaa'), linux.launcher(linux.nodeRequirement('>=24.18.0 <25')));
  await chmod(path.join(bundle, 'oaa'), 0o755);
  if (withRuntime) {
    // The stub stands in for the official Node runtime (a Linux binary cannot run on a macOS developer machine).
    await mkdir(path.join(bundle, 'runtime', 'bin'), { recursive: true });
    await writeFile(
      path.join(bundle, 'runtime', 'bin', 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
    );
    await chmod(path.join(bundle, 'runtime', 'bin', 'node'), 0o755);
  }
  const name = plan.artifactName(version, 'linux', 'x64', 'tar.gz');
  const tar = spawnSync(
    'tar',
    ['-czf', path.join(env.release, name), '-C', env.root, 'Open-Agent-API-linux-x64'],
    { encoding: 'utf8' },
  );
  assert.equal(tar.status, 0, tar.stderr);
  const hash = createHash('sha256')
    .update(await readFile(path.join(env.release, name)))
    .digest('hex');
  await writeFile(
    path.join(env.release, 'SHA256SUMS'),
    plan.sha256sumsText([{ file: name, hash }]),
  );
  return { name, hash };
}

function runScript(
  env: Env,
  args: string[],
  overrides: Record<string, string> = {},
  script?: string,
) {
  return spawnSync(
    'sh',
    script ? ['-s', '--', ...args] : [path.resolve('scripts/install.sh'), ...args],
    {
      encoding: 'utf8',
      input: script,
      timeout: 60_000,
      env: {
        PATH: `${env.shims}:${process.env.PATH}`,
        HOME: env.home,
        TMPDIR: env.root,
        OAA_DOWNLOAD_BASE: pathToFileURL(env.release).href,
        ...overrides,
      },
    },
  );
}

const link = (env: Env) => path.join(env.prefix, 'bin', 'oaa');
const dest = (env: Env) => path.join(env.prefix, 'share', 'open-agent-api');
const clean = (env: Env) => rm(env.root, { recursive: true, force: true });

test('install.sh: the script parses with sh -n, and so does the stamped copy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oaa-sh-n-'));
  try {
    await writeFile(path.join(dir, 'stamped.sh'), plan.stampInstallScript(installSh, '1.2.3'));
    for (const file of [path.resolve('scripts/install.sh'), path.join(dir, 'stamped.sh')])
      assert.equal(spawnSync('sh', ['-n', file], { encoding: 'utf8' }).status, 0, file);
    assert.equal(
      spawnSync('sh', [path.resolve('scripts/install.sh'), '--help'], { encoding: 'utf8' }).status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install.sh: installs, links the launcher, and runs through the link', { skip }, async () => {
  const env = await setup();
  try {
    await publish(env, 'fake-oaa-one');
    const r = runScript(env, ['--version', VERSION, '--prefix', env.prefix]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /SHA-256 verified/);
    assert.match(r.stdout, /export PATH=/, 'tells the user how to put the link on PATH');
    assert.ok(lstatSync(link(env)).isSymbolicLink());
    assert.equal(readlinkSync(link(env)), path.join(dest(env), 'oaa'));
    const run = spawnSync(link(env), ['--help'], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'fake-oaa-one --help');
    assert.deepEqual(
      await readdir(path.join(env.prefix, 'share')),
      ['open-agent-api'],
      'no leftovers',
    );
    assert.ok(!existsSync(path.join(env.home, '.profile')), 'no shell profile was touched');
    // An upgrade replaces the previous installation and leaves nothing behind.
    await publish(env, 'fake-oaa-two');
    const again = runScript(env, ['--version', VERSION, '--prefix', env.prefix]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(spawnSync(link(env), [], { encoding: 'utf8' }).stdout.trim(), 'fake-oaa-two');
    assert.deepEqual(await readdir(path.join(env.prefix, 'share')), ['open-agent-api']);
  } finally {
    await clean(env);
  }
});

test(
  'install.sh: a stamped copy installs its own version without --version',
  { skip },
  async () => {
    const env = await setup();
    try {
      await publish(env, 'stamped', '3.2.1');
      const script = plan.stampInstallScript(installSh, '3.2.1');
      const r = runScript(env, ['--prefix', env.prefix], {}, script);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /Installed Open Agent API 3\.2\.1/);
    } finally {
      await clean(env);
    }
  },
);

test('install.sh: a bad checksum or a missing entry installs nothing', { skip }, async () => {
  const env = await setup();
  try {
    const { name } = await publish(env, 'x');
    await writeFile(path.join(env.release, 'SHA256SUMS'), `${'0'.repeat(64)}  ${name}\n`);
    const bad = runScript(env, ['--version', VERSION, '--prefix', env.prefix]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /mismatch/);
    await writeFile(path.join(env.release, 'SHA256SUMS'), `${'0'.repeat(64)}  other.tar.gz\n`);
    const missing = runScript(env, ['--version', VERSION, '--prefix', env.prefix]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no entry/);
    for (const p of [dest(env), link(env)]) assert.ok(!existsSync(p), `${p} must not exist`);
    assert.deepEqual(
      await readdir(path.join(env.prefix, 'share')),
      [],
      'the temporary directory is removed',
    );
  } finally {
    await clean(env);
  }
});

test(
  'install.sh: refuses musl, non-Linux systems, a foreign oaa link and bad arguments',
  { skip },
  async () => {
    const env = await setup();
    try {
      await publish(env, 'x');
      const args = ['--version', VERSION, '--prefix', env.prefix];
      await writeFile(path.join(env.shims, 'ldd'), '#!/bin/sh\necho "musl libc (x86_64)"\n');
      assert.match(runScript(env, args).stderr, /musl.*Docker/s);
      await writeFile(path.join(env.shims, 'ldd'), '#!/bin/sh\necho glibc\n');
      await writeFile(path.join(env.shims, 'uname'), '#!/bin/sh\necho Darwin\n');
      assert.match(runScript(env, args).stderr, /for Linux/);
      await writeFile(
        path.join(env.shims, 'uname'),
        '#!/bin/sh\ncase "$1" in -m) echo x86_64;; *) echo Linux;; esac\n',
      );
      // A regular file already sitting at PREFIX/bin/oaa is never overwritten.
      await mkdir(path.join(env.prefix, 'bin'), { recursive: true });
      await writeFile(link(env), 'mine\n');
      const foreign = runScript(env, args);
      assert.notEqual(foreign.status, 0);
      assert.match(foreign.stderr, /already exists/);
      assert.equal(await readFile(link(env), 'utf8'), 'mine\n');
      assert.ok(!existsSync(dest(env)));
      // So is a link to somebody else's oaa; --uninstall leaves both alone.
      await rm(link(env));
      await symlink('/usr/bin/true', link(env));
      assert.notEqual(runScript(env, args).status, 0);
      runScript(env, ['--uninstall', '--prefix', env.prefix]);
      assert.equal(readlinkSync(link(env)), '/usr/bin/true');
      for (const bad of [['--version', 'a/b'], ['--bogus'], ['--version']])
        assert.notEqual(runScript(env, [...bad, '--prefix', env.prefix]).status, 0, bad.join(' '));
    } finally {
      await clean(env);
    }
  },
);

test(
  'install.sh: --uninstall removes the installation and its link, never the data directories',
  { skip },
  async () => {
    const env = await setup();
    try {
      await publish(env, 'x');
      runScript(env, ['--version', VERSION, '--prefix', env.prefix]);
      const data = path.join(env.root, 'work', '.oaa');
      await mkdir(data, { recursive: true });
      const r = runScript(env, ['--uninstall', '--prefix', env.prefix]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!existsSync(dest(env)) && !existsSync(link(env)));
      assert.ok(existsSync(data));
      assert.match(
        runScript(env, ['--uninstall', '--prefix', env.prefix]).stdout,
        /Nothing to remove/,
      );
    } finally {
      await clean(env);
    }
  },
);

test(
  'install.sh: a download cut short anywhere runs nothing (curl | sh safety)',
  { skip },
  async () => {
    const env = await setup();
    try {
      await publish(env, 'x');
      const full = installSh;
      const cuts = new Set<number>();
      for (let i = 0; i < full.length; i++) if (full[i] === '\n') cuts.add(i + 1);
      const lastLine = full.trimEnd().lastIndexOf('\n') + 1;
      for (let i = lastLine; i < full.trimEnd().length; i++) cuts.add(i); // every prefix of the final call
      cuts.add(7);
      cuts.add(full.length >> 1);
      let checked = 0;
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        if (cut >= full.trimEnd().length) continue; // the complete script is allowed to run
        runScript(env, ['--version', VERSION, '--prefix', env.prefix], {}, full.slice(0, cut));
        checked++;
        assert.ok(
          !existsSync(env.prefix),
          `cut at ${cut} (${JSON.stringify(full.slice(Math.max(0, cut - 20), cut))}) ran the installer`,
        );
      }
      assert.ok(checked > 100);
      // Control: the whole script does run.
      assert.equal(
        runScript(env, ['--version', VERSION, '--prefix', env.prefix], {}, full).status,
        0,
      );
      assert.ok(existsSync(dest(env)));
    } finally {
      await clean(env);
    }
  },
);

test(
  'Linux launcher: follows symlinks, prefers runtime/bin/node and falls back to a Node on PATH',
  { skip },
  async () => {
    const env = await setup();
    try {
      await publish(env, 'with-runtime');
      const bundle = path.join(env.root, 'Open-Agent-API-linux-x64');
      const viaLink = path.join(env.root, 'oaa-link');
      await symlink(path.join(bundle, 'oaa'), viaLink);
      const a = spawnSync(viaLink, ['a b', 'c'], { encoding: 'utf8' });
      assert.equal(a.stdout.trim(), 'with-runtime a b c');
      // No bundled runtime: the launcher uses the PATH's Node when its version fits engines.
      await rm(path.join(bundle, 'runtime'), { recursive: true });
      const b = spawnSync(viaLink, ['x'], {
        encoding: 'utf8',
        env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
      });
      assert.equal(b.stdout.trim(), 'with-runtime x', b.stderr);
      assert.match(
        linux.readme('1.2.3', 'x64', linux.nodeRequirement('>=24.18.0 <25')),
        /oaa quickstart/,
      );
    } finally {
      await clean(env);
    }
  },
);
