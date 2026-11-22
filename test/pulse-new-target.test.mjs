import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'metadata.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-new-target.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [context, form, tail] = row.split('\t');
  test(`Pulse new.target: ${context} ${form} ${tail}`, () => {
    const value = {
      Direct: 'new.target ? a >= b : c < d', Member: 'new /* note */ . target.name.length > n',
      Assignment: 'new.target = next', Spelling: 'new.targeted',
    }[form];
    const text = {
      Top: `const result = ${value};`, TopArrow: `const run = () => ${value};`,
      Function: `function run() { return ${value}; }`,
      NestedArrow: `function run() { return () => ${value}; }`,
      Method: `class Runner { run() { return ${value}; } }`, Field: `class Runner { value = ${value}; }`,
    }[context];
    const source = `/* 🧪 海 */ ${text} const keep = score < limit;` + (tail === 'Broken' ? ' const =' : '');
    const fast = tail === 'Complete' && !context.startsWith('Top') && ['Direct', 'Member'].includes(form);
    compare(source, fast);
  });
}

test('parameter defaults get the function context and the caller keeps its own', () => {
  compare('function run(ctor = new.target) { return ctor >= limit; }', true);
  compare('function run() { return new.target; } const keep = new.target > x;', false);
  compare('class Derived extends Base { run() { return function f() { return super.count > limit; }; } }', false);
  compare('class Derived extends Base { run() { return () => super.count > limit; } }', true);
});
