import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeExcluder } from '../src/compare/glob';
import { compareTrees, Side } from '../src/compare/compare';

test('name patterns match at any depth', () => {
  const ex = makeExcluder(['.git', '*.log', 'node_modules']);
  assert.ok(ex('a/b/.git', '.git'));
  assert.ok(ex('error.log', 'error.log'));
  assert.ok(ex('x/node_modules', 'node_modules'));
  assert.ok(!ex('src/app.php', 'app.php'));
});

test('path patterns match relative to the root', () => {
  const ex = makeExcluder(['cache/**', '/uploads', 'app/tmp']);
  assert.ok(ex('cache/a/b.txt', 'b.txt'));
  assert.ok(ex('uploads', 'uploads'));
  assert.ok(ex('app/tmp', 'tmp'));
  assert.ok(!ex('other/uploads', 'uploads'));
  assert.ok(!ex('app/tmp2', 'tmp2'));
});

test('compareTrees applies glob excludes', async () => {
  const mk = (files: Record<string, string>): Side => ({
    async list(dir) {
      const prefix = dir.replace(/\/$/, '') + '/';
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        seen.set(rest.split('/')[0], rest.includes('/'));
      }
      return [...seen].map(([name, isDirectory]) => ({ name, isDirectory, size: 1, mtime: 0 }));
    },
    async read() { return Buffer.from('x'); },
  });
  const local = mk({ '/l/a.php': '', '/l/debug.log': '', '/l/cache/x.tmp': '' });
  const remote = mk({ '/r/a.php': '' });
  const res = await compareTrees(local, remote, '/l', '/r', { exclude: ['*.log', 'cache/**', 'cache'] });
  assert.equal(res.length, 0);
});
