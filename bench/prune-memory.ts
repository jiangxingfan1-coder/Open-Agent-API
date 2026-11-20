import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const mib = (value: string | undefined) => {
  const m = /^(\d+(?:\.\d+)?)([BKMG]?)$/.exec(value ?? '');
  return m
    ? (Number(m[1]) * ({ B: 1, '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]!] ?? 1)) /
        1024 ** 2
    : null;
};
/** Aggregate OS accounting for the fixture gateway only. Never store addresses or memory contents. */
export async function sampleNativeMemory(pid: number) {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/bin/vmmap', ['-summary', '-wide', String(pid)], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const table = stdout.split(/^MALLOC ZONE\s+/m)[1];
      const row = table
        ?.match(/^TOTAL\s+(.+)$/m)?.[1]
        ?.trim()
        .split(/\s+/);
      if (!row || row.length !== 9 || mib(row[5]) === null)
        return { source: 'vmmap', unavailable: true };
      return {
        source: 'vmmap',
        malloc_resident_mib: mib(row[1]),
        malloc_allocated_mib: mib(row[5]),
        malloc_fragmented_mib: mib(row[6]),
        footprint_mib: mib(stdout.match(/^Physical footprint:\s+(\S+)/m)?.[1]),
      };
    }
    if (process.platform === 'linux') {
      const summary = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const field = (key: string) => {
        const v = summary.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'));
        return v ? Number(v[1]) / 1024 : null;
      };
      return {
        source: 'smaps_rollup',
        anonymous_mib: field('Anonymous'),
        private_dirty_mib: field('Private_Dirty'),
        file_pss_mib: field('Pss_File'),
      };
    }
  } catch {
    /* Some hosts do not permit OS-level sampling. */
  }
  return { unavailable: true };
}
