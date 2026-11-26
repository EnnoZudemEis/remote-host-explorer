import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingState } from '../src/pending/pendingState';

test('a change is pending for every server, an upload only clears that server', () => {
  const s = new PendingState();
  for (const sv of ['Test', 'Live']) s.markChanged(sv, 'a.php', 'h1');
  s.markSynced('Test', 'a.php', 'h1');
  assert.deepEqual(s.list('Test'), []);
  assert.deepEqual(s.list('Live'), ['a.php']);
  assert.equal(s.total(), 1);
});

test('a later change is pending again, even after an upload', () => {
  const s = new PendingState();
  s.markSynced('Test', 'a.php', 'h1');
  s.markChanged('Test', 'a.php', 'h2');
  assert.deepEqual(s.list('Test'), ['a.php']);
});

test('undoing the change (same hash as last synced) removes the entry', () => {
  const s = new PendingState();
  s.markSynced('Test', 'a.php', 'h1');
  s.markChanged('Test', 'a.php', 'h2');
  s.markChanged('Test', 'a.php', 'h1');
  assert.deepEqual(s.list('Test'), []);
});

test('a download from a server marks the file as synced with that server only', () => {
  const s = new PendingState();
  s.markSynced('Test', 'a.php', 'h9'); // downloaded from Test
  s.markChanged('Test', 'a.php', 'h9'); // watcher event after the download
  s.markChanged('Live', 'a.php', 'h9');
  assert.deepEqual(s.list('Test'), []);
  assert.deepEqual(s.list('Live'), ['a.php']);
});

test('unknown hash always counts as pending', () => {
  const s = new PendingState();
  s.markSynced('Test', 'big.bin', undefined);
  s.markChanged('Test', 'big.bin', undefined);
  assert.deepEqual(s.list('Test'), ['big.bin']);
});

test('reconcile replaces the list and marks the server as reconciled', () => {
  const s = new PendingState();
  s.markChanged('Test', 'old.php', 'x');
  assert.equal(s.isReconciled('Test'), false);
  s.reconcile('Test', ['b.php', 'a.php']);
  assert.deepEqual(s.list('Test'), ['a.php', 'b.php']);
  assert.equal(s.isReconciled('Test'), true);
});

test('dismiss, removeEverywhere and prune', () => {
  const s = new PendingState();
  s.markChanged('Test', 'a', 'h'); s.markChanged('Live', 'a', 'h'); s.markChanged('Live', 'b', 'h');
  s.dismiss('Test', 'a');
  assert.deepEqual(s.list('Test'), []);
  s.removeEverywhere('a');
  assert.deepEqual(s.list('Live'), ['b']);
  s.prune(['Test']);
  assert.equal(s.count('Live'), 0);
});

test('state survives a JSON round trip', () => {
  const s = new PendingState();
  s.markChanged('Test', 'a', 'h'); s.markSynced('Live', 'b', 'k'); s.reconcile('Live', ['c']);
  const copy = new PendingState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(copy.list('Test'), ['a']);
  assert.deepEqual(copy.list('Live'), ['c']);
  assert.equal(copy.isReconciled('Live'), true);
});

test('removeWhere drops only matching entries', () => {
  const s = new PendingState();
  for (const rel of ['.claude/a.json', '.agents/b.md', 'src/c.ts']) s.markChanged('Live', rel);
  s.markChanged('Test', '.claude/a.json');
  assert.equal(s.removeWhere('Live', (rel) => rel.startsWith('.')), 2);
  assert.deepEqual(s.list('Live'), ['src/c.ts']);
  assert.deepEqual(s.list('Test'), ['.claude/a.json'], 'other servers are untouched');
  assert.equal(s.total(), 2);
  assert.equal(s.removeWhere('Unknown', () => true), 0);
});

test('listUnder returns the entries of a folder at any depth', () => {
  const s = new PendingState();
  for (const rel of ['src/a.ts', 'src/x/b.ts', 'srcx/c.ts', 'd.ts']) s.markChanged('Live', rel);
  assert.deepEqual(s.listUnder('Live', 'src'), ['src/a.ts', 'src/x/b.ts']);
  assert.deepEqual(s.listUnder('Live', 'src/'), ['src/a.ts', 'src/x/b.ts']);
});
