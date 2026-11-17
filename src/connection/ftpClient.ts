import * as ftp from 'basic-ftp';
import { Readable, Writable } from 'stream';
import { RemoteClient, RemoteEntry, ServerConfig } from './types';
import { parseListDate } from './ftpDate';

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
          ? `${i.permissions.user}${i.permissions.group}${i.permissions.world}`
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

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.client.uploadFrom(Readable.from(data), path);
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
