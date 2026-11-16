import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Document, isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import { Fault, sha } from '../core/util.js';

export type ClientFile = { file: string; text: string | null; revision: string; mode: number };
const MAX_BYTES = 4 * 1024 * 1024;
export const clientConflict = () =>
  new Fault(
    'local_connection_conflict',
    'The client configuration changed or is locked. Refresh the preview.',
    409,
  );
export const clientInvalid = () =>
  new Fault(
    'local_connection_invalid',
    'The client configuration cannot be safely edited. Check its format, permissions and file type.',
    400,
  );

export async function readClientFile(file: string, privateFile = false): Promise<ClientFile> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_BYTES ||
      (privateFile && process.platform !== 'win32' && info.mode & 0o077)
    )
      throw clientInvalid();
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) throw clientInvalid();
    return { file, text, revision: sha(`present:${text}`), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { file, text: null, revision: sha('missing'), mode: 0o600 };
    if (error instanceof Fault) throw error;
    throw clientInvalid();
  } finally {
    await handle?.close();
  }
}

export function yamlMap(snapshot: ClientFile): Document {
  const doc: Document = parseDocument(snapshot.text ?? '{}\n', { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw clientInvalid();
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw clientInvalid();
  try {
    doc.toJS({ maxAliasCount: 32 });
  } catch {
    throw clientInvalid();
  }
  return doc;
}

export function jsonMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw clientInvalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw clientInvalid();
  return value as Record<string, unknown>;
}

/** Replacing an anchored subtree could break or silently change unrelated aliases. */
export function guardYamlWrite(doc: Document, keys: string[]): void {
  const guard = (node: unknown, annotations = false) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) throw clientInvalid();
    if (annotations && isNode(node) && (node.comment || node.commentBefore)) throw clientConflict();
  };
  let node: unknown = doc.contents;
  for (const [index, key] of keys.entries()) {
    guard(node);
    if (node === undefined || node === null) return;
    if (!isMap(node)) throw clientInvalid();
    if (index === keys.length - 1) {
      const pair = node.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
      if (pair) guard(pair.key, true);
    }
    node = node.get(key, true);
  }
  if (isNode(node))
    visit(node, (_key, child) => {
      guard(child, true);
    });
}

export function hasYamlAnnotations(node: unknown): boolean {
  if (!isNode(node)) return false;
  let found = false;
  visit(node, (_key, child) => {
    if (
      isNode(child) &&
      (child.comment || child.commentBefore || ('anchor' in child && child.anchor))
    )
      found = true;
  });
  return found;
}

/** Same public writer-lock protocol as DSH: exclusive <file>.lock, never steal a lock. */
export async function withClientLocks<T>(files: string[], fn: () => Promise<T>): Promise<T> {
  const owned: { file: string; ino: number; dev: number }[] = [];
  try {
    for (const file of [...files].sort()) {
      const lock = `${file}.lock`;
      const until = Date.now() + 2000;
      for (;;) {
        try {
          const handle = await open(lock, 'wx', 0o600);
          try {
            const info = await handle.stat();
            owned.push({ file: lock, ino: info.ino, dev: info.dev });
            await handle.writeFile(`${process.pid}\n`);
          } finally {
            await handle.close();
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw clientInvalid();
          if (Date.now() >= until) throw clientConflict();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    return await fn();
  } finally {
    for (const lock of owned.reverse()) {
      const info = await lstat(lock.file).catch(() => null);
      if (info?.ino === lock.ino && info.dev === lock.dev) await unlink(lock.file);
    }
  }
}

/** Caller holds the client lock. Revision checking also catches editors that ignore that lock. */
export async function replaceClientFile(
  before: ClientFile,
  text: string | null,
): Promise<ClientFile> {
  if ((await readClientFile(before.file)).revision !== before.revision) throw clientConflict();
  if (text === before.text) return before;
  if (text === null) {
    await unlink(before.file);
    return readClientFile(before.file);
  }
  if (Buffer.byteLength(text) > MAX_BYTES) throw clientInvalid();
  const temp = `${before.file}.oaa-${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readClientFile(before.file)).revision !== before.revision) throw clientConflict();
    await rename(temp, before.file);
    return readClientFile(before.file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
