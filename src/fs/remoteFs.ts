import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteClient } from '../connection/types';

export const REMOTE_FS_SCHEME = 'remotefs';

export function remoteFsUri(serverName: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: REMOTE_FS_SCHEME, path: remotePath, query: serverName });
}

/**
 * Editable view of a remote server ("Edit Remote File"): opening a file downloads it,
 * saving uploads it. URI: remotefs:/<remote path>?<server name>
 */
export class RemoteFileSystem implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private clientFor: (serverName: string) => Promise<RemoteClient | undefined>) {}

  private async client(uri: vscode.Uri): Promise<RemoteClient> {
    const c = await this.clientFor(uri.query);
    if (!c) throw vscode.FileSystemError.Unavailable(uri);
    return c;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === '/' || uri.path === '') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const c = await this.client(uri);
    const entries = await c.list(path.posix.dirname(uri.path)).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
    const e = entries.find((x) => x.name === path.posix.basename(uri.path));
    if (!e) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: e.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: e.mtime,
      mtime: e.mtime,
      size: e.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const c = await this.client(uri);
    return (await c.list(uri.path)).map((e) => [
      e.name,
      e.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const c = await this.client(uri);
    return c.readFile(uri.path).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const c = await this.client(uri);
    await c.writeFile(uri.path, Buffer.from(content));
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await (await this.client(uri)).mkdir(uri.path);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const st = await this.stat(uri);
    await (await this.client(uri)).remove(uri.path, st.type === vscode.FileType.Directory);
  }

  async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    await (await this.client(from)).rename(from.path, to.path);
  }
}
