import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const values = {
  Raw: '`<h1>海</h1>`',
  Interpolation: '`π-${Set<T> | U} ≥ `',
  Nested: '`<${`inner-${T[]}`} --> ${U /* end */}>`',
};
const contexts = {
  Alias: value => `type Row<T, U> = ${value};`,
  Annotation: value => `const row: ${value} = fallback;`,
  Call: value => `const row = define<PanelScope, ${value}>(count < max) > limit;`,
};
const rows = readFileSync(new URL('../verification/pict/low-template-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [shape, context, suffix] = row.split('\t');
  test(`Low* template type: ${shape} ${context} ${suffix}`, () => {
    const source = `const before = a < b; ${contexts[context](values[shape])} const after = a >= b;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('template types preserve escapes and multiline text before later candidates', () => {
  for (const value of ['`a\\`b\\${raw}`', '`a\\u{03c0}\\x20\\0`', '`a\nβ`', '`a\\\r\nβ`']) {
    compare(`type Row = ${value}; const row = define<Row>(a) > b;`, 'fast');
  }
});

test('invalid template types cannot publish earlier comparison candidates', () => {
  for (const value of ['`a\\xZZ`', '`a\\u{110000}`', '`a\\01`', '`a${}`', '`a${T < U}`', '`a${T', '`missing']) {
    compare(`const before = a < b; type Row<T, U> = ${value};`, 'diagnostic');
  }
  compare('const before = a < b; const row = define<`a${T}`>(x < y;', 'diagnostic');
});
