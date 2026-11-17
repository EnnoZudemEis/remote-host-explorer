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
