import * as path from 'path';
import { RemoteEntry } from '../connection/types';
import { isSafeRemoteName } from '../connection/paths';
import { globToRegExp, makeExcluder } from './glob';

/** Name search on a server (no VS Code dependency, unit-testable). */

/**
 * "readme" matches every name containing it (case-insensitive); a query with * or ? is a glob
 * ("*.php", "index.??") that has to match the whole name, also case-insensitive.
 */
export function buildMatcher(query: string): (name: string) => boolean {
  const q = query.trim();
  if (/[*?]/.test(q)) {
    const re = new RegExp(globToRegExp(q).source, 'i');
    return (name) => re.test(name);
  }
  const lower = q.toLowerCase();
  return (name) => name.toLowerCase().includes(lower);
}

export interface SearchOptions {
  /** Stop after this many hits (default 500). */
  limit?: number;
  /** Exclude patterns (same syntax as the server excludes); excluded folders are not entered. */
  exclude?: string[];
  isCancelled?: () => boolean;
  /** Called before a folder is listed (for progress). */
  onFolder?: (dir: string) => void;
}

export interface SearchResult {
  hits: RemoteEntry[];
  /** Folders that could not be listed. */
  unreadable: number;
  /** The hit limit was reached, there may be more. */
  truncated: boolean;
  cancelled: boolean;
  /** Number of folders listed. */
  folders: number;
}

/** Depth-first search below `root`; files and folders whose name matches are returned. */
export async function searchTree(
  list: (dir: string) => Promise<RemoteEntry[]>,
  root: string,
  matches: (name: string) => boolean,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const limit = opts.limit ?? 500;
  const excluded = makeExcluder(opts.exclude);
  const result: SearchResult = { hits: [], unreadable: 0, truncated: false, cancelled: false, folders: 0 };

  async function walk(dir: string): Promise<void> {
    if (opts.isCancelled?.()) { result.cancelled = true; return; }
    opts.onFolder?.(dir);
    let entries: RemoteEntry[];
    try {
      entries = await list(dir);
    } catch {
      result.unreadable++;
      return;
    }
    result.folders++;
    for (const e of entries) {
      if (result.truncated || result.cancelled) return;
      if (!isSafeRemoteName(e.name, 'linux')) continue;
      if (excluded(path.posix.relative(root, e.path), e.name)) continue;
      if (matches(e.name)) {
        if (result.hits.length >= limit) { result.truncated = true; return; }
        result.hits.push(e);
      }
      if (e.isDirectory) await walk(e.path);
    }
  }

  await walk(root);
  return result;
}
