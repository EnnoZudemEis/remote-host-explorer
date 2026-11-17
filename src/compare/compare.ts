import { makeExcluder } from './glob';

/** Pure comparison logic, no VS Code dependency (unit-testable). */

export type DiffStatus = 'modified' | 'localOnly' | 'remoteOnly';

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
  isCancelled?: () => boolean;
  onProgress?: (relPath: string) => void;
}

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

/**
 * Compares two directory trees. Files with equal size and a differing mtime
 * are verified by comparing their content, so freshly uploaded files
 * (newer remote mtime) are not reported as modified.
 * Returns only differences, sorted by path.
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

  async function listSafe(side: Side, p: string, relDir: string): Promise<SideEntry[]> {
    try {
      return (await side.list(p)).filter((e) => !excluded(join(relDir, e.name), e.name));
    } catch (err) {
      // A failing root listing (bad path, lost connection) must surface; below the root a
      // listing error is treated as an unreadable folder.
      if (relDir === '') throw err;
      return [];
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
    for (const child of await listSafe(side, isLocal ? lp(rel) : rp(rel), rel)) {
      await collectOnly(join(rel, child.name), child, isLocal);
    }
  }

  async function walk(rel: string): Promise<void> {
    if (opts.isCancelled?.()) return;
    opts.onProgress?.(rel || '/');
    const [l, r] = await Promise.all([listSafe(local, lp(rel), rel), listSafe(remote, rp(rel), rel)]);
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
          // type conflict: report both sides
          await collectOnly(childRel, le, true);
          await collectOnly(childRel, re, false);
        } else if (await differs(childRel, le, re)) {
          result.push({ relPath: childRel, status: 'modified', local: le, remote: re });
        }
      }
    }
  }

  async function differs(rel: string, l: SideEntry, r: SideEntry): Promise<boolean> {
    if (l.size !== r.size) return true;
    if (Math.abs(l.mtime - r.mtime) <= tol) return false;
    const [a, b] = await Promise.all([local.read(lp(rel)), remote.read(rp(rel))]);
    return !a.equals(b);
  }

  await walk('');
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
