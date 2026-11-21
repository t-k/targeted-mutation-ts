import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'readonly.ts', logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const bases = { Named: 'Model', Generic: 'NonNullable<Model["items"]>', Tuple: '[Item, Option]', Grouped: '(A extends B ? C : D)' };
const suffixes = { IndexArray: '[K][number][]', Index: '[K]', ArrayIndex: '[][K]', Newline: '\n[K][]' };
const uses = {
  Alias: type => `type Read = ${type}; const keep = a < b;`,
  Annotation: type => `const list: ${type} = value; const keep = a > b;`,
  Assertion: type => `const keep = (value as ${type}) >= limit;`,
};
const rows = readFileSync(new URL('../verification/pict/low-readonly-indexed.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [base, suffix, use] = row.split('\t');
  test(`Low* readonly indexed type: ${base} ${suffix} ${use}`, () => {
    compare(`/* 海 */const before = a <= b; ${uses[use](`readonly ${bases[base]}${suffixes[suffix]}`)}`, suffix !== 'Newline');
  });
}

test('readonly suffix expansion preserves existing unsupported forms', () => {
  compare('type X = readonly <T>() => T; const keep = a < b;', false);
  compare('type X = readonly new () => T; const keep = a < b;', false);
  compare('const get = (items: readonly Model["items"][number][]) => items.length > max;', true);
  compare('const keep = a < b; type X = readonly Model[Key][]; const =', false);
});
