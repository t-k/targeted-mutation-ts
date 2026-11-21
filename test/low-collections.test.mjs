import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const bindings = { Name: 'value', Record: '{ current: value }', Array: '[index, value]' };
const rows = readFileSync(new URL('../verification/pict/low-collections.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [loop, binding, suffix] = row.split('\t');
  test(`Low* collection loop: ${loop} ${binding} ${suffix}`, () => {
    const source = 'function run(values: Item[]) { for (const ' + bindings[binding] + ' ' +
      loop.toLowerCase() + ' values) { const value = 0; if (value < 1) log(value); } }' +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('collection syntax preserves errors in the binding or iterable', () => {
  for (const source of [
    'for (const [x, x] of rows) { if (x < y) run(); }',
    'for (const x = start of rows) { if (x < y) run(); }',
    'for (let x of ) { if (x < y) run(); }',
  ]) compare(source, 'diagnostic');
});

test('type assertions preserve relational precedence, comments, and operand spans', () => {
  for (const source of [
    'const ok = (list[0]?.value as number) < max;',
    'const ok = value as Box<number> /* > */ >= max;',
    'const ok = value as number || other < max;',
    'const ok = value as number & Sized && other < max;',
    'const ok = value as number < max;',
    'const ok = value < max as boolean;',
    'const ok = value as number > min && value <= limit;',
    'const ok = value as number | null;',
  ]) compare(source, 'fast');
  compare('const ok = value as Type < max', 'diagnostic');
  compare('const ok = value\nas number < max;', 'diagnostic');
  compare('const ok = value as asserts as target > max;', 'diagnostic');
  const predicate = 'const ok = value as asserts as\nnumber < max;';
  const declined = extract(predicate, { requireNative: true });
  assert.notEqual(declined.path, 'fast');
  assert.deepEqual(declined.candidates, extractFallback(predicate).candidates);
});

test('unbraced control flow associates else with the nearest if', () => {
  compare('if (a < b) while (c < d) if (x >= y) x++; else x--;', 'fast');
  compare('if (a < b) if (c > d) f(); else g(); else h();', 'fast');
  compare('if (a < b) while (c < d) const x = 0;', 'diagnostic');
});
