import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast, mode = 'module') {
  const options = { file: 'resources.ts', mode, requireNative: true };
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}
const entries = readFileSync(new URL('../verification/pict/pulse-resource-declarations.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const entry of entries) {
  const [scope, keyword, binding] = entry.split('\t');
  test(`Pulse resource declaration: ${scope} ${keyword} ${binding}`, () => {
    const bindings = {
      Single: 'handle: Disposable = open(a < b)', Multiple: 'handle = open(a < b), other = open(c > d)',
      Missing: 'handle: Disposable', Pattern: '{ handle } = open(a < b)',
    };
    const declaration = (keyword === 'Using' ? 'using ' : 'await using ') + bindings[binding] + ';';
    const contexts = {
      Function: `function run() { ${declaration} }`,
      AsyncFunction: `async function run() { ${declaration} }`,
      Module: declaration,
      Script: declaration,
      SwitchCase: `function run() { switch (kind) { case 0: ${declaration} break; } }`,
      SwitchBlock: `function run() { switch (kind) { case 0: { ${declaration} break; } } }`,
    };
    const allowed = !['SwitchCase', 'Script'].includes(scope) && ['Single', 'Multiple'].includes(binding) &&
      (keyword === 'Using' || ['AsyncFunction', 'Module'].includes(scope));
    compare('/* 海 🧪 */ const first = a >= b; ' + contexts[scope], allowed, scope === 'Script' ? 'script' : 'module');
  });
}

test('contextual using tokens and lexical ordinary names retain their scope and boundaries', () => {
  compare('const using = age >= 18; function f() { using(n < limit); }', true);
  compare('async function run() { await using(a < b); }', true);
  compare('function run() { using\nitem = a < b; }', true);
  compare('async function run() { await\nusing handle = open(a < b); }', false);
  compare('function run() { let handle; using handle = open(a < b); }', false);
  compare('function run() { var handle; using handle = open(a < b); }', false);
  compare('function run() { var handle; { using other = open(a < b); } return c > d; }', true);
  compare('function run() { using handle = open(a < b), { rest } = read(); }', false);
  compare('using handle = open(a < b); const =', false);
});
