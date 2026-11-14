/**
 * `oaa doctor`: a read-only look at this machine (which agent CLIs are installed, what the gateway
 * configuration contains). `--write` additionally records newly found ACP agents as disabled adapters.
 * Nothing is executed and no model is called.
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { discoverAcpAgents, discoveredAdapterEntry } from '../config/agent-presets.js';
import { exposureHint } from '../config/security-profile.js';
import { gatewaySchema, loadConfig } from '../config/config.js';
import { pick } from '../core/locale.js';
import { Fault, writePrivate } from '../core/util.js';
import { claudeSdkStatus } from '../engines/claude-sdk.js';
import { CLI_TEXT } from './cli-text.js';

export async function doctorReport(file: string, write: boolean): Promise<Record<string, unknown>> {
  const binaries: Record<string, unknown> = {};
  for (const name of ['codex', 'claude', 'agy', 'dsh']) {
    let found: string | undefined;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const p = path.join(dir, name);
      try {
        await access(p, constants.X_OK);
        found = p;
        break;
      } catch {}
    }
    binaries[name] = {
      executable: found ?? null,
      status: found ? 'installed_not_exercised' : 'not_found',
      // Release packages do not ship the proprietary Claude Agent SDK the Claude engine imports.
      ...(name === 'claude' ? { sdk: claudeSdkStatus() } : {}),
    };
  }
  let config: unknown;
  let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    const c = await loadConfig(file);
    loaded = c;
    config = {
      host: c.host,
      port: c.port,
      providers: Object.keys(c.localWorker?.providers ?? {}),
      native: c.localWorker?.native
        ? Object.fromEntries(
            Object.entries(c.localWorker.native).map(([k, v]) => [k, { enabled: v?.enabled }]),
          )
        : {},
      adapters: Object.fromEntries(
        Object.entries(c.localWorker?.adapters ?? {}).map(([k, v]) => [
          k,
          {
            transport: v.transport,
            enabled: v.enabled,
            ...(v.transport === 'acp' && v.preset ? { preset: v.preset } : {}),
          },
        ]),
      ),
    };
  } catch {
    config = { status: 'not_initialized' };
  }
  // ACP agents are found by executable file name only; nothing is executed or enabled.
  const configuredAdapters = Object.entries(loaded?.localWorker?.adapters ?? {});
  const discovered = (await discoverAcpAgents()).map((found) => ({
    found,
    configured: configuredAdapters.some(
      ([name, a]) => a.transport === 'acp' && (a.preset ?? name) === found.preset.id,
    ),
  }));
  let written: string[] | undefined;
  if (write) {
    if (!loaded?.localWorker) throw new Fault('worker_required', CLI_TEXT.doctorWriteNeedsWorker);
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      localWorker: { adapters?: Record<string, unknown> };
    };
    const adapters = (raw.localWorker.adapters ??= {});
    written = [];
    for (const { found, configured } of discovered) {
      if (configured || Object.hasOwn(adapters, found.preset.id)) continue;
      adapters[found.preset.id] = discoveredAdapterEntry(found);
      written.push(found.preset.id);
    }
    if (written.length) {
      gatewaySchema.parse(raw);
      await writePrivate(
        path.dirname(file),
        path.basename(file),
        JSON.stringify(raw, null, 2) + '\n',
      );
    }
  }
  return {
    protocol: 'oaa/1',
    node: process.version,
    binaries,
    acp_agents: discovered.map(({ found, configured }) => ({
      preset: found.preset.id,
      name: found.preset.name,
      executable: found.executable,
      args: found.args,
      maturity: found.preset.maturity,
      status: 'installed_not_exercised',
      configured,
    })),
    config,
    security_exposure: loaded ? exposureHint(loaded) : undefined,
    ...(written
      ? {
          written_disabled_adapters: written,
          restart_required: written.length > 0,
          note: pick(CLI_TEXT.doctorWriteNote),
        }
      : {}),
    live_model_calls: false,
  };
}
