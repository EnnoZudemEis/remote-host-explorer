import * as path from 'path';

/** Pure path mapping, no VS Code dependency (unit-testable). */

export interface PathMapping {
  /** Local folder relative to the workspace root. */
  localPath: string;
  /** Remote root folder. */
  remotePath: string;
}

/**
 * Maps a local file to its remote path for the given server.
 * Returns undefined when the file lies outside the server's local folder.
 */
export function mapToRemote(server: PathMapping, workspaceRoot: string, localFile: string): string | undefined {
  const base = path.join(workspaceRoot, server.localPath);
  const rel = path.relative(base, localFile);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return path.posix.join(server.remotePath, rel.split(path.sep).join('/'));
}

/**
 * True if a name coming from a server is safe to use as a single path segment.
 * Rejects empty names, "." and "..", separators and NUL everywhere; on Windows also
 * backslash and colon (they would act as path separators or drive/stream markers).
 */
export function isSafeRemoteName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\0')) return false;
  if (platform === 'win32' && (name.includes('\\') || name.includes(':'))) return false;
  return true;
}

/**
 * Joins a posix-style relative path below a local base folder and guarantees the result stays
 * inside it. Throws if a segment is unsafe or the resolved path would escape the base.
 */
export function safeLocalPath(base: string, relPosix: string, platform: NodeJS.Platform = process.platform): string {
  const segments = relPosix.split('/').filter((s) => s !== '');
  for (const s of segments) {
    if (!isSafeRemoteName(s, platform)) throw new Error(`Unsicherer Dateiname vom Server: "${s}"`);
  }
  const pathMod = platform === 'win32' ? path.win32 : path;
  const resolvedBase = pathMod.resolve(base);
  const target = pathMod.resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + pathMod.sep)) {
    throw new Error(`Pfad liegt außerhalb des Zielordners: "${relPosix}"`);
  }
  return target;
}

/** "20250131-142530" style stamp, used as folder name for one backup run. */
export function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Where a backup copy of `relPath` is stored:
 * <workspace>/.vscode/remote-host-backup/<server>/<stamp>/<relPath>. Throws for unsafe paths.
 */
export function backupPath(workspaceRoot: string, serverName: string, stamp: string, relPath: string,
  platform: NodeJS.Platform = process.platform): string {
  const server = serverName.replace(/[^\w.-]+/g, '_') || 'server';
  const base = (platform === 'win32' ? path.win32 : path).join(workspaceRoot, '.vscode', 'remote-host-backup', server, stamp);
  return safeLocalPath(base, relPath, platform);
}
