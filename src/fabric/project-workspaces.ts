import { realpath, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Fault, checkAbort, id, readBounded, writePrivate } from '../core/util.js';

const bindingsSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1),
    bindings: z.record(
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/),
      z.string().min(1).max(4096),
    ),
  })
  .strict();

/** Owner-selected working directories, not a security sandbox. Paths never enter advertisements. */
export class ProjectWorkspaces {
  private bindings: Record<string, string> = {};
  private failure?: Fault;
  private changing = new Set<string>();
  private users = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();
  private writes: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  onChange?: () => void;
  constructor(
    private readonly dataDir: string,
    private readonly owner: string,
  ) {
    this.ready = this.restore();
  }
  private async restore(): Promise<void> {
    try {
      const parsed = bindingsSchema.parse(
        JSON.parse(
          (await readBounded(this.dataDir, 'project-bindings.json', 1_000_000)).toString(),
        ),
      );
      if (parsed.owner !== this.owner) throw new Error('Different project binding owner');
      this.bindings = parsed.bindings;
      this.onChange?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.failure = new Fault(
          'invalid_request',
          'Project binding state is invalid; it was not overwritten.',
        );
    }
  }
  advertised(): string[] {
    return this.failure
      ? []
      : Object.keys(this.bindings).filter((agent) => !this.changing.has(agent));
  }
  async list(): Promise<{ agent: string; path: string }[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    return Object.entries(this.bindings).map(([agent, root]) => ({ agent, path: root }));
  }
  async bind(agent: string, directory: string | null, idle: () => boolean): Promise<void> {
    if (this.changing.has(agent))
      throw new Fault('concurrency_limit', 'This project binding is already being updated.', 429);
    this.changing.add(agent);
    this.onChange?.();
    try {
      await this.ready;
      if (this.failure) throw this.failure;
      if (!idle() || this.users.get(agent))
        throw new Fault(
          'concurrency_limit',
          'Finish the active or queued tasks before changing their project directory.',
          429,
        );
      let root: string | undefined;
      if (directory !== null) {
        if (!path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory))
          throw new Fault(
            'invalid_request',
            'A project binding requires an absolute directory path.',
          );
        root = await realpath(directory);
        if (root === path.parse(root).root || !(await stat(root)).isDirectory())
          throw new Fault(
            'invalid_request',
            'Select an existing project directory, not a filesystem root.',
          );
      }
      const update = this.writes
        .catch(() => {})
        .then(async () => {
          const next = { ...this.bindings };
          if (root) next[agent] = root;
          else delete next[agent];
          const temporary = `project-bindings-${id('write')}.json`;
          await writePrivate(
            this.dataDir,
            temporary,
            JSON.stringify({ version: 1, owner: this.owner, bindings: next }),
            true,
          );
          await rename(
            path.join(this.dataDir, temporary),
            path.join(this.dataDir, 'project-bindings.json'),
          );
          this.bindings = next;
        });
      this.writes = update;
      await update;
    } finally {
      this.changing.delete(agent);
      this.onChange?.();
    }
  }
  async acquire(
    agent: string,
    workspace: string,
    project: boolean,
    signal: AbortSignal,
  ): Promise<{ root: string; release: () => void }> {
    await this.ready;
    checkAbort(signal);
    if (project && (this.failure || this.changing.has(agent) || !this.bindings[agent]))
      throw new Fault(
        'capability_unavailable',
        'The publisher has not bound an available project directory for this agent.',
        503,
      );
    this.users.set(agent, (this.users.get(agent) ?? 0) + 1);
    let unlock: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unlock?.();
      const count = (this.users.get(agent) ?? 1) - 1;
      if (count) this.users.set(agent, count);
      else this.users.delete(agent);
    };
    try {
      const configured = project ? this.bindings[agent]! : workspace;
      const root = await realpath(configured);
      if (project && root !== configured)
        throw new Fault(
          'capability_unavailable',
          'The project directory changed identity; bind it again before using it.',
          503,
        );
      const identity = await stat(root, { bigint: true });
      if (!identity.isDirectory())
        throw new Fault(
          'capability_unavailable',
          'The project directory is no longer available.',
          503,
        );
      const key = `${identity.dev}:${identity.ino}`;
      const previous = this.locks.get(key) ?? Promise.resolve();
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const tail = previous.then(() => held);
      this.locks.set(key, tail);
      void tail.then(() => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Fault('cancelled', 'Workspace acquisition was cancelled.', 409));
      });
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      try {
        await Promise.race([previous, interrupted]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
      checkAbort(signal);
      return { root, release };
    } catch (error) {
      release();
      throw error;
    }
  }
}
