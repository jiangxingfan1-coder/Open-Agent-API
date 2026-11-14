/**
 * Executable lookup shared by discovery (`init`, `quickstart`, `connect`, `doctor`, ACP presets)
 * and launching. On Windows a bare name or an extension-less path is resolved through PATHEXT,
 * the way `where` does, so `codex` finds `codex.cmd` / `codex.exe`. File metadata only; nothing runs.
 */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Extensions tried for a bare command name, from PATHEXT (lower-cased, with a sane default). */
export function pathExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[a-z0-9]+$/.test(ext));
}

const isFile = (candidate: string) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * `where`-style lookup: a path-like command is checked as given and with each PATHEXT extension;
 * a bare name is searched in every PATH directory. Returns the first existing file.
 */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const exts = pathExtensions(env);
  const hasExt = exts.includes(path.extname(command).toLowerCase());
  const variants = (base: string) => (hasExt ? [base] : [...exts.map((e) => base + e), base]);
  if (path.isAbsolute(command) || /[\\/]/.test(command)) return variants(command).find(isFile);
  const pathEnv = env.PATH ?? env.Path ?? '';
  for (const dir of pathEnv.split(';')) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const found = variants(path.join(trimmed, command)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

/**
 * The JavaScript entry point behind an npm `cmd-shim` launcher (`"%dp0%\node_modules\x\cli.js" %*`),
 * or undefined when the batch file is anything else.
 */
export function npmShimTarget(shimPath: string, text?: string): string | undefined {
  let body = text;
  if (body === undefined) {
    try {
      body = readFileSync(shimPath, 'utf8');
    } catch {
      return undefined;
    }
  }
  if (body.length > 16_384 || !/%\*/.test(body)) return undefined;
  const match = /"%~?dp0%?\\([^"%]+\.(?:js|mjs|cjs))"/i.exec(body);
  if (!match) return undefined;
  const target = path.join(path.dirname(shimPath), match[1]!);
  return text === undefined && !isFile(target) ? undefined : target;
}

/**
 * The first executable `name` on `pathEnv` (cross-platform). On Windows PATHEXT applies; on POSIX
 * the file must be executable. Returns the resolved path, including the extension on Windows.
 */
export function whichSync(
  name: string,
  pathEnv = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return resolveWindowsCommand(name, { ...process.env, PATH: pathEnv });
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; try the next directory.
    }
  }
  return undefined;
}
