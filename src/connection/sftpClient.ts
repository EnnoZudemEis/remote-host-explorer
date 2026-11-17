import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { RemoteClient, RemoteEntry, ServerConfig } from './types';

/** Expands a leading "~" (also "~\" on Windows) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return nodePath.join(os.homedir(), p.slice(2));
  return p;
}

export class SftpRemoteClient implements RemoteClient {
  private client = new SftpClient();

  constructor(private cfg: ServerConfig, private password: string) {}

  async connect(): Promise<void> {
    await this.client.connect({
      host: this.cfg.host,
      port: this.cfg.port ?? 22,
      username: this.cfg.username,
      password: this.cfg.privateKeyPath ? undefined : this.password,
      privateKey: this.cfg.privateKeyPath ? fs.readFileSync(expandHome(this.cfg.privateKeyPath)) : undefined,
      passphrase: this.cfg.privateKeyPath ? this.password || undefined : undefined,
      keepaliveInterval: 10000,
      readyTimeout: 30000,
    });
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const items = await this.client.list(path);
    return items.map((i) => ({
      name: i.name,
      path: path.replace(/\/$/, '') + '/' + i.name,
      isDirectory: i.type === 'd',
      size: i.size,
      mtime: i.modifyTime,
      permissions: i.rights ? `${i.rights.user}${i.rights.group}${i.rights.other}` : undefined,
    }));
  }

  async readFile(path: string): Promise<Buffer> {
    return (await this.client.get(path)) as Buffer;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.client.put(data, path);
  }

  async mkdir(path: string): Promise<void> {
    await this.client.mkdir(path, true);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.client.rename(from, to);
  }

  async remove(path: string, isDirectory: boolean): Promise<void> {
    if (isDirectory) await this.client.rmdir(path, true);
    else await this.client.delete(path);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
