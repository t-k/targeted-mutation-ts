import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-ambient-heritage.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [ambient, heritage, dialect] = row.split('\t');
  test('native ambient and class heritage ' + row.replaceAll('\t', ' '), async () => {
    const declaration = ambient === 'Class' ? 'declare class Unavailable<T> { flag: T }' :
      `declare ${ambient.toLowerCase()} Unavailable: number;`;
    const types = 'interface Shape { value: number }\n' +
      'interface BaseShape<T> { read(): T }\n';
    const clause = {
      Single: 'implements Shape',
      Multiple: 'implements\n Shape, BaseShape<number>',
      Derived: 'extends Base<number> implements Shape, BaseShape<number>',
    }[heritage];
    const base = 'class Base<T> { base: T | undefined; }\n';
    const value = `export class Value ${clause} { value = 42; read() { return this.value; } }\n`;
    const view = dialect === 'TS' ? '' :
      'const React = { createElement: (_tag, _props, child) => child };\n' +
      'export const view = () => <b>{new Value().read()}</b>;';
    const source = declaration + '\n' + types + base + value + view;
    const result = compile(source, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx', jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /Unavailable|implements|Base<number>/);
    const output = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    const instance = new output.Value();
    assert.equal(instance.read(), 42);
    assert.equal('base' in instance, heritage === 'Derived');
    if (output.view) assert.equal(output.view(), 42);
  });
}

test('an incomplete implements clause cannot produce native JavaScript', () => {
  const result = compile('export class Value implements { value = 42; }');
  assert.notEqual(result.backend, 'pulse');
  assert.equal(result.code, null);
});

test('erasing an ambient export follows the requested module format', () => {
  const source = 'export declare const unused: number;\nexport type T = number;\nconst result = this;';
  for (const module of ['preserve', 'esm']) {
    const actual = compile(source, { module });
    const reference = compile(source, { module, sourceMap: true });
    assert.equal(actual.backend, 'pulse');
    assert.equal(actual.code.trim(), reference.code.trim());
  }
});
