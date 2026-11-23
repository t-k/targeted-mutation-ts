import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-native-parameter-property.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const parameters = {
  Required: ['public value: number', [42]],
  Optional: ['protected value?: number', []],
  Default: ['private readonly value: number = 42', []],
};
const boundaries = { Semicolon: '; this.log.push(this.value);', Newline: '\nthis.log.push(this.value);', ClosingBrace: '' };

async function instantiate(result, parameters, name = 'Value') {
  assert.equal(result.backend, 'pulse');
  assert.deepEqual(result.diagnostics, []);
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  return new module[name](...parameters);
}

for (const row of rows) {
  test('native parameter property ' + row.replaceAll('\t', ' '), async () => {
    const [constructor, form, boundary] = row.split('\t');
    const [parameter, args] = parameters[form];
    const derived = constructor === 'Derived';
    const base = derived ? 'class Base { log = [1]; constructor(value) { this.log.push(value); } }\n' : '';
    const fields = derived ? 'seen = this.log.push(3);' : 'log = []; seen = this.log.push(3);';
    const body = (derived ? 'super(2)' : 'this.log.push(2)') + boundaries[boundary];
    const source = base + 'export class Value' + (derived ? ' extends Base' : '') +
      ' { ' + fields + '\nconstructor(' + parameter + ') { ' + body + ' } }';
    const value = await instantiate(compile(source), args);
    const assigned = form === 'Optional' ? undefined : 42;
    assert.equal(value.value, assigned);
    assert.equal(value.seen, derived ? 3 : 1);
    assert.deepEqual(value.log, [...(derived ? [1, 2, 3] : [3, 2]), ...(boundary === 'ClosingBrace' ? [] : [assigned])]);
    assert.deepEqual(Object.keys(value), derived ? ['log', 'value', 'seen'] : ['value', 'log', 'seen']);
  });
}

test('multiple parameter properties and nested class bodies keep their own insertion ranges', async () => {
  const source = 'export class Value {\n' +
    '  constructor(public first: number, private second: number) {\n' +
    '    class Nested { constructor(readonly inner: number) {} }\n' +
    '    this.nested = new Nested(second);\n  }\n}';
  const value = await instantiate(compile(source), [41, 42]);
  assert.deepEqual(Object.keys(value), ['first', 'second', 'nested']);
  assert.deepEqual(Object.keys(value.nested), ['inner']);
  assert.equal(value.nested.inner, 42);
});

test('a directive or an extending expression leaves constructor emission to compatibility', () => {
  const directive = 'export class Value { constructor(public value: number) { "custom"; } }';
  assert.notEqual(compile(directive).backend, 'pulse');
  for (const input of [
    'class Base {} export class Value extends Base { constructor(public value: number) { super().value; } }',
    'class Base {} export class Value extends Base { constructor(public value: number) { if (value) super(); else super(); } }',
    'class Base {} export class Value extends Base { constructor(public value: number) { super() as unknown; } }',
    'class Base {} export class Value extends Base { constructor(public value: number) { super() satisfies unknown; } }',
    'class Base {} export class Value extends Base { constructor(public value: number) { super()!; } }',
  ]) {
    const result = compile(input);
    const reference = compile(input, { sourceMap: true });
    assert.equal(result.backend, 'typescript', input);
    assert.equal(result.code.trim(), reference.code.trim(), input);
  }
});
