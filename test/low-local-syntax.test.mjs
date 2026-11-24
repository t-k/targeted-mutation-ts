import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, path, logical = false) {
  const options = { file: 'local.tsx', logical, requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const matrix = readFileSync(new URL('../verification/pict/low-local-syntax.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [syntax, placement, suffix] of matrix) {
  test(`Low* local syntax ${syntax} ${placement} ${suffix}`, () => {
    const body = syntax === 'LocalList' ?
      'let first = left >= bound, other: number, last = first <= end;' :
      'const view = <Layer.Group.Root show={x < y}><Layer.Item /><Layer.Child>{left >= bound}</Layer.Child></Layer.Group.Root>;';
    const input = { Module: body, Function: `function run() { ${body} }`, Arrow: `const run = () => { ${body} };` }[placement];
    check('/* 🧪 */ ' + input + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('local declaration lists share name checks and preserve comparison boundaries', () => {
  check('function f() { const first = read<T, U>(item), { other } = pick(); return other < max; }', 'fast');
  check('function f() { let first, second, last; return a < b; }', 'fast');
  check('function f() { const a = x >= y, a = x <= z; }', 'diagnostic');
  check('function f() { let a = x >= y, b; const b = 123; }', 'diagnostic');
  check('function f() { const a = x < y, b = value; }', 'fast');
  check('function f() { const a = x < y, b = value > 1; }', 'fallback');
  check('function f() { const a = x >= y, b; }', 'diagnostic');
  check('function f() { const a = x >= y,; }', 'diagnostic');
});

test('dotted JSX names keep complete tags and logical diagnostics', () => {
  check('const x = <this.Component.Part visible={a < b} />;', 'fast');
  check('const x = <Root.Part>{a < b}</Root.Other>;', 'diagnostic');
  check('const x = <Root.Part extra.value={a < b} />;', 'diagnostic');
  check('const x = <Root.Part disabled={left || right} />;', 'fallback', true);
  check('const x = <Root..Part />; const keep = a < b;', 'diagnostic');
  check('const x = <Root.Part-Value>{a < b}</Root.Part-Value>;', 'fast');
});
