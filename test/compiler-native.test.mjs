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
  Multiple: 'export const value: number = 42;\nexport const high = (x: number): boolean => x >= value;',
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
      assert.equal(result.backend, 'pulse');
      if (shape === 'TypeModule' && layout !== 'Compact') {
        assert.ok(result.code.startsWith(layouts[layout]));
        assert.doesNotMatch(result.code, /interface|import|export type/);
      } else assert.equal(result.code, shape === 'TypeModule' ? '' : stripTypeScriptTypes(source));
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
  const mapped = compile(input, { sourceMap: true });
  assert.equal(mapped.backend, 'pulse');
  assert.equal(mapped.code, fast.code);
  // A target that knows every form of the source takes the same route.
  const portable = compile(input, { target: 'es2022' });
  assert.equal(portable.backend, 'pulse');
  assert.equal(portable.code, fast.code);
  const lowered = compile(input + '\nexport class Holder { value = 1; }', { target: 'es2021' });
  assert.equal(lowered.backend, 'typescript');
  await assertModule(lowered.code);
});

test('native grammar declines module and syntax hazards', () => {
  for (const input of [
    'export const eval: number = 42;',
    'export const value = (await: number) => await;',
    'export const value: number = 042;',
    'export const value = (x: number)\r\n=> x;',
    'export const value = (x: number): number\u2028=> x;',
    'export const value = (x: number) => x;\0',
  ]) {
    assert.notEqual(compile(input).backend, 'pulse', JSON.stringify(input));
  }
  assert.notEqual(compile(forms.Arrow, { file: 'source.cts' }).backend, 'pulse');
  assert.equal(compile(forms.Arrow, { target: 'es2018' }).backend, 'pulse');
  assert.equal(compile(forms.Arrow + '\nexport const next = value ?? 1;', { target: 'es2018' }).backend, 'pulse');
  assert.notEqual(compile(forms.Arrow + '\nexport const next = value(1) ?? 1;', { target: 'es2018' }).backend, 'pulse');
});

test('the module emitter erases comments inside a delimited arrow parameter annotation', async () => {
  const source = 'export const value = (x: /* type comment */ number) => x;';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.doesNotMatch(result.code, /type comment|number/);
  const { value } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(value(42), 42);
});

test('multi-declaration erasure checks syntax and duplicate names before publishing', () => {
  const first = 'export const x: number = 1;';
  const second = '/* 日本語🧪 */\r\nexport const y = (a: number): boolean => a >= x;';
  const input = first + second;
  for (const mode of ['transform', 'strip']) {
    const result = compile(input, { mode });
    assert.equal(result.backend, 'pulse');
    assert.equal(result.code, stripTypeScriptTypes(input));
  }
  for (const source of [
    first + 'export const x: number = 2;',
    first + second + 'export const bad =',
    first.slice(0, -1) + ' export const y: number = 2;',
  ]) assert.notEqual(compile(source).backend, 'pulse', source);
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
  const withValue = compile(source + '\nexport const live = true;');
  const live = await import('data:text/javascript;base64,' + Buffer.from(withValue.code).toString('base64'));
  assert.equal(live.live, true);
  assert.match(compile(source + '\nimport "side-effect";').code, /import "side-effect";/);
  assert.match(compile(source + '\nimport type from "runtime";').code, /import type from "runtime";/);
  for (const suffix of ['\nexport type Missing =', '\nexport type Keys = Item;']) {
    assert.notEqual(compile(source + suffix).backend, 'pulse', suffix);
  }
});

test('type-only files preserve comments without TypeScript', () => {
  const source = '#!/usr/bin/env node\r\n/* 東京 */\nexport type Coordinate = number;\n/*! Copyright Example */\n';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  // The interpreter line is written with a line feed, as TypeScript writes it; strip mode keeps every position.
  assert.equal(result.code, '#!/usr/bin/env node\n/* 東京 */\n\n/*! Copyright Example */\n');
  assert.equal(compile(source, { mode: 'strip' }).code, stripTypeScriptTypes(source));
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
