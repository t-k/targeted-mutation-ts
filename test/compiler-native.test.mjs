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
      assert.equal(result.code, stripTypeScriptTypes(source));
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
