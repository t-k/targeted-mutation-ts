import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const inferences = {
  Plain: 'Items extends infer Item ? Item : never',
  Constraint: 'Items extends infer Item extends Record<Key, Value> ? Item : never',
  Tuple: 'Items extends [infer Head, ...infer Tail] ? Head | Tail : never',
  Generic: 'Items extends Array<infer Item> ? Item : never',
};
const contexts = {
  Alias: value => `type Item = ${value};`,
  Call: value => `const out = select<${value}>(x < y) >= min;`,
  Assertion: value => `const out = (source as ${value}) < min;`,
};
const rows = readFileSync(new URL('../verification/pict/low-inferred-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [form, context, suffix] = row.split('\t');
  test(`Low* inferred type: ${form} ${context} ${suffix}`, () => {
    const source = `const before = a < b; ${contexts[context](inferences[form])} const after = a >= b;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('an inferred name uses strict binding syntax and may follow a line terminator', () => {
  for (const name of ['', 'this', 'eval', 'arguments']) {
    compare(`const before = a < b; type Item = infer ${name};`, 'diagnostic');
  }
  compare('type Item = infer\nName; const ok = a < b;', 'fast');
  compare('type Item = infer string; const ok = a < b;', 'fast');
});

test('extends after an inferred check type cannot expose conditional type tokens as runtime comparisons', () => {
  for (const expression of ['a as infer V extends T ? A : B < C', 'a as infer V extends T ? x() : y()']) {
    compare(`const before = b >= c; const x = ${expression};`, 'diagnostic');
  }
  compare('const out = (x as infer A extends B ? C : D) < max;', 'fast');
  compare('type Bounded = infer V extends T; const ok = x < max;', 'fallback');
});
