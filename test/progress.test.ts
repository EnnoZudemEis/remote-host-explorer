import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransferTracker, fmtBytes, fmtDuration } from '../src/progress';

const clock = () => {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test('fmtBytes / fmtDuration', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtBytes(3 * 1024 ** 3), '3.00 GB');
  assert.equal(fmtDuration(0), '0 s');
  assert.equal(fmtDuration(45), '45 s');
  assert.equal(fmtDuration(200), '3 min 20 s');
  assert.equal(fmtDuration(3900), '1 h 05 min');
});

test('percent by bytes across files, speed and eta', () => {
  const c = clock();
  const tr = new TransferTracker(2, 2000, c.now);
  tr.startFile('a.txt', 1000);
  c.advance(1000);
  tr.addBytes(500);
  let s = tr.snapshot();
  assert.equal(s.fileNumber, 1);
  assert.equal(s.percent, 25);
  assert.equal(s.speed, 500);
  assert.equal(s.etaSeconds, 3); // 1500 bytes left at 500 B/s
  c.advance(1000);
  tr.addBytes(1000);
  tr.finishFile();
  tr.startFile('b.txt', 1000);
  s = tr.snapshot();
  assert.equal(s.fileNumber, 2);
  assert.equal(s.percent, 50);
  assert.equal(tr.files, 1);
});

test('no speed or eta without data, no division by zero', () => {
  const c = clock();
  const tr = new TransferTracker(1, 0, c.now);
  let s = tr.snapshot();
  assert.equal(s.speed, undefined);
  assert.equal(s.etaSeconds, undefined);
  assert.equal(s.percent, 0);
  tr.startFile('empty', 0);
  c.advance(2000);
  tr.finishFile();
  s = tr.snapshot();
  assert.equal(s.percent, 100); // all files done, size unknown (0 bytes)
  assert.equal(s.fileNumber, 1);
});

test('percent is capped and bytes never exceed the larger of size and reported', () => {
  const c = clock();
  const tr = new TransferTracker(1, 100, c.now);
  tr.startFile('x', 100);
  tr.addBytes(250); // file grew while uploading
  assert.equal(tr.snapshot().percent, 100);
  tr.finishFile();
  assert.equal(tr.bytes, 250);
});

test('speed uses only the recent window', () => {
  const c = clock();
  const tr = new TransferTracker(1, 100000, c.now);
  tr.startFile('big', 100000);
  c.advance(1000); tr.addBytes(50000); // fast start: 50 KB/s
  c.advance(5000); tr.addBytes(50000); // then stalled
  c.advance(1000); tr.addBytes(51000);
  const s = tr.snapshot();
  assert.ok(s.speed !== undefined && s.speed < 5000, `speed ${s.speed}`);
});
