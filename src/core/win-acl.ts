/**
 * Windows has no POSIX mode bits: `0o600` on a key file is ignored and the file inherits the
 * directory ACL. This best-effort helper removes inherited entries and grants only the current
 * user full control (`icacls <file> /inheritance:r /grant:r <user>:F`). Failure is silent: the
 * file stays protected only by its parent directory, as documented in docs/windows.md.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';

/** The `icacls` argument list that limits `file` to `user`; exported for tests. */
export function icaclsArgs(file: string, user: string): string[] {
  return [file, '/inheritance:r', '/grant:r', `${user}:F`, '/q'];
}

function currentUser(): string | undefined {
  const name = process.env.USERNAME ?? os.userInfo().username;
  if (!name) return undefined;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${name}` : name;
}

export async function restrictToOwner(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'win32') return false;
  const user = currentUser();
  if (!user) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      execFile('icacls', icaclsArgs(file, user), { windowsHide: true, timeout: 5000 }, (error) =>
        resolve(!error),
      );
    } catch {
      resolve(false);
    }
  });
}
