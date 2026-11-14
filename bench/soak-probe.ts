// Preloaded into the gateway under soak (`node --import dist/bench/soak-probe.js dist/src/cli.js
// serve ...`). Every SOAK_PROBE_MS it appends one JSON line with this process's memory and
// active handle counts to SOAK_PROBE_FILE. It changes nothing else in the process.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { writeHeapSnapshot } from 'node:v8';

const file = process.env.SOAK_PROBE_FILE;
if (file) {
  // With --expose-gc the probe collects first, so the heap figure is live data, not GC lag.
  const collect = (globalThis as { gc?: () => void }).gc;
  const sample = () => {
    collect?.();
    const memory = process.memoryUsage();
    const resources: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo())
      resources[kind] = (resources[kind] ?? 0) + 1;
    appendFileSync(
      file,
      JSON.stringify({
        t: Date.now(),
        pid: process.pid,
        rss: memory.rss,
        heap_used: memory.heapUsed,
        heap_total: memory.heapTotal,
        external: memory.external,
        handles: Object.values(resources).reduce((n, v) => n + v, 0),
        resources,
      }) + '\n',
    );
  };
  setInterval(sample, Number(process.env.SOAK_PROBE_MS) || 5000).unref();
  // One line as soon as JavaScript runs, so a slow start can be split into process start-up and
  // gateway initialisation (the first interval sample needs a free event loop).
  appendFileSync(file, JSON.stringify({ t: Date.now(), pid: process.pid, boot: true }) + '\n');
}

// With SOAK_SNAPSHOT_DIR set, SIGUSR2 writes a heap snapshot there (for leak hunting).
const snapshots = process.env.SOAK_SNAPSHOT_DIR;
if (snapshots)
  process.on('SIGUSR2', () => {
    (globalThis as { gc?: () => void }).gc?.();
    writeHeapSnapshot(path.join(snapshots, `gateway-${Date.now()}.heapsnapshot`));
  });
