import { isSafeRemoteName } from '../connection/paths';
import { makeExcluder } from './glob';

/** Pure comparison logic, no VS Code dependency (unit-testable). */

export type DiffStatus = 'modified' | 'localOnly' | 'remoteOnly' | 'conflict' | 'unchanged' | 'unreadable';

/**
 * 'unreadable': a folder could not be listed on one side, so its content was NOT compared.
 * It is never transferred by bulk actions.
 */

/** True for every status except 'unchanged'. */
export const isDifference = (s: DiffStatus): boolean => s !== 'unchanged';

export interface SideEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  /** ms since epoch */
  mtime: number;
}

export interface Side {
  list(dir: string): Promise<SideEntry[]>;
  read(path: string): Promise<Buffer>;
}

export interface DiffItem {
  /** Path relative to the compare root, posix separators. */
  relPath: string;
  status: DiffStatus;
  local?: SideEntry;
  remote?: SideEntry;
}

export interface CompareOptions {
  exclude?: string[];
  /** Differences in mtime below this value (ms) count as equal. */
  mtimeToleranceMs?: number;
  /**
   * Treat files that differ only in line endings (CRLF vs LF) as equal. Only text files up to 5 MB are
   * checked; for others a different size still means "modified".
   */
  ignoreLineEndings?: boolean;
  /** Also report identical files (status 'unchanged'). Default: only differences. */
  includeUnchanged?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (relPath: string) => void;
}

/** Removes the CR of every CRLF so Windows and Unix line endings compare equal. */
export function normalizeEol(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

const EOL_CHECK_LIMIT = 5 * 1024 * 1024;

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

/**
 * Compares two directory trees. Files with equal size and a differing mtime
 * are verified by comparing their content, so freshly uploaded files
 * (newer remote mtime) are not reported as modified.
 * A file on one side and a folder on the other is reported once as 'conflict'.
 * A folder that cannot be listed (below the root) is reported as 'unreadable' instead of being
 * treated as empty, which would make everything on the other side look like "only there".
 * Returns only differences (plus identical files with includeUnchanged), sorted by path.
 */
export async function compareTrees(
  local: Side,
  remote: Side,
  localRoot: string,
  remoteRoot: string,
  opts: CompareOptions = {},
): Promise<DiffItem[]> {
  const excluded = makeExcluder(opts.exclude);
  const tol = opts.mtimeToleranceMs ?? 2000;
  const result: DiffItem[] = [];

  const lp = (rel: string) => (rel ? `${localRoot.replace(/\/$/, '')}/${rel}` : localRoot);
  const rp = (rel: string) => (rel ? `${remoteRoot.replace(/\/$/, '')}/${rel}` : remoteRoot);

  /** Lists a folder; null if it cannot be read (below the root). Names unsafe as path segments are dropped. */
  async function listSafe(side: Side, p: string, relDir: string): Promise<SideEntry[] | null> {
    try {
      return (await side.list(p)).filter(
        (e) => isSafeRemoteName(e.name, 'linux') && !excluded(join(relDir, e.name), e.name));
    } catch (err) {
      // A failing root listing (bad path, lost connection) must surface; below the root the
      // folder is reported as unreadable.
      if (relDir === '') throw err;
      return null;
    }
  }

  async function collectOnly(rel: string, entry: SideEntry, isLocal: boolean): Promise<void> {
    if (opts.isCancelled?.()) return;
    if (!entry.isDirectory) {
      result.push({
        relPath: rel,
        status: isLocal ? 'localOnly' : 'remoteOnly',
        [isLocal ? 'local' : 'remote']: entry,
      });
      return;
    }
    const side = isLocal ? local : remote;
    const children = await listSafe(side, isLocal ? lp(rel) : rp(rel), rel);
    if (!children) {
      result.push({ relPath: rel, status: 'unreadable', [isLocal ? 'local' : 'remote']: entry });
      return;
    }
    for (const child of children) {
      await collectOnly(join(rel, child.name), child, isLocal);
    }
  }

  async function walk(rel: string): Promise<void> {
    if (opts.isCancelled?.()) return;
    opts.onProgress?.(rel || '/');
    const [l, r] = await Promise.all([listSafe(local, lp(rel), rel), listSafe(remote, rp(rel), rel)]);
    if (!l || !r) {
      result.push({ relPath: rel, status: 'unreadable' });
      return;
    }
    const lm = new Map(l.map((e) => [e.name, e]));
    const rm = new Map(r.map((e) => [e.name, e]));
    const names = new Set([...lm.keys(), ...rm.keys()]);

    for (const name of [...names].sort()) {
      const le = lm.get(name);
      const re = rm.get(name);
      const childRel = join(rel, name);
      if (le && !re) await collectOnly(childRel, le, true);
      else if (!le && re) await collectOnly(childRel, re, false);
      else if (le && re) {
        if (le.isDirectory && re.isDirectory) await walk(childRel);
        else if (le.isDirectory !== re.isDirectory) {
          // type conflict: file on one side, folder on the other
          result.push({ relPath: childRel, status: 'conflict', local: le, remote: re });
        } else if (await differs(childRel, le, re)) {
          result.push({ relPath: childRel, status: 'modified', local: le, remote: re });
        } else if (opts.includeUnchanged) {
          result.push({ relPath: childRel, status: 'unchanged', local: le, remote: re });
        }
      }
    }
  }

  /** Same content, optionally ignoring CRLF/LF differences (text files only). */
  function sameContent(a: Buffer, b: Buffer): boolean {
    if (a.equals(b)) return true;
    if (!opts.ignoreLineEndings || a.includes(0) || b.includes(0)) return false;
    return normalizeEol(a).equals(normalizeEol(b));
  }

  async function differs(rel: string, l: SideEntry, r: SideEntry): Promise<boolean> {
    if (l.size !== r.size) {
      // Sizes differ: only line endings could still make the files equal.
      if (!opts.ignoreLineEndings || l.size > EOL_CHECK_LIMIT || r.size > EOL_CHECK_LIMIT) return true;
      const [a, b] = await Promise.all([local.read(lp(rel)), remote.read(rp(rel))]);
      return !sameContent(a, b);
    }
    if (Math.abs(l.mtime - r.mtime) <= tol) return false;
    const [a, b] = await Promise.all([local.read(lp(rel)), remote.read(rp(rel))]);
    return !sameContent(a, b);
  }

  await walk('');
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
