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
