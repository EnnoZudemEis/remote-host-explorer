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

import { parseGitignore } from '../src/compare/gitignore';
import { makeExcluder } from '../src/compare/glob';

test('parseGitignore keeps patterns, skips comments/blank lines, counts unsupported negations', () => {
  const r = parseGitignore('# build\nnode_modules/\n\n*.log\r\n/dist\n!keep.log\n\\#file\n');
  assert.deepEqual(r.patterns, ['node_modules/', '*.log', '/dist', '#file']);
  assert.equal(r.unsupported, 1);
  const ex = makeExcluder(r.patterns);
  assert.equal(ex('a/node_modules', 'node_modules'), true);
  assert.equal(ex('x/app.log', 'app.log'), true);
  assert.equal(ex('dist', 'dist'), true);
  assert.equal(ex('sub/dist', 'dist'), false); // anchored to the root
  assert.equal(ex('src/index.ts', 'index.ts'), false);
});

import { backupPath, formatStamp } from '../src/connection/paths';
import { selectForDelete } from '../src/compare/transfer';

test('formatStamp pads all parts', () => {
  assert.equal(formatStamp(new Date(2025, 0, 5, 3, 4, 9)), '20250105-030409');
});

test('backupPath puts files under .vscode/remote-host-backup/<server>/<stamp> and stays inside', () => {
  assert.equal(
    backupPath('/ws', 'Live Server!', '20250105-030409', 'a/b.txt', 'linux'),
    '/ws/.vscode/remote-host-backup/Live_Server_/20250105-030409/a/b.txt',
  );
  assert.throws(() => backupPath('/ws', 'Live', '20250105-030409', '../../etc/passwd', 'linux'));
});

test('selectForDelete only removes files that exist on the chosen side alone', () => {
  const items = [di('a', 'remoteOnly'), di('a', 'remoteOnly'), di('b', 'localOnly'), di('c', 'modified'), di('d', 'unreadable')];
  const r = selectForDelete(items, 'remote');
  assert.deepEqual(r.remove.map((i) => i.relPath), ['a']);
  assert.deepEqual(r.kept.map((i) => i.relPath), ['b', 'c', 'd']);
  assert.deepEqual(selectForDelete(items, 'local').remove.map((i) => i.relPath), ['b']);
});

import { normalizeEol } from '../src/compare/compare';
import { parseMode, symbolicToOctal } from '../src/connection/mode';

test('line endings: CRLF vs LF is modified by default, equal with ignoreLineEndings', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'one\r\ntwo\r\n' } });
  const remote = fakeSide({ '/r/a.txt': { data: 'one\ntwo\n' } });
  assert.deepEqual((await compareTrees(local, remote, '/l', '/r')).map((i) => i.status), ['modified']);
  assert.equal((await compareTrees(local, remote, '/l', '/r', { ignoreLineEndings: true })).length, 0);
});

test('line endings: real content differences and binary files are still modified', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'one\r\ntwo\r\n' }, '/l/b.bin': { data: 'x\0\r\ny' } });
  const remote = fakeSide({ '/r/a.txt': { data: 'one\nTWO\n' }, '/r/b.bin': { data: 'x\0\ny' } });
  const res = await compareTrees(local, remote, '/l', '/r', { ignoreLineEndings: true });
  assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['a.txt', 'modified'], ['b.bin', 'modified']]);
});

test('normalizeEol only removes CR before LF', () => {
  assert.equal(normalizeEol(Buffer.from('a\r\nb\rc\n')).toString(), 'a\nb\rc\n');
});

test('parseMode accepts 3 or 4 octal digits only', () => {
  assert.equal(parseMode('755'), 0o755);
  assert.equal(parseMode(' 0644 '), 0o644);
  for (const bad of ['', '75', '789', 'rwx', '77777']) assert.equal(parseMode(bad), undefined, bad);
});

test('symbolicToOctal converts the tree format', () => {
  assert.equal(symbolicToOctal('rwxr-xr-x'), '755');
  assert.equal(symbolicToOctal('rw-r--r--'), '644');
  assert.equal(symbolicToOctal('weird'), undefined);
  assert.equal(symbolicToOctal(undefined), undefined);
});

import { bitsToSymbolic } from '../src/connection/mode';
import { rightsToSymbolic } from '../src/connection/sftpClient';

test('permissions are shown as rwx strings for SFTP and FTP', () => {
  assert.equal(bitsToSymbolic(6, 4, 4), 'rw-r--r--');
  assert.equal(bitsToSymbolic(7, 5, 5), 'rwxr-xr-x');
  assert.equal(rightsToSymbolic({ user: 'rw', group: '', other: '' }), 'rw-------');
  assert.equal(rightsToSymbolic({ user: 'rwx', group: 'rx', other: 'rx' }), 'rwxr-xr-x');
  assert.equal(rightsToSymbolic(undefined), undefined);
});

import { buildMatcher, searchTree } from '../src/compare/search';
import { RemoteEntry } from '../src/connection/types';

/** Fake remote tree: directory path -> entries. */
function fakeTree(tree: Record<string, [string, boolean][]>, failing: string[] = []) {
  const calls: string[] = [];
  const list = async (dir: string): Promise<RemoteEntry[]> => {
    calls.push(dir);
    if (failing.includes(dir)) throw new Error('Permission denied');
    return (tree[dir] ?? []).map(([name, isDirectory]) => ({
      name, path: `${dir === '/' ? '' : dir}/${name}`, isDirectory, size: 1, mtime: 0,
    }));
  };
  return { list, calls };
}

test('buildMatcher: substring is case-insensitive, glob must match the whole name', () => {
  const sub = buildMatcher('readme');
  assert.equal(sub('README.md'), true);
  assert.equal(sub('notes.txt'), false);
  const glob = buildMatcher('*.PHP');
  assert.equal(glob('index.php'), true);
  assert.equal(glob('index.php.bak'), false);
  assert.equal(buildMatcher('index.??')('index.js'), true);
  assert.equal(buildMatcher('index.??')('index.json'), false);
});

test('searchTree finds files and folders in subfolders', async () => {
  const { list } = fakeTree({
    '/': [['app', true], ['index.php', false]],
    '/app': [['config.php', false], ['lib', true]],
    '/app/lib': [['helper.php', false], ['readme.md', false]],
  });
  const r = await searchTree(list, '/', buildMatcher('*.php'));
  assert.deepEqual(r.hits.map((e) => e.path), ['/app/config.php', '/app/lib/helper.php', '/index.php']);
  assert.equal(r.truncated, false);
  assert.equal(r.folders, 3);
});

test('searchTree respects excludes, the hit limit, cancellation and unreadable folders', async () => {
  const { list, calls } = fakeTree({
    '/': [['node_modules', true], ['src', true], ['locked', true]],
    '/node_modules': [['a.js', false]],
    '/src': [['a.js', false], ['b.js', false], ['c.js', false]],
  }, ['/locked']);
  const ex = await searchTree(list, '/', buildMatcher('.js'), { exclude: ['node_modules'] });
  assert.deepEqual(ex.hits.map((e) => e.path), ['/src/a.js', '/src/b.js', '/src/c.js']);
  assert.ok(!calls.includes('/node_modules'), 'excluded folder is not entered');
  assert.equal(ex.unreadable, 1);

  const lim = await searchTree(list, '/', buildMatcher('.js'), { limit: 2, exclude: ['node_modules'] });
  assert.equal(lim.hits.length, 2);
  assert.equal(lim.truncated, true);

  let n = 0;
  const canc = await searchTree(list, '/', buildMatcher('.js'), { isCancelled: () => ++n > 2 });
  assert.equal(canc.cancelled, true);
});

test('anchored excludes are matched from excludeBase when a sub folder is compared', async () => {
  const local = fakeSide({
    '/l/sub/uploads/x.txt': { data: 'a' },
    '/l/sub/app/tmp/y.txt': { data: 'a' },
    '/l/sub/b.txt': { data: 'local' },
  });
  const remote = fakeSide({
    '/r/sub/uploads/x.txt': { data: 'bb' },
    '/r/sub/app/tmp/y.txt': { data: 'b' },
    '/r/sub/b.txt': { data: 'remote' },
  });
  // Compare only "sub"; "/uploads" (root anchored) must not hide "sub/uploads", "sub/app/tmp" must be matched.
  const res = await compareTrees(local, remote, '/l/sub', '/r/sub', {
    exclude: ['/uploads', 'sub/app/tmp'],
    excludeBase: 'sub',
  });
  assert.deepEqual(res.map((i) => i.relPath), ['b.txt', 'uploads/x.txt']);
});

test('same size, different content and mtime gap inside a large tolerance is still reported', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'abc', mtime: 1_000_000 } });
  const remote = fakeSide({ '/r/a.txt': { data: 'abd', mtime: 1_000_000 - 60_000 } });
  const res = await compareTrees(local, remote, '/l', '/r', { mtimeToleranceMs: 120000 });
  assert.deepEqual(res.map((i) => [i.relPath, i.status]), [['a.txt', 'modified']]);
});

test('same size and mtime within 2 s is trusted without reading', async () => {
  const local = fakeSide({ '/l/a.txt': { data: 'abc', mtime: 1_000_000 } });
  const remote = fakeSide({ '/r/a.txt': { data: 'abd', mtime: 1_000_500 } });
  assert.equal((await compareTrees(local, remote, '/l', '/r', { mtimeToleranceMs: 120000 })).length, 0);
});
