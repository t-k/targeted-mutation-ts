import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'scopes.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-mixed-block-scopes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [relation, order, spelling] = row.split('\t');
  test(`Pulse mixed block scope: ${relation} ${order} ${spelling}`, () => {
    const binding = spelling === 'Equal' ? 'shared' : 'different';
    const variable = 'var shared = a >= b;';
    const lexical = `let ${binding} = c < d;`;
    const arrange = (varText, lexicalText) => (order === 'VarFirst'
      ? [varText, lexicalText] : [lexicalText, varText]).join('\n');
    const layouts = {
      Same: arrange(variable, lexical),
      Ancestor: arrange(`{ ${variable} }`, lexical),
      Child: arrange(variable, `{ ${lexical} }`),
      Sibling: arrange(`{ ${variable} }`, `{ ${lexical} }`),
      Loop: arrange(variable, `for (let ${binding} = 0; ${binding} < max; ${binding}++) consume(${binding});`),
      Catch: arrange(variable, `try { call(); } catch (${binding}) { consume(c < d); }`),
      Switch: `switch (count) { case 0: ${arrange(variable, lexical)} }`,
      Function: arrange(`use(() => { ${variable} });`, lexical),
    };
    const source = `/* 海 🧪 */ function run() { ${layouts[relation]} return x < y; }`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    const invalid = spelling === 'Equal' && ['Same', 'Ancestor', 'Switch'].includes(relation);
    assert.equal(result.path === 'fast', !invalid, source);
  });
}

test('loop and catch scopes retain enclosing lexical conflicts while child-only names can be reused', () => {
  for (const [body, valid] of [
    ['for (let x of values) { var x; }', false],
    ['for (let x = 0; x < limit; x++) { var x; }', false],
    ['try { run(); } catch ({x}) { var x; }', false],
    ['try { run(); } catch ({x}) { use(x); } { var x; }', true],
    ['switch (n) { case 0: { let x; } case 1: var x; }', true],
    ['let x; { var x; }', false],
  ]) {
    const source = `function run() { keep(a < b); ${body} keep(c >= d); }`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    assert.equal(result.path === 'fast', valid, source);
  }
});
