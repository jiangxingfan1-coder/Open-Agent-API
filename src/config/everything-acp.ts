import path from 'node:path';
import { z } from 'zod';
import { workerSchema } from './config.js';
import { executableExists, Fault } from '../core/util.js';
import { readClientFile } from './local-client-files.js';
import { lstat, opendir } from 'node:fs/promises';
import { faultOf, sha } from '../core/util.js';

export async function discoverEverythingAcp(directory: string) {
  if (!path.isAbsolute(directory) || !(await lstat(directory).catch(() => null))?.isDirectory())
    throw new Fault('invalid_request', 'Choose an absolute wrapper output directory.');
  const data: { id: string; client_file: string; ready: boolean; error?: string }[] = [];
  let visited = 0,
    truncated = false;
  const scan = async (current: string, depth: number) => {
    if (depth > 2 || truncated) return;
    const entries = await opendir(current).catch(() => {
      if (depth === 0) throw new Fault('invalid_request', 'The wrapper directory is not readable.');
      return undefined;
    });
    if (!entries) return;
    for await (const entry of entries) {
      if (++visited > 1000 || data.length >= 256) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && !['node_modules', 'runtime', '.git'].includes(entry.name))
        await scan(file, depth + 1);
      else if (entry.isFile() && entry.name === 'client.json') {
        const name =
          path
            .basename(current)
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^[-_]+/, '')
            .slice(0, 50) || 'wrapped';
        const id = `${name}-${sha(file).slice(0, 8)}`;
        try {
          await readEverythingAcpClient(file);
          data.push({ id, client_file: file, ready: true });
        } catch (error) {
          data.push({ id, client_file: file, ready: false, error: faultOf(error).code });
        }
      }
    }
  };
  await scan(directory, 0);
  return { data: data.sort((a, b) => a.id.localeCompare(b.id)), truncated, executed: false };
}

/** Only the launch descriptor crosses projects; OAA does not copy or modify the wrapper. */
export async function readEverythingAcpClient(file: string) {
  if (!path.isAbsolute(file))
    throw new Fault('invalid_request', 'The EverythingACP client.json path must be absolute.');
  let raw: unknown;
  try {
    const contents = (await readClientFile(file)).text;
    if (contents === null || Buffer.byteLength(contents) > 64 * 1024)
      throw new Error('Invalid descriptor');
    raw = JSON.parse(contents);
  } catch {
    throw new Fault(
      'invalid_request',
      'The wrapper launch descriptor must be a readable JSON file.',
    );
  }
  const descriptor = z
    .object({
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64).default([]),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict()
    .parse(raw);
  if (
    !path.isAbsolute(descriptor.command) ||
    !executableExists(descriptor.command, { fresh: true })
  )
    throw new Fault(
      'backend_unavailable',
      'The wrapper descriptor must use an installed absolute executable.',
      409,
    );
  if (Object.keys(descriptor.env).length)
    throw new Fault(
      'invalid_request',
      'Import does not copy environment secrets. Configure required variables in the worker environment.',
    );
  return workerSchema.shape.adapters.parse({
    wrapper: {
      transport: 'acp',
      command: descriptor.command,
      args: descriptor.args,
      enabled: false,
    },
  }).wrapper!;
}
