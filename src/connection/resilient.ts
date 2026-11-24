import { RemoteClient, RemoteEntry, TransferOptions } from './types';

const CONNECTION_ERROR = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|FIN packet|not connected|closed|No response|timeout|Channel open failure|No SFTP connection/i;

/**
 * Wraps a RemoteClient so that
 *  - only one operation runs at a time (basic-ftp forbids parallel commands,
 *    and tree view, diff provider and uploads all share one connection), and
 *  - a dropped connection is re-established (after a short pause) and the operation retried once,
 *    but only for operations that are safe to repeat. rename and remove are NOT repeated: the
 *    first attempt may already have reached the server, a second one would fail or hit the wrong
 *    thing. The connection is still rebuilt, so the next operation works.
 */
export class ResilientClient implements RemoteClient {
  private inner: RemoteClient;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private build: () => RemoteClient, private backoffMs = 500) {
    this.inner = build();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private op<T>(fn: (c: RemoteClient) => Promise<T>, repeatable = true): Promise<T> {
    return this.enqueue(async () => {
      try {
        return await fn(this.inner);
      } catch (err) {
        if (!CONNECTION_ERROR.test((err as Error).message ?? '')) throw err;
        try { await this.inner.close(); } catch { /* already dead */ }
        if (this.backoffMs) await new Promise((r) => setTimeout(r, this.backoffMs));
        this.inner = this.build();
        await this.inner.connect();
        if (!repeatable) {
          throw new Error(`Connection interrupted, the action was not repeated (outcome unclear): ${(err as Error).message}`);
        }
        return fn(this.inner);
      }
    });
  }

  connect(): Promise<void> {
    return this.enqueue(() => this.inner.connect());
  }
  list(path: string): Promise<RemoteEntry[]> {
    return this.op((c) => c.list(path));
  }
  readFile(path: string): Promise<Buffer> {
    return this.op((c) => c.readFile(path));
  }
  writeFile(path: string, data: Buffer, mtimeMs?: number): Promise<void> {
    return this.op((c) => c.writeFile(path, data, mtimeMs));
  }
  uploadFile(local: string, remote: string, opts?: TransferOptions): Promise<void> {
    return this.op((c) => c.uploadFile(local, remote, opts));
  }
  downloadFile(remote: string, local: string, opts?: TransferOptions): Promise<void> {
    return this.op((c) => c.downloadFile(remote, local, opts));
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.op((c) => c.chmod(path, mode));
  }
  mkdir(path: string): Promise<void> {
    return this.op((c) => c.mkdir(path));
  }
  rename(from: string, to: string): Promise<void> {
    return this.op((c) => c.rename(from, to), false);
  }
  remove(path: string, isDirectory: boolean): Promise<void> {
    return this.op((c) => c.remove(path, isDirectory), false);
  }
  close(): Promise<void> {
    return this.enqueue(() => this.inner.close());
  }
}
