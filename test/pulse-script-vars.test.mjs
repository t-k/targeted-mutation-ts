import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function check(source, mode, fast) {
  const options = { file: 'scope.js', mode, requireNative: true };
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-script-vars.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [mode, scope, binding] = row.split('\t');
  test(`Pulse script var: ${mode} ${scope} ${binding}`, () => {
    const declaration = {
      Var: 'var count = a < b\n const spare = c >= d;',
      Lexical: 'let count = a < b; const spare = c >= d;',
      Conflict: 'let count = a < b; var count;',
    }[binding];
    const script = {
      Root: declaration,
      Function: `function run() { ${declaration} }`,
      DirectiveFunction: `var run = (function () { 'use strict'; ${declaration} });`,
      Nested: `var run = (function () { 'use strict'; let count; function inner() { ${declaration} } });`,
    }[scope];
    const directive = mode === 'StrictScript' ? '"use strict"; ' : '';
    const limited = mode === 'Script' && scope === 'Function' && binding === 'Var';
    check(directive + '/* 海 🧪 */ ' + script, mode === 'Module' ? 'module' : 'script',
      binding !== 'Conflict' && !limited);
  });
}

test('strict directives do not enable script local var in sibling functions', () => {
  check('const strict = () => { "use strict"; var n; let m; return n >= m; };', 'script', true);
  check('const strict = () => { "use strict"; var n; }; function loose() { var m; return a < b; }', 'script', false);
  check('"use strict"; function loop() { for (var n of values) record(n < max); }', 'script', true);
  check('var value = 1; export { value };', 'script', false);
  check('var value = a < b; await f();', 'script', false);
});

test('leading script vars retain legacy root control and discard a malformed tail', () => {
  const source = 'var seed = lo < hi; for (var i = 0; i < bound; i++) record(i >= seed);';
  check(source, 'script', true);
  check(source + ' const =;', 'script', false);
});
