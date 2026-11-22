import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function verify(source, path) {
  const options = { file: 'css-forms.ts', requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-css-syntax.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [feature, placement, suffix] of rows) {
  test(`Low* CSS forms ${feature} ${placement} ${suffix}`, () => {
    const expression = {
      Enum: 'const enum Token { A = "a", "β" = (a < b), Third }',
      NumericKey: 'const map = { 2015: [a < b], .5: n >= m, 0x10: x > y };',
      Override: 'class C extends Base { override read() { return n >= m; } }',
      RegexBMP: String.raw`const ok = /(?<=^|[^\w\-\u0080-\uffff])url/u.test(input) && n >= m;`,
    }[feature];
    const prefix = { Module: '', Export: 'export ', Nearby: 'const before = x < y; ' }[placement];
    verify('/* 🧪 */ ' + prefix + expression + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('const enums keep module bindings and member separator validation', () => {
  verify('const enum Token { A = a < b } const keep = a > b;', 'fast');
  verify('const enum Token { A = 1 } const enum Token { B = 2 } const keep = a < b;', 'fallback');
  verify('let Token; const enum Token { A = a < b }', 'diagnostic');
  verify('const enum Token { [key] = a < b }', 'diagnostic');
  verify('const enum Token { A = a < T, U > value }', 'diagnostic');
  verify('export const enum Token { A = a >= b, }', 'fast');
  verify('const enum Token { A = a >= b, } export { Token };', 'fast');
});

test('numeric keys, override and regex escapes keep their context', () => {
  verify('const map = { 1, value: a > b };', 'diagnostic');
  verify('const map = { 1(a: number) { return a < b; } };', 'fast');
  verify('class C { override() { return a < b; } }', 'fast');
  verify('class C { override override run() { return a < b; } }', 'diagnostic');
  verify('class C { override readonly size = a < b; }', 'fast');
  verify(String.raw`const match = /\u03bb/u.test(value) && a < b;`, 'fast');
  verify(String.raw`const match = /[\ud800-\udfff]/u.test(value) && a < b;`, 'fast');
});

test('override retains early diagnostics for invalid modifier combinations', () => {
  for (const member of [
    'private override public read() { return a < b; }',
    'readonly override readonly item = a < b;',
    'readonly override constructor() { if (a < b) {} }',
    'override declare read() { return a < b; }',
    'abstract override read() { return a < b; }',
    'override abstract item = a < b;',
  ]) verify(`class C extends Base { ${member} } const keep = a < b;`, 'diagnostic');
  verify('abstract class C extends Base { abstract override read(): boolean; } const keep = a < b;', 'fallback');
});
