import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'var-bindings.ts', mode: 'module', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-var-bindings.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [context, shape, scope] = row.split('\t');
  test(`Pulse var bindings: ${context} ${shape} ${scope}`, () => {
    const name = { Names: 'entry', Array: '[entry = (a < b)]', Object: '{ key: entry = (a < b) }' }[shape];
    const value = shape === 'Names' ? '(a >= b), next' : 'input';
    const statement = {
      Statement: `var ${name} = ${value};`,
      Classic: `for (var ${name} = ${value}; i < limit; i++) use(i);`,
      Collection: `for (var ${name} of items) use(i <= limit);`,
    }[context];
    const local = {
      VarOnly: '', Disjoint: 'const other = q >= p;', Conflict: 'let entry = q >= p;',
      Nested: 'use(() => { let entry = q >= p; return entry; });',
    }[scope];
    const source = `/* 🧪 海 */ function parse() { ${local} ${statement} return s < t; }`;
    compare(source, scope !== 'Conflict');
  });
}

test('var lists can repeat a name and conflicts are caught in either order', () => {
  compare('function f() { var x = 1, x = 2; return a < b; }', true);
  compare('function f() { var { x } = o; { let x = a < b; } }', false);
  compare('function f() { for (var [x] in o) {} let x = a < b; }', false);
  compare('function f() { var { x }; return a < b; }', false);
  compare('function f() { for (var [x]; a < b;) {} }', false);
  compare('function f() { for (var [x], y of o) {} return a < b; }', false);
});
