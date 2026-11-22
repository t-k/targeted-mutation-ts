import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'category.ts', requireNative: true };
function compare(pattern, flags, fast) {
  const source = `/* 海 🧪 */ const value = /${pattern}/${flags}.test(input) && a >= b;`;
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
  if (fast) assert.doesNotThrow(() => new RegExp(pattern, flags), source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-regex-categories.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [name, place, flags] = row.split('\t');
  test(`Pulse regex category: ${name} ${place} ${flags}`, () => {
    const atom = `\\p{${name}}`;
    const pattern = { Atom: atom, Class: `[${atom}]`, Group: `(${atom})+`, Range: `[a-${atom}]` }[place];
    const flagText = { Unicode: 'u', Combined: 'gu', NoUnicode: '', UnicodeSets: 'v' }[flags];
    const fast = name !== 'Invalid' && place !== 'Range' && flagText.includes('u');
    compare(pattern, flagText, fast);
  });
}

test('category escape modes do not bypass other regex validation', () => {
  compare(String.raw`[\p{Mc}\p{Me}\p{Mn}]`, 'u', true);
  compare(String.raw`\P{L}`, 'u', true);
  compare(String.raw`\p{L}\:`, 'u', false);
  compare(String.raw`[\p{L}-a]`, 'u', false);
  compare(String.raw`\p{mn}`, 'u', false);
  compare(String.raw`\p{L`, 'u', false);
  compare(String.raw`\p{L}`, 'uuu', false);
});
