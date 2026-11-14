/** Small terminal helpers shared by the operator commands (approvals, status, verify). */

/** Display width: CJK and full-width characters take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
  return width;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i === row.length - 1
          ? cell
          : cell + ' '.repeat((widths[i] ?? 0) - displayWidth(cell) + gap),
      )
      .join('')
      .trimEnd(),
  );
}

/** `9m 40s`, `2h 05m`, `3d 4h`; negative or non-finite values read as `0s`. */
export function humanDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export type Out = (line: string) => void;
export const stdoutLine: Out = (line) => void process.stdout.write(line + '\n');
