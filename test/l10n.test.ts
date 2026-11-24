/**
 * Consistency of the translations (runs without VS Code):
 *  - every t('…') message in src/ exists in l10n/bundle.l10n.de.json and the bundle has no stale entries
 *  - placeholders {0}, {1}, … match between English key and German text
 *  - every %key% in package.json exists in package.nls.json and package.nls.de.json
 *  - no German characters in the source code (messages are English, German lives in the bundle)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sourceFiles(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
}

const unescape = (lit: string): string =>
  JSON.parse(`"${lit.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`);

const files = sourceFiles(path.join(ROOT, 'src'));
const keys = new Set<string>();
const badStyle: string[] = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
  // t() must get a plain single-quoted literal, otherwise the key cannot be checked
  for (const m of text.matchAll(/(?<![\w.])t\(\s*([`"])/g)) badStyle.push(`${path.relative(ROOT, f)}: t(${m[1]}…`);
}
const bundle: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n/bundle.l10n.de.json'), 'utf8'));

test('t() is always called with a single-quoted string literal', () => {
  assert.deepEqual(badStyle, []);
});

test('every message used in src/ has a German translation', () => {
  const missing = [...keys].filter((k) => !(k in bundle));
  assert.deepEqual(missing, []);
});

test('the German bundle has no stale entries', () => {
  const stale = Object.keys(bundle).filter((k) => !keys.has(k));
  assert.deepEqual(stale, []);
});

test('placeholders match between English key and German text', () => {
  const ph = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = Object.entries(bundle).filter(([k, v]) => ph(k) !== ph(v)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('package.json %keys% exist in both package.nls files, and both files have the same keys', () => {
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const used = new Set([...pkg.matchAll(/"%([\w.]+)%"|%([\w.]+)%/g)].map((m) => m[1] ?? m[2]));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
  const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.de.json'), 'utf8'));
  assert.deepEqual([...used].filter((k) => !(k in en)), [], 'missing in package.nls.json');
  assert.deepEqual([...used].filter((k) => !(k in de)), [], 'missing in package.nls.de.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
  assert.deepEqual(Object.keys(en).filter((k) => !used.has(k)), [], 'unused keys in package.nls.json');
});

test('source code contains no German characters (messages are English)', () => {
  const offenders = files.filter((f) => /[äöüÄÖÜß]/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
});
