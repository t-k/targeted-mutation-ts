import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'grouped.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-assignment-targets.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, grouping, operator] = row.split('\t');
  test(`Pulse grouped assignment: ${kind} ${grouping} ${operator}`, () => {
    const name = {
      Identifier: 'item', Member: 'record.value', Index: 'list[age >= minimum]',
      Call: 'get()', Array: '[item]', Restricted: 'eval',
    }[kind];
    const target = { Single: `(${name})`, Nested: `((${name}))`, Comma: `(other, ${name})` }[grouping];
    const expression = { Assign: `${target} = limit < max`, Compound: `${target} += limit < max`, Update: `${target}++` }[operator];
    const fast = grouping !== 'Comma' && ['Identifier', 'Member', 'Index'].includes(kind);
    compare(`/* 海 🧪 */ const prior = x > y; ${expression}; const later = a <= b;`, fast);
  });
}

test('explicit object remaps can assign dotted member paths', () => {
  compare('({ line: ast.loc.line, column: ast.loc.column } = read(age < limit));', true);
  compare('({ line: ast?.loc.line } = read(age < limit));', false);
  compare('({ ast.loc } = read(age < limit));', false);
});
