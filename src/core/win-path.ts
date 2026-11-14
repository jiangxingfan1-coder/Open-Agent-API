/**
 * Path segments that are harmless on POSIX but mean something else to Windows: `a:b` names an
 * NTFS alternate data stream (or a drive), `CON` / `NUL` / `COM1` are devices in every directory,
 * and a trailing dot or space is silently stripped (so `key.` aliases `key`). Workspace-relative
 * names containing them are rejected on Windows instead of escaping or aliasing a file.
 */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.[^.]*)?$/i;

export function windowsUnsafeSegment(segment: string): boolean {
  return /[:*?"<>|]/.test(segment) || /[. ]$/.test(segment) || RESERVED.test(segment);
}
