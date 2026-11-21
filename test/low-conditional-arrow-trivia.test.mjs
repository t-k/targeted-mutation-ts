import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const branches = {
  Plain: '(item, active) => { return check(active ? item.count < limit : allow); }',
  Async: 'async (item: Item) => { return await load(item.count <= limit); }',
  TypedGeneric: '<T,>(item: T) => { return item.count >= limit; }',
};
const gaps = { Adjacent: '', Space: ' ', CRLF: '\r\n  ', Block: ' /* 海\n retained */ ', Unicode: '\u2028' };
const rows = readFileSync(new URL('../verification/pict/low-conditional-arrow-trivia.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [arrow, gap, outcome] = row.split('\t');
  test(`Low* conditional arrow trivia: ${arrow} ${gap} ${outcome}`, () => {
    const separator = outcome === 'MissingColon' ? ';' : ':';
    const after = outcome === 'InvalidStatement' ? '\nconst =' : '\nconst keep = a > b;';
    const source = `/* 🧪 */const fn = choose ? ${branches[arrow]}${gaps[gap]}${separator} value => value <= max;${after}`;
    const options = { file: 'conditional.tsx', logical: true, requireNative: true };
    const actual = extract(source, options);
    const reference = extractFallback(source, options);
    assert.equal(actual.path, outcome === 'Valid' ? 'fast' : reference.path, source);
    assert.deepEqual(actual.candidates, reference.candidates, source);
    assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  });
}
