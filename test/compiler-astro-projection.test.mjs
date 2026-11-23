import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const records = readFileSync(new URL('../verification/pict/compiler-astro-projection.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const inputs = {
  Shift: ['const offset = 1', 'const mask = ((1 << 2) - 1) << (8 - offset - 4)', 'export const value = mask >> 1;'],
  ShiftTrivia: ['const offset = 1', 'const mask = 3 << /* bits */ (8 - offset - 4)', 'export const value = mask >> 1;'],
  Generic: ['function identity<T>(value: T) { return value; }',
    'export const value = identity<<T>(x: T) => T>(x => x)(12);'],
  SpacedAngles: ['const a = 1;', 'const b = 2;', 'export const value = a < <(number)>b;'],
  EnumProperty: ['const api = { enum: values => values.length };', 'export const value = api.enum(["a", "b"]);'],
  EnumLexicalRegions: ['const template = `enum << (word)`;', 'const regex = /<< \\(/;',
    'const api = { enum: text => Number(regex.test(text)) };', 'export const value = api.enum(template);'],
  RuntimeEnum: ['export enum Flag { Off = 0, On }', 'export const value = Flag.On;'],
  ComputedEnum: ['function next() { return 9; }', 'export enum Flag { On = next() }', 'export const value = Flag.On;'],
  InvalidEnum: ['export enum Flag { On = }'],
};
const expected = { Shift: 12, ShiftTrivia: 12, Generic: 12, SpacedAngles: true, EnumProperty: 2,
  EnumLexicalRegions: 1, RuntimeEnum: 1, ComputedEnum: 9 };
const unchanged = new Set(['Shift', 'ShiftTrivia', 'EnumProperty', 'EnumLexicalRegions']);

for (const row of records) {
  test('compiler projection ' + row.replaceAll('\t', ' '), async () => {
    const [construct, lineBreak, representation] = row.split('\t');
    const source = inputs[construct].join(lineBreak === 'CRLF' ? '\r\n' : '\n');
    const input = representation === 'Bytes' ? Buffer.from(source) : source;
    const result = compile(input, { file: 'input.ts', module: 'esm' });
    if (construct === 'InvalidEnum') {
      assert.equal(result.code, null);
      assert.ok(result.diagnostics.some(item => item.severity === 'error'));
      return;
    }
    if (unchanged.has(construct) || construct === 'RuntimeEnum') {
      assert.equal(result.backend, 'pulse');
    }
    if (unchanged.has(construct)) assert.equal(result.code, source);
    assert.deepEqual(result.diagnostics, []);
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(module.value, expected[construct]);
  });
}
