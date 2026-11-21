import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path ?? reference.path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const declarations = {
  Plain: 'var n; record(n < limit);',
  Typed: 'var n: number | string; if (value < limit) record(n);',
  Init: 'var n: boolean = low < high; return n;',
  ClassicFor: 'for (var i = 0; i < limit; i++) { for (var j = 0; j <= i; j++) record(j); }',
};
const contexts = {
  Function: body => `function run() { ${body} }`,
  Arrow: body => `const run = () => { ${body} };`,
  Async: body => `async function run() { ${body} }`,
};
const rows = readFileSync(new URL('../verification/pict/low-vars.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [declaration, context, suffix] = row.split('\t');
  test(`Low* local var: ${declaration} ${context} ${suffix}`, () => {
    const source = contexts[context](declarations[declaration]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('function-local vars keep redeclarations, and nested callbacks have independent modes', () => {
  compare('function run(n) { var n; { var n = n < limit; } return n; }', 'fast');
  compare('function run() { var n = x < y; runLater(() => { const n = p < q; record(n); }); }', 'fast');
  compare('function run() { const n = x < y; runLater(function () { var n; return p < q; }); }', 'fast');
  compare('const n = x < y; function run() { var n; return p < q; }', 'fast');
  compare('function run() { if (x < y) var n: number; try {var m;} catch { var n; } }', 'fast');
});

test('mixed lexical and var declarations delegate and preserve errors across blocks', () => {
  for (const body of [
    'let n; { var n; }',
    '{ var n; } let n;',
    'for (let n = 0; n < 1; n++) var n;',
    'for (const n of values) var n;',
    'try {} catch ({ n }) { var n; }',
    'const n = a < b; var m;',
    'var m; const n = a < b;',
    'var m; function n() {}',
  ]) {
    const source = `function run() { record(a < b); ${body} }`;
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
  compare('function run() { var n:; if (a < b) record(n); }', 'diagnostic');
});
