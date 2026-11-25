import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunk, computeHunks, splitLines } from '../src/compare/hunks';

test('splitLines handles CRLF, LF and a trailing newline', () => {
  assert.deepEqual(splitLines('a\r\nb\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
});

test('identical texts have no hunks', () => {
  assert.deepEqual(computeHunks(['a', 'b'], ['a', 'b']), []);
});

test('one changed line is one hunk and applyHunk moves it', () => {
  const a = ['x', 'img.png', 'y'];
  const b = ['x', 'img.jpg', 'y'];
  const h = computeHunks(a, b);
  assert.deepEqual(h, [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(applyHunk(a, b, h[0]), b);
});

test('separate changes are separate hunks that can be applied one by one', () => {
  const a = ['1', '2', '3', '4', '5', '6'];
  const b = ['1', 'two', '3', '4', '5', '6', '7'];
  const h = computeHunks(a, b);
  assert.equal(h.length, 2);
  const once = applyHunk(a, b, h[0]);
  assert.deepEqual(once, ['1', 'two', '3', '4', '5', '6']);
  const hAfter = computeHunks(once, b);
  assert.equal(hAfter.length, 1);
  assert.deepEqual(applyHunk(once, b, hAfter[0]), b);
});

test('insertion and deletion', () => {
  assert.deepEqual(computeHunks(['a'], ['a', 'b']), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(computeHunks(['a', 'b'], ['a']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
  assert.deepEqual(computeHunks([], ['a']), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
});

test('applying every hunk turns A into B', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const b = ['a', 'x', 'c', 'e', 'f', 'y', 'z', 'g'];
  let cur = a;
  for (let guard = 0; guard < 10; guard++) {
    const h = computeHunks(cur, b);
    if (!h.length) break;
    cur = applyHunk(cur, b, h[0]);
  }
  assert.deepEqual(cur, b);
});
