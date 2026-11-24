import { RemoteClient, RemoteEntry } from './types';

const CONNECTION_ERROR = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|FIN packet|not connected|closed|No response|timeout|Channel open failure|No SFTP connection/i;

/**
 * Wraps a RemoteClient so that
 *  - only one operation runs at a time (basic-ftp forbids parallel commands,
 *    and tree view, diff provider and uploads all share one connection), and
 *  - a dropped connection is re-established once and the operation retried.
 */
export class ResilientClient implements RemoteClient {
  private inner: RemoteClient;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private build: () => RemoteClient) {
    this.inner = build();
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private op<T>(fn: (c: RemoteClient) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      try {
        return await fn(this.inner);
      } catch (err) {
        if (!CONNECTION_ERROR.test((err as Error).message ?? '')) throw err;
        try { await this.inner.close(); } catch { /* already dead */ }
        this.inner = this.build();
        await this.inner.connect();
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
  mkdir(path: string): Promise<void> {
    return this.op((c) => c.mkdir(path));
  }
  rename(from: string, to: string): Promise<void> {
    return this.op((c) => c.rename(from, to));
  }
  remove(path: string, isDirectory: boolean): Promise<void> {
    return this.op((c) => c.remove(path, isDirectory));
  }
  close(): Promise<void> {
    return this.enqueue(() => this.inner.close());
  }
}
