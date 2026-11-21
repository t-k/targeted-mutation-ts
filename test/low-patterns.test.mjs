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

const patterns = {
  Nested: '[[start, end], { count: value }]',
  Holes: '[, value, , end]',
  Rest: '{ header: [value], ...rest }',
};
const contexts = {
  Module: pattern => `const ${pattern} = source; const ok = value < limit;`,
  Arrow: pattern => `const check = (${pattern}: Input) => value < limit;`,
  Collection: pattern => `for (const ${pattern} of source) { if (value < limit) run(); }`,
};
const rows = readFileSync(new URL('../verification/pict/low-patterns.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [shape, context, suffix] = row.split('\t');
  test(`Low* pattern: ${shape} ${context} ${suffix}`, () => {
    const source = contexts[context](patterns[shape]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('nested bindings retain duplicate detection, rest placement and scope', () => {
  for (const source of [
    'const { data: [first, , ...tail], info: { value } } = source; const ok = first < value;',
    'try { run(); } catch ({ errors: [first, ...other] }) { if (other.length >= 2) report(first); }',
    'const rows = [ , a < b,, [1,,2], ...tail, ]; const ok = rows.length > max;',
    'function f([first, { value }]: Data) { const result = () => value < first; return result(); }',
  ]) compare(source, 'fast');
  for (const source of [
    'const [value, { key: value }] = input; const ok = a < b;',
    'const { value, ...value } = input; const ok = a < b;',
    'const [first, ...tail,] = input; const ok = a < b;',
    'const { ...tail, next } = input; const ok = a < b;',
    'const [, value, {...tail}, { key: }] = input; const ok = a < b;',
    'const ok = fn(a < b,,value);',
  ]) compare(source, 'diagnostic');
});

test('binding patterns delegate cleanly at the nesting limit', () => {
  for (const depth of [16, 17]) {
    const pattern = '['.repeat(depth) + 'value' + ']'.repeat(depth);
    compare(`const ${pattern} = source; const ok = value < limit;`, depth === 16 ? 'fast' : 'fallback');
  }
});
