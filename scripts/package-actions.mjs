// 打包的副作用层：所有写文件、删文件、执行外部命令都经这里。--dry-run 时只打印、不做。
// 发布模式下额外守住「只写 release/ 之内」：越界的写操作直接报错（安装与链接 CLI 只在本机开发模式出现）。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const quote = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : JSON.stringify(a));

export function createActions({ dryRun, writeRoot, rootDir }) {
  const inRoot = (p) => {
    const rel = path.relative(writeRoot, path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const guard = (op, p) => {
    if (writeRoot && !inRoot(p))
      throw new Error(`发布模式只许写 ${writeRoot} 之内，拒绝 ${op}：${p}`);
  };
  const show = (op, detail) =>
    console.log(`${dryRun ? '\x1b[33m[dry-run]\x1b[0m ' : ''}${op.padEnd(7)} ${detail}`);
  const rel = (p) => {
    const r = path.relative(rootDir, p);
    return r.startsWith('..') ? p : r || '.';
  };

  return {
    dryRun,
    mkdir(p) {
      guard('mkdir', p);
      if (dryRun) return show('mkdir', rel(p));
      fs.mkdirSync(p, { recursive: true });
    },
    rm(p) {
      guard('rm', p);
      if (dryRun) return show('rm', rel(p));
      fs.rmSync(p, { recursive: true, force: true });
    },
    write(p, data, mode) {
      guard('write', p);
      if (dryRun) return show('write', rel(p));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data, mode ? { mode } : undefined);
    },
    /** 拷贝文件或目录；filter(src) 返回 false 的不拷。 */
    copy(from, to, filter) {
      guard('copy', to);
      if (dryRun) return show('copy', `${rel(from)} -> ${rel(to)}`);
      fs.cpSync(from, to, { recursive: true, dereference: true, filter });
    },
    symlink(target, p) {
      guard('symlink', p);
      if (dryRun) return show('symlink', `${rel(p)} -> ${target}`);
      fs.symlinkSync(target, p);
    },
    chmod(p, mode) {
      guard('chmod', p);
      if (dryRun) return show('chmod', `${mode.toString(8)} ${rel(p)}`);
      fs.chmodSync(p, mode);
    },
    /**
     * 执行外部命令；`writes` 是该命令会写的路径（发布模式下逐个校验在 release/ 之内）。
     * `retries` > 1 时失败会重试（GitHub 的 macOS 运行器上 `hdiutil create` 偶发 “Resource busy”）。
     */
    exec(
      cmd,
      args,
      { cwd = rootDir, writes = [], stdio = 'inherit', retries = 1, retryDelayMs = 3000 } = {},
    ) {
      for (const w of writes) guard(`exec ${path.basename(cmd)}`, w);
      if (dryRun) {
        show(
          'exec',
          `${[cmd, ...args].map(quote).join(' ')}${cwd !== rootDir ? `  (cwd ${rel(cwd)})` : ''}${retries > 1 ? `  (失败最多重试到共 ${retries} 次)` : ''}`,
        );
        return '';
      }
      for (let attempt = 1; ; attempt++) {
        try {
          return execFileSync(cmd, args, { cwd, stdio });
        } catch (err) {
          if (attempt >= retries) throw err;
          console.log(
            `${path.basename(cmd)} 第 ${attempt} 次失败（${err.message.split('\n')[0]}），${(attempt * retryDelayMs) / 1000} 秒后重试`,
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * retryDelayMs);
        }
      }
    },
    /** 只读：执行一条查询命令并返回输出（如 `node --version`）。dry-run 也会执行。 */
    query(cmd, args) {
      show('query', [cmd, ...args].map(quote).join(' '));
      return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    },
    sha256(p) {
      if (dryRun) return '<dry-run>';
      return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    },
    note(msg) {
      show('note', msg);
    },
  };
}

/** 目录体积（字节）；filter(rel) 为 false 的跳过。只读。 */
export function dirSize(dir, filter = () => true, base = dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (!filter(p)) continue;
    if (e.isDirectory()) total += dirSize(p, filter, base);
    else if (e.isFile()) total += fs.statSync(p).size;
    else if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(p);
        total += st.isDirectory() ? dirSize(p, filter, base) : st.size;
      } catch {}
    }
  }
  return total;
}

export const formatBytes = (n) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
