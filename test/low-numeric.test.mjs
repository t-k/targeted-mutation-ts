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

const tokens = {
  Decimal: { Valid: '1_234_567', Invalid: '0_1' },
  Fraction: { Valid: '.12_34', Invalid: '1._2' },
  Exponent: { Valid: '2.34e-5_6', Invalid: '1e+' },
  Hex: { Valid: '0xF_F', Invalid: '0x_F' },
  Octal: { Valid: '0O7_1', Invalid: '0o8' },
  Binary: { Valid: '0B10_10', Invalid: '0b102' },
  BigInt: { Valid: '0xFFn', Invalid: '1.2n' },
};
const rows = readFileSync(new URL('../verification/pict/low-numeric.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [family, side, validity] = row.split('\t');
  test(`Low* numeric: ${family} ${side} ${validity}`, () => {
    const number = tokens[family][validity];
    const expression = side === 'Left' ? `${number} /* > */ >= limit` : `limit < ${number}`;
    compare(`const ok = ${expression};`, validity === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('complete number tokens preserve dots, signs, and type punctuation', () => {
  for (const source of [
    'const ok = 1..toString().length > 0;',
    'const ok = 1. < limit;',
    'const ok = 2e+3.toString().length > 0;',
    'const ok = -.3E+1 >= limit;',
    'const ok = (100_000n) > limit;',
    'type Level = -2 | 0 | 0xFF; const ok = level >= 10;',
  ]) compare(source, 'fast');
  for (const value of ['01', '1__0', '0x', '1_n', '123number', '1e2n', '2_e3']) {
    compare(`const earlier = a < b; const invalid = ${value};`, 'diagnostic');
  }
});

test('contextual operators preserve comparison precedence and keyword boundaries', () => {
  for (const source of [
    'const ok = (value as const) < limit;',
    'const ok = value as const > limit;',
    'const ok = value as const | Label > limit;',
    'const ok = value as const[] > limit;',
    'const ok = value satisfies Box<number> && other < max;',
    'const ok = value < max satisfies boolean;',
    'const ok = value instanceof Constructor && other < max;',
    'const ok = value instanceof Constructor < max;',
    'const ok = value\ninstanceof Constructor < max;',
    'const ok = satisfiesFunction(a < b);',
  ]) compare(source, 'fast');
  compare('const ok = value as const < limit;', 'diagnostic');
  compare('const ok = value as const | Label < limit;', 'diagnostic');
  compare('const ok = value\nsatisfies number < max;', 'diagnostic');
});
