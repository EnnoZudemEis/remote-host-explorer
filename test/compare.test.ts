import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTrees, Side, SideEntry } from '../src/compare/compare';

/** In-memory file tree: path -> content (string) or null for directory. */
function fakeSide(files: Record<string, { data?: string; mtime?: number }>): Side {
  const nodes = new Map<string, { data?: string; mtime: number }>();
  for (const [p, v] of Object.entries(files)) nodes.set(p, { data: v.data, mtime: v.mtime ?? 0 });
  return {
    async list(dir) {
      const prefix = dir.replace(/\/$/, '') + '/';
      const out = new Map<string, SideEntry>();
      for (const [p, v] of nodes) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const name = rest.split('/')[0];
        const isDir = rest.includes('/');
        if (!out.has(name) || isDir) {
          out.set(name, { name, isDirectory: isDir, size: v.data?.length ?? 0, mtime: v.mtime });
        }
      }
      return [...out.values()];
    },
    async read(p) {
      return Buffer.from(nodes.get(p)?.data ?? '');
    },
  };
}

test('detects modified, localOnly and remoteOnly files', async () => {
  const local = fakeSide({
    '/l/a.txt': { data: 'same' },
    '/l/b.txt': { data: 'local-version' },
    '/l/only-local.txt': { data: 'x' },
    '/l/sub/c.txt': { data: 'c' },
  });
  const remote = fakeSide({
    '/r/a.txt': { data: 'same' },
    '/r/b.txt': { data: 'remote' },
    '/r/only-remote.txt': { data: 'y' },
    '/r/sub/c.txt': { data: 'c' },
    '/r/sub/d.txt': { data: 'd' },
  });
  const res = await compareTrees(local, remote, '/l', '/r');
  assert.deepEqual(
    res.map((i) => [i.relPath, i.status]),
    [
      ['b.txt', 'modified'],
      ['only-local.txt', 'localOnly'],
      ['only-remote.txt', 'remoteOnly'],
      ['sub/d.txt', 'remoteOnly'],
    ],
  );
});

test('same size, different mtime but same content is not a difference', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'abc', mtime: 1000 } });
  const remote = fakeSide({ '/r/a.txt': { data: 'abc', mtime: 999999 } });
  assert.equal((await compareTrees(local, remote, '/l', '/r')).length, 0);
});

test('same size, different mtime and different content is modified', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'abc', mtime: 1000 } });
  const remote = fakeSide({ '/r/a.txt': { data: 'abd', mtime: 999999 } });
  const res = await compareTrees(local, remote, '/l', '/r');
  assert.equal(res[0].status, 'modified');
});

test('exclude hides directories and files', async () => {
  const local = fakeSide({ '/l/node_modules/x.js': { data: '1' }, '/l/a.txt': { data: 'a' } });
  const remote = fakeSide({ '/r/a.txt': { data: 'a' } });
  const res = await compareTrees(local, remote, '/l', '/r', { exclude: ['node_modules'] });
  assert.equal(res.length, 0);
});

test('missing remote folder lists all local files as localOnly', async () => {
  const local = fakeSide({ '/l/dir/a.txt': { data: 'a' }, '/l/dir/b/c.txt': { data: 'c' } });
  const remote = fakeSide({});
  const res = await compareTrees(local, remote, '/l', '/r');
  assert.deepEqual(res.map((i) => i.relPath), ['dir/a.txt', 'dir/b/c.txt']);
});

test('file vs folder is reported once as conflict', async () => {
  const local = fakeSide({ '/l/x': { data: 'file' } });
  const remote = fakeSide({ '/r/x/inner.txt': { data: 'i' } });
  const res = await compareTrees(local, remote, '/l', '/r');
  assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['x', 'conflict']]);
  assert.equal(res[0].local?.isDirectory, false);
  assert.equal(res[0].remote?.isDirectory, true);
});

test('includeUnchanged reports identical files', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'same' }, '/l/b.txt': { data: 'short' } });
  const remote = fakeSide({ '/r/a.txt': { data: 'same' }, '/r/b.txt': { data: 'a longer one' } });
  const res = await compareTrees(local, remote, '/l', '/r', { includeUnchanged: true });
  assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['a.txt', 'unchanged'], ['b.txt', 'modified']]);
});

import { selectBySource } from '../src/compare/transfer';
import { mapToRemote } from '../src/connection/paths';
import * as nodePath from 'node:path';

const di = (relPath: string, status: import('../src/compare/compare').DiffStatus) => ({ relPath, status });

test('selectBySource: upload takes modified + localOnly, skips the rest', () => {
  const items = [di('a', 'modified'), di('b', 'localOnly'), di('c', 'remoteOnly'), di('d', 'conflict'), di('e', 'unchanged')];
  const r = selectBySource(items, 'local');
  assert.deepEqual(r.transfer.map((i) => i.relPath), ['a', 'b']);
  assert.deepEqual(r.skipped.map((i) => i.relPath), ['c', 'd', 'e']);
  assert.equal(r.overwrite, 1);
});

test('selectBySource: download takes modified + remoteOnly and ignores duplicates', () => {
  const items = [di('a', 'modified'), di('a', 'modified'), di('b', 'localOnly'), di('c', 'remoteOnly')];
  const r = selectBySource(items, 'remote');
  assert.deepEqual(r.transfer.map((i) => i.relPath), ['a', 'c']);
  assert.deepEqual(r.skipped.map((i) => i.relPath), ['b']);
});

test('mapToRemote maps per server and rejects files outside the local folder', () => {
  const ws = nodePath.join('/ws');
  const test_ = { localPath: 'site', remotePath: '/var/www/test' };
  const live = { localPath: 'site/dist', remotePath: '/var/www/live' };
  const file = nodePath.join(ws, 'site', 'dist', 'a', 'b.js');
  assert.equal(mapToRemote(test_, ws, file), '/var/www/test/dist/a/b.js');
  assert.equal(mapToRemote(live, ws, file), '/var/www/live/a/b.js');
  assert.equal(mapToRemote(live, ws, nodePath.join(ws, 'site', 'other.js')), undefined);
  assert.equal(mapToRemote(live, ws, nodePath.join(ws, 'site', 'dist-old', 'x.js')), undefined);
});

import { checkHostKey, formatFingerprint, hostId } from '../src/connection/hostKey';
import { isNotFoundError } from '../src/connection/errors';
import { isSafeRemoteName, safeLocalPath } from '../src/connection/paths';
import { isTargetNewer } from '../src/compare/transfer';

test('host key: new, trusted and changed keys', () => {
  const known = { [hostId('Example.com', 22)]: 'SHA256:abc' };
  assert.equal(checkHostKey(known, 'example.com:22', 'SHA256:abc'), 'trusted');
  assert.equal(checkHostKey(known, 'example.com:22', 'SHA256:other'), 'changed');
  assert.equal(checkHostKey(known, 'example.com:2222', 'SHA256:abc'), 'new');
});

test('formatFingerprint produces OpenSSH style SHA256 without padding', () => {
  // sha256 of the empty string
  const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(formatFingerprint(hex), 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
});

test('isNotFoundError recognises SFTP, FTP and message variants but not auth/network errors', () => {
  assert.equal(isNotFoundError({ code: 2 }), true);
  assert.equal(isNotFoundError({ code: 550 }), true);
  assert.equal(isNotFoundError(new Error('No such file')), true);
  assert.equal(isNotFoundError(new Error('Authentication failed')), false);
  assert.equal(isNotFoundError(new Error('connect ECONNREFUSED')), false);
});

test('isSafeRemoteName rejects traversal and platform specific separators', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\0b']) assert.equal(isSafeRemoteName(bad, 'linux'), false, bad);
  assert.equal(isSafeRemoteName('a\\b', 'linux'), true);
  assert.equal(isSafeRemoteName('a\\b', 'win32'), false);
  assert.equal(isSafeRemoteName('c:evil', 'win32'), false);
  assert.equal(isSafeRemoteName('ok-name.txt', 'win32'), true);
});

test('safeLocalPath stays inside the base and rejects unsafe segments', () => {
  assert.equal(safeLocalPath('/base', 'a/b.txt', 'linux'), '/base/a/b.txt');
  assert.equal(safeLocalPath('/base', '', 'linux'), '/base');
  assert.throws(() => safeLocalPath('/base', '../etc/passwd', 'linux'));
  assert.throws(() => safeLocalPath('/base', 'a/../../x', 'linux'));
  assert.throws(() => safeLocalPath('C:\\proj', 'dir\\evil', 'win32'));
});

test('unreadable folder is reported instead of making the other side look "only here"', async () => {
  const local = fakeSide({ '/l/sub/a.txt': { data: 'a' }, '/l/ok.txt': { data: 'x' } });
  const remoteInner = fakeSide({ '/r/sub/a.txt': { data: 'a' }, '/r/ok.txt': { data: 'x' } });
  const remote: Side = {
    list: (dir) => (dir === '/r/sub' ? Promise.reject(new Error('Permission denied')) : remoteInner.list(dir)),
    read: (p) => remoteInner.read(p),
  };
  const res = await compareTrees(local, remote, '/l', '/r');
  assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['sub', 'unreadable']]);
});

test('isTargetNewer only flags modified files whose target is clearly newer', () => {
  const e = (mtime: number) => ({ name: 'f', isDirectory: false, size: 1, mtime });
  const item = (l: number, r: number, status: 'modified' | 'localOnly' = 'modified') =>
    ({ relPath: 'f', status, local: e(l), remote: e(r) });
  assert.equal(isTargetNewer(item(1000, 100000), 'local'), true);
  assert.equal(isTargetNewer(item(100000, 1000), 'local'), false);
  assert.equal(isTargetNewer(item(100000, 1000), 'remote'), true);
  assert.equal(isTargetNewer(item(1000, 2000), 'local'), false); // within tolerance
  assert.equal(isTargetNewer(item(1000, 100000, 'localOnly'), 'local'), false);
});
