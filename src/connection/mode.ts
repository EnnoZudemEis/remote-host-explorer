/** Unix permission helpers (no VS Code dependency, unit-testable). */

/** Parses "755" or "0644" into a number; undefined if it is not a valid octal mode. */
export function parseMode(text: string): number | undefined {
  const t = text.trim();
  if (!/^[0-7]{3,4}$/.test(t)) return undefined;
  return parseInt(t, 8);
}

/** "rwxr-xr-x" (as shown in the tree) to "755"; undefined for unknown formats. */
export function symbolicToOctal(perms: string | undefined): string | undefined {
  if (!perms || !/^[rwx-]{9}$/.test(perms)) return undefined;
  let out = '';
  for (let i = 0; i < 9; i += 3) {
    out += (perms[i] === 'r' ? 4 : 0) + (perms[i + 1] === 'w' ? 2 : 0) + (perms[i + 2] === 'x' ? 1 : 0);
  }
  return out;
}

/** Three permission digits (r=4, w=2, x=1 each), e.g. (6, 4, 4), to "rw-r--r--". */
export function bitsToSymbolic(user: number, group: number, other: number): string {
  const part = (n: number) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return `${part(user)}${part(group)}${part(other)}`;
}
