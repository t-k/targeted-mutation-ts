import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, options, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-prototype-setters.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [first, second, placement] = row.split('\t');
  test(`Pulse object prototype setter: ${first} ${second} ${placement}`, () => {
    const property = (form, expression) => ({
      Identifier: `__proto__: ${expression}`, Quoted: `"__proto__": ${expression}`,
      Computed: `["__proto__"]: ${expression}`, Method: `__proto__() { return ${expression}; }`, Shorthand: '__proto__',
    })[form];
    const last = property(second, 'x >= y');
    const close = placement === 'Nested' ? `other: { ${last} }` : last;
    const source = `/* 海 🧪 */ const value = { ${property(first, '(a < b)')}, ${close} };` +
      (placement === 'Broken' ? ' const =' : '');
    const duplicate = placement !== 'Nested' && first !== 'Computed' && ['Identifier', 'Quoted'].includes(second);
    compare(source, { file: 'prototype.ts', requireNative: true }, !duplicate && placement !== 'Broken');
  });
}

test('prototype keys that require escape normalization decline', () => {
  compare(String.raw`const value = { __proto__: a < b, "\u005f_proto__": x >= y };`, { file: 'prototype.ts' }, false);
});

for (const [name, source, fast] of [
  ['with a top-level directive', '"use strict"; { function check() { return a < b; } }', true],
  ['with block-local shadowing', '"use strict"; { let value; { function value() { return a < b; } } }', true],
  ['with a duplicate binding', '"use strict"; { function name() {} let name = a < b; }', false],
  ['in a sloppy script', '{ function check() { return a < b; } }', false],
  ['as a single statement', '"use strict"; if (ok) function check() { return a < b; }', false],
]) {
  test(`Pulse block function ${name}`, () => compare(source, { mode: 'script', file: 'block.cjs', requireNative: true }, fast));
}
