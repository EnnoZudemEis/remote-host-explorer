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

import * as os from 'os';
import * as crypto from 'crypto';

for (const cfg of servers) {
  test(`${cfg.name}: streamed upload/download replaces files atomically and reports progress`, async (t) => {
    if (!(await reachable(cfg.port!))) return t.skip('server not running');
    const c = await createClient(cfg, 'test');
    const dir = join(cfg.remotePath, `__st_${Date.now()}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-it-'));
    try {
      await c.mkdir(dir);
      const big = crypto.randomBytes(3 * 1024 * 1024);
      const src = path.join(tmpDir, 'big.bin');
      fs.writeFileSync(src, big);
      const seen: number[] = [];
      const mtime = Date.UTC(2024, 0, 15, 12, 0, 0);
      await c.uploadFile(src, join(dir, 'big.bin'), { mtimeMs: mtime, onProgress: (b) => seen.push(b) });
      assert.ok(seen.length > 0 && seen[seen.length - 1] === big.length, `progress ends at file size, got ${seen.slice(-1)}`);
      assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'progress never goes backwards');
      assert.ok((await c.readFile(join(dir, 'big.bin'))).equals(big), 'content uploaded intact');

      // overwrite an existing remote file with different content
      fs.writeFileSync(src, 'second version');
      await c.uploadFile(src, join(dir, 'big.bin'));
      assert.equal((await c.readFile(join(dir, 'big.bin'))).toString(), 'second version');
      assert.deepEqual((await c.list(dir)).map((e) => e.name), ['big.bin'], 'no temporary .part file is left behind');

      // download keeps content and (if given) the modification time
      const dst = path.join(tmpDir, 'sub', 'down.txt');
      await c.downloadFile(join(dir, 'big.bin'), dst, { mtimeMs: mtime });
      assert.equal(fs.readFileSync(dst, 'utf8'), 'second version');
      assert.ok(Math.abs(fs.statSync(dst).mtimeMs - mtime) < 2000, 'local mtime set');
      assert.deepEqual(fs.readdirSync(path.dirname(dst)), ['down.txt'], 'no .part file locally');
    } finally {
      try { await c.remove(dir, true); } catch { /* cleanup best effort */ }
      await c.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

for (const cfg of servers) {
  test(`${cfg.name}: chmod changes the permissions`, async (t) => {
    if (!(await reachable(cfg.port!))) return t.skip('server not running');
    const c = await createClient(cfg, 'test');
    const dir = join(cfg.remotePath, `__ch_${Date.now()}`);
    try {
      await c.mkdir(dir);
      await c.writeFile(join(dir, 'f.txt'), Buffer.from('x'));
      await c.chmod(join(dir, 'f.txt'), 0o600);
      const [e] = await c.list(dir);
      assert.equal(e.permissions, 'rw-------');
      await c.chmod(join(dir, 'f.txt'), 0o755);
      assert.equal((await c.list(dir))[0].permissions, 'rwxr-xr-x');
    } finally {
      try { await c.remove(dir, true); } catch { /* cleanup best effort */ }
      await c.close();
    }
  });
}

import { buildMatcher, searchTree } from '../src/compare/search';

for (const cfg of servers) {
  test(`${cfg.name}: remote search finds a file in a sub folder`, async (t) => {
    if (!(await reachable(cfg.port!))) return t.skip('server not running');
    const c = await createClient(cfg, 'test');
    const dir = join(cfg.remotePath, `__se_${Date.now()}`);
    try {
      await c.mkdir(join(dir, 'a/b'));
      await c.writeFile(join(dir, 'a/b/Needle-File.txt'), Buffer.from('x'));
      await c.writeFile(join(dir, 'a/other.txt'), Buffer.from('y'));
      const r = await searchTree((d) => c.list(d), dir, buildMatcher('needle'));
      assert.deepEqual(r.hits.map((e) => e.path), [join(dir, 'a/b/Needle-File.txt')]);
      assert.equal(r.unreadable, 0);
      const g = await searchTree((d) => c.list(d), dir, buildMatcher('*.txt'));
      assert.equal(g.hits.length, 2);
    } finally {
      try { await c.remove(dir, true); } catch { /* cleanup best effort */ }
      await c.close();
    }
  });
}

import { Server as SshServer } from 'ssh2';
import { SftpRemoteClient } from '../src/connection/sftpClient';

/** In-process SSH server that accepts password "pw" for user "jump" and forwards TCP connections. */
async function startJumpHost() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const state = { forwards: 0 };
  const server = new SshServer({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.username === 'jump' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password']));
    client.on('tcpip', (accept, reject, info) => {
      state.forwards++;
      const sock = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(sock); sock.pipe(ch); });
      sock.on('error', () => reject());
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, state, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('sftp: connects through a jump host and verifies the host keys of both hops', async (t) => {
  if (!(await reachable(2222))) return t.skip('server not running');
  const jump = await startJumpHost();
  const asked: string[] = [];
  const cfg: ServerConfig = {
    ...servers[0],
    jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jump' },
  };
  const c = new SftpRemoteClient(cfg, 'test', async (id) => { asked.push(id); return true; }, 'pw');
  try {
    await c.connect();
    assert.ok((await c.list('/upload')).length > 0, 'listing through the tunnel works');
    assert.equal(jump.state.forwards, 1, 'the connection went through the jump host');
    assert.deepEqual(asked.sort(), [`127.0.0.1:2222`, `127.0.0.1:${jump.port}`].sort());
  } finally {
    await c.close();
    await jump.stop();
  }
});

test('sftp: jump host with a wrong password or a rejected host key fails with a clear message', async (t) => {
  if (!(await reachable(2222))) return t.skip('server not running');
  const jump = await startJumpHost();
  const cfg: ServerConfig = { ...servers[0], jumpHost: { host: '127.0.0.1', port: jump.port, username: 'jump' } };
  try {
    const wrongPw = new SftpRemoteClient(cfg, 'test', async () => true, 'nope');
    await assert.rejects(() => wrongPw.connect(), /Jump host 127\.0\.0\.1: .*authentication/i);
    const rejectedKey = new SftpRemoteClient(cfg, 'test', async () => false, 'pw');
    await assert.rejects(() => rejectedKey.connect(), /Jump host 127\.0\.0\.1/);
    assert.equal(jump.state.forwards, 0, 'nothing was forwarded');
  } finally {
    await jump.stop();
  }
});
