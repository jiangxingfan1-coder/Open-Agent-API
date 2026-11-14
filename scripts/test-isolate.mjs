// Per-file isolation for test-offline.mjs --isolate: each test file runs in its own
// `node --test` process with its own time limit. A file that hangs (or leaves handles open) is
// ended with its whole process tree, recorded as a timeout, and the next file still runs.
import { spawn } from 'node:child_process';

/** End a process tree: taskkill /T /F on Windows, the process group elsewhere. */
export function killTree(child, windows = process.platform === 'win32') {
  try {
    if (windows)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => child.kill('SIGKILL'));
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

/** Run one file; resolves to { file, status: 'passed' | 'failed' | 'timeout', code, ms }. */
export function runFile(file, { nodeArgs = [], timeoutMs, stdio = 'inherit' } = {}) {
  const windows = process.platform === 'win32';
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, file], { stdio, detached: !windows });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, windows);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ file, status: 'failed', code: null, ms: Date.now() - started });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const status = timedOut ? 'timeout' : code === 0 && !signal ? 'passed' : 'failed';
      resolve({ file, status, code, ms: Date.now() - started });
    });
  });
}

/** Run every file in order, never stopping early. */
export async function runIsolated(files, options) {
  const results = [];
  for (const file of files) {
    (options.log ?? console.log)(`test-isolate: ${file}`);
    results.push(await runFile(file, options));
  }
  return results;
}

/** One line per non-passing file plus a total line; `ok` is true only when every file passed. */
export function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const lines = results
    .filter((r) => r.status !== 'passed')
    .map((r) => `  ${r.status.toUpperCase()}: ${r.file} (${Math.round(r.ms / 1000)}s)`);
  lines.push(
    `test-isolate: ${results.length} files, ${count('passed')} passed, ${count('failed')} failed, ${count('timeout')} timed out`,
  );
  return { ok: results.every((r) => r.status === 'passed'), text: lines.join('\n') };
}
