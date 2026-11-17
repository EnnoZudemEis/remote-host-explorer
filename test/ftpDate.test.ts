import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListDate } from '../src/connection/ftpDate';

const now = new Date(Date.UTC(2026, 10, 17, 12, 0)); // 2026-11-17 12:00 UTC

test('parses date with time in the current year', () => {
  assert.equal(parseListDate('Nov 17 09:30', now), Date.UTC(2026, 10, 17, 9, 30));
});

test('time entry in the future falls back to previous year', () => {
  assert.equal(parseListDate('Dec 25 10:00', now), Date.UTC(2025, 11, 25, 10, 0));
});

test('parses date with explicit year', () => {
  assert.equal(parseListDate('Jan  3  2024', now), Date.UTC(2024, 0, 3));
});

test('returns undefined for garbage', () => {
  assert.equal(parseListDate(undefined, now), undefined);
  assert.equal(parseListDate('foo bar', now), undefined);
});
