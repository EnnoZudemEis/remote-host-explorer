import SftpClient from 'ssh2-sftp-client';
import { Client as SshClient } from 'ssh2';
import type { Duplex } from 'stream';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import { RemoteClient, RemoteEntry, ServerConfig, TransferOptions } from './types';
import { formatFingerprint, hostId, HostKeyVerifier } from './hostKey';
import { isSafeRemoteName } from './paths';

/** Expands a leading "~" (also "~\" on Windows) to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return nodePath.join(os.homedir(), p.slice(2));
  return p;
}

/** ssh2-sftp-client delivers {user: 'rw', group: '', other: ''}; this builds the usual "rw-------". */
export function rightsToSymbolic(r: { user?: string; group?: string; other?: string } | undefined): string | undefined {
  if (!r) return undefined;
  const part = (p = '') => `${p.includes('r') ? 'r' : '-'}${p.includes('w') ? 'w' : '-'}${p.includes('x') ? 'x' : '-'}`;
  return `${part(r.user)}${part(r.group)}${part(r.other)}`;
}

const agentSocket = (): string | undefined =>
  process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);

/** Password / key / agent options shared by the target server and the jump host. */
function authOptions(src: { privateKeyPath?: string; useAgent?: boolean }, secret: string) {
  return {
    password: src.privateKeyPath ? undefined : secret || undefined,
    agent: src.useAgent ? agentSocket() : undefined,
    privateKey: src.privateKeyPath ? fs.readFileSync(expandHome(src.privateKeyPath)) : undefined,
    passphrase: src.privateKeyPath ? secret || undefined : undefined,
  };
}

/** Host key check (protects against man-in-the-middle). Without a verifier every key is accepted. */
function hostKeyOptions(id: string, verifyHostKey?: HostKeyVerifier) {
  return {
    hostHash: 'sha256' as const,
    hostVerifier: verifyHostKey
      ? ((hex: string, verify: (ok: boolean) => void) => {
          verifyHostKey(id, formatFingerprint(hex)).then(verify, () => verify(false));
        }) as never // ssh2's typings only know the Buffer overload; with hostHash set it delivers a hex string
      : undefined,
  };
}

export class SftpRemoteClient implements RemoteClient {
  private client = new SftpClient();
  private jump?: SshClient;

  constructor(
    private cfg: ServerConfig,
    private password: string,
    private verifyHostKey?: HostKeyVerifier,
    /** Password of the jump host (cfg.jumpHost), if it uses one. */
    private jumpPassword = '',
  ) {}

  /** Connects to the jump host and opens a tunnel to the target; returns the tunnel stream. */
  private async openJump(): Promise<Duplex> {
    const j = this.cfg.jumpHost!;
    const port = j.port ?? 22;
    const jump = new SshClient();
    this.jump = jump;
    await new Promise<void>((resolve, reject) => {
      jump.once('ready', () => resolve());
      jump.once('error', (e: Error) => reject(new Error(`Jump host ${j.host}: ${e.message}`)));
      jump.connect({
        host: j.host, port, username: j.username,
        ...authOptions(j, this.jumpPassword),
        ...hostKeyOptions(hostId(j.host, port), this.verifyHostKey),
        keepaliveInterval: 10000,
        readyTimeout: 30000,
      });
    });
    return new Promise<Duplex>((resolve, reject) => {
      jump.forwardOut('127.0.0.1', 0, this.cfg.host, this.cfg.port ?? 22, (err, stream) =>
        err ? reject(new Error(`Jump host ${j.host}: cannot reach ${this.cfg.host}: ${err.message}`)) : resolve(stream));
    });
  }

  private closeJump(): void {
    try { this.jump?.end(); } catch { /* already closed */ }
    this.jump = undefined;
  }

  async connect(): Promise<void> {
    try {
      const sock = this.cfg.jumpHost ? await this.openJump() : undefined;
      await this.client.connect({
        host: this.cfg.host,
        port: this.cfg.port ?? 22,
        username: this.cfg.username,
        ...authOptions(this.cfg, this.password),
        ...hostKeyOptions(hostId(this.cfg.host, this.cfg.port ?? 22), this.verifyHostKey),
        sock,
        keepaliveInterval: 10000,
        readyTimeout: 30000,
      });
    } catch (e) {
      this.closeJump(); // do not leak the tunnel when the target connection fails
      throw e;
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const items = await this.client.list(path);
    return items.filter((i) => isSafeRemoteName(i.name, 'linux')).map((i) => ({
      name: i.name,
      path: path.replace(/\/$/, '') + '/' + i.name,
      isDirectory: i.type === 'd',
      size: i.size,
      mtime: i.modifyTime,
      permissions: rightsToSymbolic(i.rights),
    }));
  }

  async readFile(path: string): Promise<Buffer> {
    return (await this.client.get(path)) as Buffer;
  }

  async writeFile(path: string, data: Buffer, mtimeMs?: number): Promise<void> {
    await this.client.put(data, path);
    if (mtimeMs !== undefined) await this.setTimes(path, mtimeMs);
  }

  /** Keeping the local mtime makes later comparisons skip the content download. Best effort. */
  private async setTimes(path: string, mtimeMs: number): Promise<void> {
    const sftp = (this.client as unknown as {
      sftp?: { utimes(p: string, atime: number, mtime: number, cb: (err?: Error | null) => void): void };
    }).sftp;
    if (!sftp) return;
    const secs = Math.floor(mtimeMs / 1000);
    await new Promise<void>((resolve) => sftp.utimes(path, secs, secs, () => resolve()));
  }

  async uploadFile(local: string, remote: string, opts?: TransferOptions): Promise<void> {
    const tmp = `${remote}.part-${process.pid}-${Date.now()}`;
    let keepTmp = false;
    try {
      await this.client.fastPut(local, tmp, { step: opts?.onProgress ? (done: number) => opts.onProgress!(done) : undefined });
      // posixRename replaces an existing target atomically (OpenSSH). Without it, a plain rename
      // works if the target does not exist yet; otherwise the old file is deleted first.
      try {
        await this.client.posixRename(tmp, remote);
      } catch {
        try {
          await this.client.rename(tmp, remote);
        } catch {
          await this.client.delete(remote);
          try { await this.client.rename(tmp, remote); } catch (e) {
            keepTmp = true; // the old file is already gone: do not throw the new one away
            throw new Error(`${(e as Error).message} (the new version is stored as ${tmp})`);
          }
        }
      }
    } catch (e) {
      if (!keepTmp) { try { await this.client.delete(tmp); } catch { /* nothing to clean up */ } }
      throw e;
    }
    if (opts?.mtimeMs !== undefined) await this.setTimes(remote, opts.mtimeMs);
  }

  async downloadFile(remote: string, local: string, opts?: TransferOptions): Promise<void> {
    await fsp.mkdir(nodePath.dirname(local), { recursive: true });
    const tmp = `${local}.part`;
    try {
      await this.client.fastGet(remote, tmp, { step: opts?.onProgress ? (done: number) => opts.onProgress!(done) : undefined });
      await fsp.rename(tmp, local);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch { /* nothing to clean up */ }
      throw e;
    }
    if (opts?.mtimeMs) { try { await fsp.utimes(local, opts.mtimeMs / 1000, opts.mtimeMs / 1000); } catch { /* best effort */ } }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.client.chmod(path, mode);
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
    try { await this.client.end(); } finally { this.closeJump(); }
  }
}
