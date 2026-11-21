import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function compare(source, fast, file = 'instantiation.ts') {
  const options = { file, logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = (actual.path === 'fast' ? extractYuku : extractFallback)(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const bases = { Simple: 'id<T>', Nested: 'id<Box<T>>', Member: 'object.id<T>' };
const operators = { LeftShift: '<<', RightShift: ' >> ', Unsigned: '\n>>> ', Inclusive: ' >= ' };
const rows = readFileSync(new URL('../verification/pict/low-generic-instantiation.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [base, follow, suffix] = row.split('\t');
  test(`Low* instantiation: ${base} ${follow} ${suffix}`, () => {
    const expression = `${bases[base]}${operators[follow]}limit`;
    const value = suffix === 'Compare' ? `(${expression}) < cutoff` : expression;
    const after = suffix === 'Invalid' ? 'const =' : 'const keep = a > b;';
    compare(`/* 海 */const value = ${value}; ${after}`, suffix !== 'Invalid');
  });
}

test('compound closers, unsupported followers and nearby comparisons keep their meaning', () => {
  compare('const out = id<T>>limit; const copy = id<T>>>limit;', true);
  compare('const out = id<T> >> limit; const copy = id<T><<limit;', true, 'instantiation.tsx');
  compare('const out = id<T><=limit; const other = id<T> >> limit < cutoff;', true);
  compare('const out = id<T> > limit; const other = a >= b;', false);
  compare('const out = id<T>.field; const other = a >= b;', false);
  compare('const out = id<T> = value; const other = a >= b;', false);
  compare('const out = (id<A<B>> / x) >= n; const other = a >= b;', false);
});
