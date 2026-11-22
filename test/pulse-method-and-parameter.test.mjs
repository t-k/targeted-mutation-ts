import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'method.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-method-and-parameter.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [modifier, key, tail] = row.split('\t');
  test(`Pulse computed class method: ${modifier} ${key} ${tail}`, () => {
    const prefix = { None: '', Static: 'static ', Async: 'async ', Generator: '*', Getter: 'get ' }[modifier];
    const name = { Identifier: '[identifier]', Qualified: '[Symbol.iterator]', BadExpression: '[a >= b]', MissingBracket: '[a' }[key];
    const end = tail === 'Field' ? ' = true;' : '() { return a > b; }';
    const source = `/* 海 🧪 */ export class Model { ${prefix}${name}${end} }${tail === 'Broken' ? '\nconst =' : ''}`;
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    const fast = tail === 'Method' && (key === 'Identifier' || key === 'Qualified');
    assert.equal(result.path === 'fast', fast, source);
  });
}

test('computed names do not form a constructor or named signature overload', () => {
  const source = 'class Model { [constructor]() { return a >= b; } [prototype]() { return c <= d; } }';
  const result = extract(source, options);
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, extractFallback(source, options).candidates);
  assert.notEqual(extract('class Model { [name](): boolean; [name]() { return a >= b; } }', options).path, 'fast');
});

for (const [name, form] of [
  ['arrow', params => `const check = (${params}) => age >= limit;`],
  ['function', params => `function check(${params}) { return age >= limit; }`],
]) {
  for (const [parameter, accepted] of [
    ['age: number, extra?', true], ['age: number, extra?,', true],
    ['age: number, extra?/* ゼロ */: string', true], ['age: number, extra? = fallback', false],
    ['age: number, { extra }?', false], ['age: number, extra??', false],
  ]) {
    test(`Pulse ${name} parameters: ${parameter}`, () => {
      const source = form(parameter);
      const result = extract(source, options);
      const reference = extractFallback(source, options);
      assert.deepEqual(result.candidates, reference.candidates);
      assert.deepEqual(result.diagnostics, reference.diagnostics);
      assert.equal(result.path === 'fast', accepted);
    });
  }
}
