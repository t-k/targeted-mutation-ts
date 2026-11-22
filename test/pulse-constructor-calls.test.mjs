import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'constructors.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-constructor-calls.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [target, arguments_, tail] = row.split('\t');
  test(`Pulse constructor call: ${target} ${arguments_} ${tail}`, () => {
    const callee = {
      Name: 'Constructor', This: 'this', Parenthesized: '(a >= b ? A : B)',
      Class: '(class { check() { return c <= d; } })',
    }[target];
    const params = { Empty: '', Less: 'n < m', Trailing: 'n < m,', Hole: 'n < m,,' }[arguments_];
    const source = `/* 🧪 海 */ const item = new ${callee}(${params})` +
      (tail === 'Comparison' ? ' < bound;' : tail === 'Standalone' ? ';' : '; const =');
    compare(source, tail !== 'Broken' && arguments_ !== 'Hole');
  });
}

test('a direct call with a trailing comma delimits a less-than comparison or arrow body', () => {
  compare('invoke(age < limit,); invoke(value => value < limit,);', true);
  compare('invoke(age < limit, lower > (mode));', false);
  compare('invoke(age < limit,,);', false);
});

test('incomplete constructor operands and optional chains keep their existing diagnostics', () => {
  compare('const item = new (Constructor) < bound;', false);
  compare('const item = new (age < bound, Constructor)();', false);
  compare('const item = new this?.Constructor();', false);
});
