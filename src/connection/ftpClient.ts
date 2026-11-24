import * as ftp from 'basic-ftp';
import { Readable, Writable } from 'stream';
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { RemoteClient, RemoteEntry, ServerConfig, TransferOptions } from './types';
import { parseListDate } from './ftpDate';
import { bitsToSymbolic } from './mode';

export class FtpRemoteClient implements RemoteClient {
  private client = new ftp.Client(30000);

  constructor(private cfg: ServerConfig, private password: string) {}

  async connect(): Promise<void> {
    await this.client.access({
      host: this.cfg.host,
      port: this.cfg.port ?? 21,
      user: this.cfg.username,
      password: this.password,
      secure: this.cfg.protocol === 'ftps',
      secureOptions: { rejectUnauthorized: !this.cfg.allowSelfSigned },
    });
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const items = await this.client.list(path);
    const offset = (this.cfg.timeOffsetMinutes ?? 0) * 60000;
    return items
      .filter((i) => i.name !== '.' && i.name !== '..')
      .map((i) => ({
        name: i.name,
        path: path.replace(/\/$/, '') + '/' + i.name,
        isDirectory: i.isDirectory,
        size: i.size,
        mtime: (i.modifiedAt?.getTime() ?? parseListDate(i.rawModifiedAt) ?? 0) + offset,
        permissions: i.permissions
          ? bitsToSymbolic(i.permissions.user, i.permissions.group, i.permissions.world)
          : undefined,
      }));
  }

  async readFile(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await this.client.downloadTo(sink, path);
    return Buffer.concat(chunks);
  }

  async writeFile(path: string, data: Buffer, _mtimeMs?: number): Promise<void> {
    await this.client.uploadFrom(Readable.from(data), path);
  }

  async uploadFile(local: string, remote: string, opts?: TransferOptions): Promise<void> {
    const tmp = `${remote}.part-${process.pid}-${Date.now()}`;
    let keepTmp = false;
    this.client.trackProgress(opts?.onProgress ? (info) => opts.onProgress!(info.bytesOverall) : undefined);
    try {
      await this.client.uploadFrom(local, tmp);
      try {
        await this.client.rename(tmp, remote);
      } catch {
        await this.client.remove(remote).catch(() => undefined); // target exists and rename does not overwrite
        try { await this.client.rename(tmp, remote); } catch (e) {
          keepTmp = true; // the old file may already be gone: keep the new version
          throw new Error(`${(e as Error).message} (die neue Version liegt unter ${tmp})`);
        }
      }
    } catch (e) {
      if (!keepTmp) { try { await this.client.remove(tmp); } catch { /* nothing to clean up */ } }
      throw e;
    } finally {
      this.client.trackProgress();
    }
  }

  async downloadFile(remote: string, local: string, opts?: TransferOptions): Promise<void> {
    await fsp.mkdir(nodePath.dirname(local), { recursive: true });
    const tmp = `${local}.part`;
    this.client.trackProgress(opts?.onProgress ? (info) => opts.onProgress!(info.bytesOverall) : undefined);
    try {
      await this.client.downloadTo(tmp, remote);
      await fsp.rename(tmp, local);
    } catch (e) {
      try { await fsp.unlink(tmp); } catch { /* nothing to clean up */ }
      throw e;
    } finally {
      this.client.trackProgress();
    }
    if (opts?.mtimeMs) { try { await fsp.utimes(local, opts.mtimeMs / 1000, opts.mtimeMs / 1000); } catch { /* best effort */ } }
  }

  async chmod(path: string, mode: number): Promise<void> {
    // SITE CHMOD is widely supported (vsftpd, ProFTPD, Pure-FTPd) but not part of the FTP standard.
    await this.client.send(`SITE CHMOD ${mode.toString(8)} ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.client.ensureDir(path);
    await this.client.cd('/');
  }

  async rename(from: string, to: string): Promise<void> {
    await this.client.rename(from, to);
  }

  async remove(path: string, isDirectory: boolean): Promise<void> {
    if (isDirectory) await this.client.removeDir(path);
    else await this.client.remove(path);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
