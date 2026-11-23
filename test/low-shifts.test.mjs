import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function compare(source, path, options = {}) {
  const actual = extract(source, { ...options, requireNative: true });
  const reference = (actual.path === 'fast' ? extractYuku : extractFallback)(source, options);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const shifts = { Left: '<<', Right: '>>', Unsigned: '>>>' };
const contexts = {
  LeftOperand: (op, gap) => `a+b${gap}${op}${gap}c*d<z`,
  RightOperand: (op, gap) => `z>a+b${gap}${op}${gap}c*d`,
  Assignment: (op, gap) => `(state${gap}${op}=${gap}(a<b))>=z`,
};
const rows = readFileSync(new URL('../verification/pict/low-shifts.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [shift, context, trivia] = row.split('\t');
  test(`Low* shift: ${shift} ${context} ${trivia}`, () => {
    const gap = trivia === 'Comments' ? ' /* 値 */ ' : '';
    compare(`const out = ${contexts[context](shifts[shift], gap)};`, 'fast');
  });
}

test('shift tokens preserve complete type arguments and nearby relational spans', () => {
  compare('const out = id<Type<Arg>>(n < limit) >> shift;', 'fast');
  compare('const out = id<T>>limit; const copy = id<T>>>limit;', 'fast');
  compare('const out = id<T> >> limit; const copy = id<T><<limit;', 'fast');
  compare('const out = <Box value={first << bits < limit} />;', 'fast', { dialect: 'tsx' });
});

test('malformed shift operators or assignment targets decline a candidate prefix', () => {
  for (const suffix of ['const out = a<<<<b;', 'const out = a >> = b;', 'const out = x >>>;',
    'const v = (left + right) <<= 1;', 'obj?.prop >>>= 2;']) {
    compare(`const before = one < two; ${suffix}`, 'diagnostic');
  }
});

test('nested type arguments are never exposed as comparisons by a packed right shift', () => {
  for (const prefix of ['id<T<U>>', 'id <T<U>>', 'id<T<U<V>>>']) {
    compare(`const before = one < two; const value = ${prefix}/x/;`, 'diagnostic');
    compare(`const value = ${prefix}/x/g < limit;`, 'fallback');
    compare(`const value = ${prefix}\n"text"; const ok = one < two;`, 'fallback');
    // Type arguments that touch the tag belong to the tagged template.
    compare(`const value = ${prefix}\u0060text\u0060; const ok = one < two;`, prefix.includes(' <') ? 'fallback' : 'fast');
  }
  compare('const value = data >> /x/g < limit;', 'fast');
});
