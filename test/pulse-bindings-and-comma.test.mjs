import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'bindings.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-bindings-and-comma.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [key, comma, scope] = row.split('\t');
  test(`Pulse binding and comma statement: ${key} ${comma} ${scope}`, () => {
    const binding = {
      Direct: '[symbol]: item', Qualified: '[Symbol.iterator]: item', Literal: '"constant": item',
      Bad: '[a > b]: item', MissingColon: '[symbol]',
    }[key];
    const expr = {
      Plain: 'left = a >= b, right = c > d;', Grouped: '(left = a < b), (right = c <= d);',
      Ambiguous: 'left = a < b, right > (d);', MissingOperand: 'left = a >= b,;',
    }[comma];
    const body = `/* 🧪 海 */ const { ${binding}, ...rest } = values; ${expr}`;
    const source = scope === 'Block' ? `function run() { ${body} }` : body;
    compare(source, !['Bad', 'MissingColon'].includes(key) && !['Ambiguous', 'MissingOperand'].includes(comma));
  });
}

test('computed property names do not register bindings but normal targets still do', () => {
  compare('const key = a < b; const { [key]: entry = (c < d) } = input;', true);
  compare('const key = a < b; const { [key]: key } = input;', false);
});

test('a comma statement still respects ASI and a following statement', () => {
  compare('const k = 0; (left = a < b), (right = c <= d)\n; next >= 0;', true);
  compare('(left = a < b), (right = c <= d); const =', false);
});

test('computed keys retain the field initializer arguments restriction', () => {
  compare('class C { field = ({[arguments]: x}) => x < 2; }', false);
  compare('class C { field = () => { const {[arguments.x]: x} = obj; return x < 2; }; }', false);
  compare('class C { field = class { [arguments.x]() { return x < 2; } }; }', false);
  compare('class C { field = ({[obj.arguments]: x}) => x < 2; }', true);
  compare('class C { field = class { [obj.arguments]() { return x < 2; } }; }', true);
  compare('function run() { const {[arguments.x]: x} = obj; return x < 2; }', true);
});
