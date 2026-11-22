import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path ?? reference.path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  return result;
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

test('mixed lexical and var name conflicts preserve errors across blocks', () => {
  for (const body of [
    'let n; { var n; }',
    '{ var n; } let n;',
    'for (let n = 0; n < 1; n++) var n;',
    'for (const n of values) var n;',
    'try {} catch ({ n }) { var n; }',
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

const varForms = {
  Statement: name => `var ${name} = a < b;`,
  ClassicFor: name => `for (var ${name} = 0; ${name} < limit; ${name}++) record(${name});`,
  Collection: name => `for (var ${name} of values) record(${name} < limit);`,
};
const lexicalForms = {
  Let: name => `let ${name} = c < d;`,
  Pattern: name => `const { key: ${name} = c < d } = value;`,
  ClassicFor: name => `for (let ${name} = 0; ${name} <= limit; ${name}++) record(${name});`,
  Collection: name => `for (const [${name}] of values) record(${name} <= limit);`,
  Catch: name => `try { record(c < d); } catch ({ key: ${name} }) { record(${name}); }`,
  Function: name => `function ${name}() { return c < d; }`,
  Class: name => `class ${name} { check() { return c < d; } }`,
};
const placements = {
  VarFirst: (varForm, lexical) => `${varForm('hoisted')} ${lexical('local')}`,
  LexicalFirst: (varForm, lexical) => `${lexical('local')} ${varForm('hoisted')}`,
  ConflictVarFirst: (varForm, lexical) => `{ ${varForm('shared')} } ${lexical('shared')}`,
  ConflictLexicalFirst: (varForm, lexical) => `${lexical('shared')} { ${varForm('shared')} }`,
  NestedFunction: (varForm, lexical) => `${lexical('shared')} var outer; consume(() => { ${varForm('shared')} let inner; });`,
};
const mixedRows = readFileSync(new URL('../verification/pict/low-mixed-vars.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of mixedRows) {
  const [varForm, lexical, placement] = row.split('\t');
  test(`Low* mixed locals: ${varForm} ${lexical} ${placement}`, () => {
    const body = placements[placement](varForms[varForm], lexicalForms[lexical]);
    const source = `function run() { record(first < last); ${body} record(left <= right); }`;
    compare(source, placement.startsWith('Conflict') ? undefined : 'fast');
  });
}

test('mixed locals only record bound value names in their function', () => {
  compare('function run(n) { var n; const { n: renamed } = value; return a < b; }', 'fast');
  compare('function run() { type n = string; var n; const m = a < b; }', 'fast');
  compare('function run() { var n; const [] = []; return a < b; }', 'fast');
  compare('function run() { var n; const m = () => { var m; let n; return a < b; }; }', 'fast');
  compare('function run() { var out; let shared; consume(() => { let inner; var shared; return a < b; }); }', 'fast');
  compare('function run() { var out; let local; consume(() => { var sibling; let inner; }); let sibling; return a < b; }', 'fast');
  compare('function run() { var n; const m = a < b; const k = () => { var m; let n; }; { let n; } }');
});

test('mixed local refusal rolls back native candidates and retry marks', () => {
  const require = createRequire(import.meta.url);
  const { parse } = require('../build/tmt.node');
  const source = 'function run() { record(a < b); var n; { let n; } }';
  const [status, , nodes, bytes, ...candidates] = parse(Buffer.from(source), false, true);
  assert.deepEqual({ status, nodes, bytes, candidates }, { status: 1, nodes: 0, bytes: 0, candidates: [] });
  compare(source);
  compare('function run() { record(a < b); var n; { let m; } }', 'fast');
  for (const invalid of [
    'var eval; const local = a < b;',
    'const local = a < b; for (var arguments of values) record(local);',
    'var n; const m = a < b; const m = c < d;',
    'const m = a < b; var n:;',
  ]) compare(`function run() { ${invalid} }`, 'diagnostic');
});

test('the exact local binding budget only applies during a mixed-source retry', () => {
  const block = '{ let repeat; }';
  const lexical = block.repeat(512);
  compare(`function run() { ${lexical} return a < b; }`, 'fast');
  compare(`function run() { var hoisted; ${block.repeat(511)} return a < b; }`, 'fast');
  compare(`function run() { var hoisted; ${lexical} return a < b; }`);
});

test('the mixed-source retry also works across candidate capacity retries', () => {
  const comparisons = 'record(a < b);'.repeat(70);
  for (const body of [
    `var hoisted; let local; ${comparisons}`,
    `var hoisted; ${comparisons} let local;`,
  ]) {
    const result = compare(`function run() { ${body} }`, 'fast');
    assert.equal(result.candidates.length, 70);
    assert.ok(result.metrics.candidateBytes > 0);
  }
});
