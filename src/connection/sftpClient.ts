import SftpClient from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { RemoteClient, RemoteEntry, ServerConfig } from './types';
import { formatFingerprint, hostId, HostKeyVerifier } from './hostKey';
import { isSafeRemoteName } from './paths';

/** Expands a leading "~" (also "~\" on Windows) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return nodePath.join(os.homedir(), p.slice(2));
  return p;
}

export class SftpRemoteClient implements RemoteClient {
  private client = new SftpClient();

  constructor(
    private cfg: ServerConfig,
    private password: string,
    private verifyHostKey?: HostKeyVerifier,
  ) {}

  async connect(): Promise<void> {
    await this.client.connect({
      host: this.cfg.host,
      port: this.cfg.port ?? 22,
      username: this.cfg.username,
      password: this.cfg.privateKeyPath ? undefined : this.password || undefined,
      agent: this.cfg.useAgent
        ? process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
        : undefined,
      privateKey: this.cfg.privateKeyPath ? fs.readFileSync(expandHome(this.cfg.privateKeyPath)) : undefined,
      passphrase: this.cfg.privateKeyPath ? this.password || undefined : undefined,
      // Host key check (protects against man-in-the-middle). Without a verifier every key is accepted.
      hostHash: 'sha256',
      hostVerifier: this.verifyHostKey
        ? ((hex: string, verify: (ok: boolean) => void) => {
            this.verifyHostKey!(hostId(this.cfg.host, this.cfg.port ?? 22), formatFingerprint(hex)).then(
              verify, () => verify(false));
          }) as never // ssh2's typings only know the Buffer overload; with hostHash set it delivers a hex string
        : undefined,
      keepaliveInterval: 10000,
      readyTimeout: 30000,
    });
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const items = await this.client.list(path);
    return items.filter((i) => isSafeRemoteName(i.name, 'linux')).map((i) => ({
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

  async writeFile(path: string, data: Buffer, mtimeMs?: number): Promise<void> {
    await this.client.put(data, path);
    if (mtimeMs === undefined) return;
    // Keeping the local mtime makes later comparisons skip the content download for this file.
    // Best effort: some servers do not allow setting times.
    const sftp = (this.client as unknown as {
      sftp?: { utimes(p: string, atime: number, mtime: number, cb: (err?: Error | null) => void): void };
    }).sftp;
    if (!sftp) return;
    const secs = Math.floor(mtimeMs / 1000);
    await new Promise<void>((resolve) => sftp.utimes(path, secs, secs, () => resolve()));
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
