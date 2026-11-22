import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { compile } from '../src/compiler.mjs';

const forms = {
  Literal: 'export const value: number = 42;',
  Arrow: 'export const value = (x: number) => x >= 18;',
  Return: 'export const value = (x: number): boolean => x > 17;',
  TypeModule: 'import type { T } from "package";\nexport interface Box { value: T }\nexport type Value = Box["value"];',
};
const layouts = { Compact: '', CRLF: '// eol\r\n', UTF8: '/* 東京🧪 */\n' };
const rows = readFileSync(new URL('../verification/pict/compiler-native.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [shape, layout, tail] = row.split('\t');
  test(`native compiler: ${row.replaceAll('\t', ' ')}`, () => {
    const source = layouts[layout] + forms[shape] + (tail === 'Clean' ? '' : ' const broken =');
    const input = Buffer.from(source);
    const result = compile(input);
    assert.equal(input.toString(), source);
    if (tail === 'Malformed') {
      assert.equal(result.code, null);
      assert.equal(result.backend, 'typescript');
    } else {
      const emitsComments = shape === 'TypeModule' && layout !== 'Compact';
      assert.equal(result.backend, emitsComments ? 'typescript' : 'pulse');
      assert.equal(result.code, shape === 'TypeModule' ? '' : stripTypeScriptTypes(source));
      assert.deepEqual(result.diagnostics, []);
    }
  });
}

test('native code preserves runtime behavior and strip-mode output', async () => {
  const input = 'export const predicate: any = (age: number): boolean => age >= 18';
  const fast = compile(input);
  assert.equal(fast.backend, 'pulse');
  assert.equal(fast.code, compile(input, { mode: 'strip' }).code);
  const assertModule = async (code) => {
    const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    assert.deepEqual([17, 18, 20].map(module.predicate), [false, true, true]);
  };
  await assertModule(fast.code);
  const portable = compile(input, { sourceMap: true });
  assert.equal(portable.backend, 'typescript');
  await assertModule(portable.code);
});

test('native grammar declines module and syntax hazards', () => {
  for (const input of [
    'export const eval: number = 42;',
    'export const value = (await: number) => await;',
    'export const value: number = 042;',
    'export const value = (x: number)\r\n=> x;',
    'export const value = (x: number): number\u2028=> x;',
    'export const value = (x: /*keep*/ number) => x;',
    'export const value = (x: number) => x;\0',
    'export const value = (x: number) => Math.max(x, 1);',
    'export const value = (x: number) => x; export const extra = 2;',
  ]) {
    assert.notEqual(compile(input).backend, 'pulse', JSON.stringify(input));
  }
  assert.notEqual(compile(forms.Arrow, { file: 'source.cts' }).backend, 'pulse');
  assert.notEqual(compile(forms.Arrow, { file: 'source.tsx' }).backend, 'pulse');
  assert.notEqual(compile(forms.Arrow, { target: 'es2018' }).backend, 'pulse');
});

test('native erasure defers for a TypeScript directive or tab inside a type span', () => {
  const badDirective = '/* header */\n/// <reference />\nexport const f: number = 42;';
  const result = compile(badDirective);
  assert.equal(result.code, null);
  assert.equal(result.backend, 'typescript');
  assert.equal(result.diagnostics[0].code, 1084);
  for (const source of ['export const f:\tnumber = 42;',
    'export const f = (x:\tnumber) => x;', 'export const f = (x: number):\tboolean => x > 0;']) {
    assert.equal(compile(source, { mode: 'strip' }).code, stripTypeScriptTypes(source));
  }
});

test('the compiler accepts shared input views from another realm', () => {
  const source = forms.Arrow;
  const shared = vm.runInNewContext(`new SharedArrayBuffer(${Buffer.byteLength(source)})`);
  Buffer.from(shared).write(source);
  const sharedSource = Buffer.from(shared);
  const result = compile(sharedSource);
  assert.equal(result.code, stripTypeScriptTypes(source));
  assert.equal(sharedSource.toString(), source);
});

test('native compilation erases complete type-only modules and preserves ESM', async () => {
  const source = 'import type { Item } from "unavailable";\n' +
    'interface Box<T> { value: T }\nexport interface Row extends Box<Item> {}\nexport type Keys = keyof Row;';
  const result = compile(source, { module: 'esm' });
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code, 'export {};\n');
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.deepEqual(Object.keys(module), []);
  assert.equal(compile(source, { mode: 'strip' }).code, stripTypeScriptTypes(source));
  for (const suffix of [
    '\nexport const live = true;', '\nimport "side-effect";', '\nimport type from "runtime";',
    '\nexport type Missing =', '\nexport type Keys = Item;',
  ]) {
    assert.notEqual(compile(source + suffix).backend, 'pulse', suffix);
  }
});

test('type-only files with comments use the comment-aware compatibility emitter', () => {
  const source = 'export type Coordinate = number;\n/*! Copyright Example */\n';
  const result = compile(source);
  assert.equal(result.backend, 'typescript');
  assert.match(result.code, /Copyright Example/);
});

test('generated annotation layouts preserve the exact stripped source', () => {
  const types = ['number', 'string', 'boolean', 'bigint', 'unknown', 'never', 'any', 'object'];
  const operators = ['<', '<=', '>', '>='];
  const layouts = ['', '/* module */\r\n', '// module\n'];
  for (const [typeIndex, type] of types.entries()) {
    for (const [operatorIndex, operator] of operators.entries()) {
      for (const [layout, prefix] of layouts.entries()) {
        const position = typeIndex * operators.length + operatorIndex;
        const parameter = `value${position}`;
        const inside = ' '.repeat(layout + 1);
        const annotation = layout === 0 ? '' : `: ${type}`;
        const source = `${prefix}export\tconst candidate${annotation} = (${parameter}: ${type})${layout === 1 ? ': boolean' : ''} => ${parameter}${inside}${operator}${inside}${position};\n`;
        const result = compile(source);
        assert.equal(result.backend, 'pulse', source);
        assert.equal(result.code, stripTypeScriptTypes(source), source);
      }
    }
  }
});
