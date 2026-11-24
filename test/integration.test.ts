/**
 * Integration tests against the Docker test servers.
 *   cd test-fixtures && docker compose up -d
 * Tests are skipped automatically when a server is not reachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createClient } from '../src/connection/factory';
import { RemoteClient, ServerConfig } from '../src/connection/types';
import { compareTrees, Side } from '../src/compare/compare';

const SAMPLE = path.resolve(__dirname, '../../test-fixtures/sample-project');

const servers: ServerConfig[] = [
  { name: 'sftp', protocol: 'sftp', host: '127.0.0.1', port: 2222, username: 'test', localPath: '.', remotePath: '/upload' },
  { name: 'ftp', protocol: 'ftp', host: '127.0.0.1', port: 2121, username: 'test', localPath: '.', remotePath: '/home/test' },
];

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

const join = (a: string, b: string) => a.replace(/\/$/, '') + '/' + b;

for (const cfg of servers) {
  test(`${cfg.name}: list, write, read, rename, delete`, async (t) => {
    if (!(await reachable(cfg.port!))) return t.skip('server not running');
    const c: RemoteClient = await createClient(cfg, 'test');
    const dir = join(cfg.remotePath, `__it_${Date.now()}`);
    try {
      await c.mkdir(dir);
      await c.writeFile(join(dir, 'a.txt'), Buffer.from('hello'));
      let list = await c.list(dir);
      assert.deepEqual(list.map((e) => [e.name, e.size, e.isDirectory]), [['a.txt', 5, false]]);
      assert.equal((await c.readFile(join(dir, 'a.txt'))).toString(), 'hello');

      await c.rename(join(dir, 'a.txt'), join(dir, 'b.txt'));
      list = await c.list(dir);
      assert.deepEqual(list.map((e) => e.name), ['b.txt']);
      assert.ok(list[0].mtime > 0, 'mtime is set');

      await c.remove(join(dir, 'b.txt'), false);
      assert.equal((await c.list(dir)).length, 0);
    } finally {
      try { await c.remove(dir, true); } catch { /* cleanup best effort */ }
      await c.close();
    }
  });

  test(`${cfg.name}: folder compare finds seeded differences`, async (t) => {
    if (!(await reachable(cfg.port!))) return t.skip('server not running');
    const c = await createClient(cfg, 'test');
    try {
      const local: Side = {
        async list(dir) {
          return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
            const st = fs.statSync(path.join(dir, d.name));
            return { name: d.name, isDirectory: d.isDirectory(), size: st.size, mtime: st.mtimeMs };
          });
        },
        async read(p) { return fs.readFileSync(p); },
      };
      const remote: Side = {
        async list(dir) {
          return (await c.list(dir)).map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size, mtime: e.mtime }));
        },
        read: (p) => c.readFile(p),
      };
      const res = await compareTrees(local, remote, SAMPLE, cfg.remotePath, {
        mtimeToleranceMs: cfg.protocol === 'sftp' ? 2000 : 120000,
      });
      assert.deepEqual(
        res.map((i) => [i.relPath, i.status]),
        [
          ['css/style.css', 'localOnly'],
          ['index.php', 'modified'],
          ['old/legacy.php', 'remoteOnly'],
          ['src/app.php', 'modified'],
          ['src/new-local.php', 'localOnly'],
        ],
      );
    } finally {
      await c.close();
    }
  });
}

test('server <-> server compare (sftp vs ftp) finds the live hotfix', async (t) => {
  if (!(await reachable(2222)) || !(await reachable(2121))) return t.skip('servers not running');
  const [a, b] = servers;
  const ca = await createClient(a, 'test');
  const cb = await createClient(b, 'test');
  try {
    const side = (c: RemoteClient): Side => ({
      async list(dir) {
        return (await c.list(dir)).map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size, mtime: e.mtime }));
      },
      read: (p) => c.readFile(p),
    });
    const res = await compareTrees(side(ca), side(cb), a.remotePath, b.remotePath, { mtimeToleranceMs: 120000 });
    assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['index.php', 'modified']]);
  } finally {
    await ca.close();
    await cb.close();
  }
});

test('sftp: upload keeps the given modification time (compare can skip the download)', async (t) => {
  const cfg = servers[0];
  if (!(await reachable(cfg.port!))) return t.skip('server not running');
  const c = await createClient(cfg, 'test');
  const dir = join(cfg.remotePath, `__mt_${Date.now()}`);
  try {
    await c.mkdir(dir);
    const mtime = Date.UTC(2024, 0, 15, 12, 0, 0);
    await c.writeFile(join(dir, 'a.txt'), Buffer.from('x'), mtime);
    const [e] = await c.list(dir);
    assert.ok(Math.abs(e.mtime - mtime) <= 1000, `remote mtime ${e.mtime} should equal ${mtime}`);
  } finally {
    try { await c.remove(dir, true); } catch { /* cleanup best effort */ }
    await c.close();
  }
});
