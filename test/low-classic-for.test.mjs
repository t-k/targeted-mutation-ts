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

const initializers = {
  Assignment: 'pos = first < last',
  Sequence: 'pos = 0, first = a < b',
  Typed: 'let pos: number = 0, ready: boolean = a > b',
  Destructured: 'let [, value = ""] = words, pos = a < b',
  Constant: 'const { item: value = {} } = options, start: number = a < b',
};
const bodies = {
  Block: '{ output(value <= max); }',
  Single: 'output(value >= max);',
  Shadow: '{ let pos = 1; output(pos > max); }',
};
const rows = readFileSync(new URL('../verification/pict/low-classic-for.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [initializer, body, suffix] = row.split('\t');
  test(`Low* classic for: ${initializer} ${body} ${suffix}`, () => {
    const source = `/* 海 */const before = a < b; for (${initializers[initializer]}; pos < max, pos >= low; pos++, tick(x > y)) ${bodies[body]}` +
      (suffix === 'Invalid' ? '\nconst =' : '\nconst after = a <= b;');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('loop header bindings can shadow and be reused across scopes', () => {
  compare('function read() { let pos = 0; for (let pos: number; pos < cap; pos++) { let pos = 2; record(pos > low); } for (let pos = 0; pos >= low; pos--) {} return pos < cap; }', 'fast');
  compare('for ((key in data); key < cap; key++) {} for (; key > cap, ready; key--, record(y < x)) {}', 'fast');
});

test('malformed and conflicting bindings cannot publish comparisons in a classic head', () => {
  for (const loop of ['for (let [pos] = source, pos = 0; pos < cap; pos++) {}',
    'for (const pos: number; pos < cap; pos++) {}', 'for (let [pos]; pos < cap; pos++) {}',
    'for (let pos = key in table; pos < cap; pos++) {}', 'for (pos = 0,; pos < cap; pos++) {}']) {
    compare(`const before = a < b; ${loop}`, 'diagnostic');
  }
  compare('function read() { for (let pos = 0; pos < max; pos++) { var pos = 1; } }', 'diagnostic');
});

test('classic for initializer context preserves the reference arrow expression grammar', () => {
  for (const init of ['(x=>x in y)', 'const [items] = ((x)=>x in y)', 'x = 0, ((x)=>x in y)',
    '(function read() { return x=>x in y; })', '(x=> { return y=>y in z; })']) {
    compare(`const before = a >= b; for (${init}; a < b; a++) {}`, 'diagnostic');
  }
  for (const init of ['(x in y)', '(x=> (x in y))', '(x=>test ? x in y : false)', 'let f = x=>{ return x in y; }']) {
    compare(`for (${init}; a < b; a++) {}`, 'fast');
  }
  compare('const read = x => x in data; const ok = x < y;', 'fast');
});
