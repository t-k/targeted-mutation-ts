import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-unicode-erasure.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [scalar, line, placement, dialect] = row.split('\t');
  test('Unicode in erased types ' + row.replaceAll('\t', ' '), async () => {
    const value = { TwoByte: 'é', ThreeByte: '日本', FourByte: '😀' }[scalar];
    const separator = { LF: '\n', CRLF: '\r\n', LineSeparator: '\u2028', ParagraphSeparator: '\u2029' }[line];
    const marker = 'export const before = 1;\n';
    const type = 'type Thing = { /* ' + 'a'.repeat(17) + value + separator + value + ' */ a: number };\n';
    const declaration = placement === 'BeforeExport' ? type + marker : placement === 'AfterExport' ? marker + type : marker;
    const valueFunction = 'export function answer() { ' + (placement === 'Function' ? type : '') + 'return 42; }\n';
    const jsx = dialect === 'TSX' ? 'export const view = () => <i>retained</i>;\n' : '';
    const source = declaration + valueFunction;
    const emitted = compile(source + jsx, { file: 'unicode.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(emitted.backend, 'pulse', source);
    assert.equal(emitted.code.indexOf('return 42'), source.indexOf('return 42'));
    assert.equal(Buffer.from(emitted.code).indexOf('return 42'), Buffer.from(source).indexOf('return 42'));
    assert.deepEqual(emitted.code.match(/\r\n|[\n\u2028\u2029]/g), (source + jsx).match(/\r\n|[\n\u2028\u2029]/g));
    if (dialect === 'TS' && placement === 'BeforeExport') assert.equal(emitted.code, stripTypeScriptTypes(source));
    const { answer } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
    assert.equal(answer(), 42);
  });
}

test('invalid UTF-8 in a type declaration still reports an encoding error', () => {
  const source = Buffer.concat([Buffer.from('type R = /* '), Buffer.from([0xf0, 0x80, 0x80, 0x80]),
    Buffer.from(' */ number; export const value = 1;')]);
  const emitted = compile(source);
  assert.equal(emitted.code, null);
  assert.equal(emitted.diagnostics[0].code, 'INVALID_ENCODING');
});

test('classic JSX finds a retained module marker after an erased Unicode prefix', () => {
  for (const prefix of ['export type T = /* é😀 */ number;', 'import type { T } from /* æ */ "./types";']) {
    const options = { file: 'unicode.tsx', jsx: 'classic' };
    const emitted = compile(prefix + '\nexport const view = <i/>;', options);
    assert.equal(emitted.backend, 'pulse');
    assert.match(emitted.code, /export const view = React\.createElement/);
    assert.doesNotMatch(emitted.code, /export type|import type/);
    const script = compile(prefix + '\nconst view = <i/>;', options);
    assert.notEqual(script.backend, 'pulse');
    assert.doesNotMatch(script.code, /export type|import type/);
  }
});

test('explicit ESM keeps exactly the surviving Unicode-module markers', () => {
  const prefix = 'export type T = /* é😀 */ number;\n';
  const retained = prefix + 'export const value = 42;';
  const preserve = compile(retained);
  const esm = compile(retained, { module: 'esm' });
  assert.equal(esm.backend, 'pulse');
  assert.equal(esm.code, preserve.code);
  const erased = compile(prefix + 'const value = 42;', { module: 'esm' });
  assert.equal(erased.backend, 'pulse');
  assert.match(erased.code, /export \{\};\n$/);
});

test('the copy spelled in ASCII is refused where a spelling could be mistaken', () => {
  const lowered = source => compile(Buffer.from('enum E { A }\n' + source), { file: 'names.ts' });
  // A plain word of the source that equals a spelling (é is spelled NN), and two words with one spelling.
  for (const source of ['export const é: number = E.A; export const NN: number = 2;', 'export const é: number = E.A, Ï: number = 2;']) {
    const result = lowered(source);
    assert.notEqual(result.backend, 'pulse', source);
    assert.match(result.code, /const é = E\.A/);
  }
  assert.match(lowered('export const é: number = E.A; export const NN: number = 2;').code, /const NN = 2/);
  // A word that is no identifier, and a number that a spelling would complete (Ђ is spelled AA).
  for (const source of ['export const → = E.A;', 'export const n: number = 0xЂ + E.A;']) {
    const result = lowered(source);
    assert.notEqual(result.backend, 'pulse', source);
    assert.notEqual(result.diagnostics.length, 0, source);
  }
  assert.notEqual(compile(Buffer.from('export const n: number = 0xЂ;'), { file: 'names.ts' }).backend, 'pulse');
  // A lowered file puts names back word by word, and leaves a word like a derived name alone.
  const kept = lowered('export const é: number = E.A; export const s: string = "NN_1";');
  assert.equal(kept.backend, 'pulse');
  assert.match(kept.code, /const é\s+= E\.A; export const s\s+= "NN_1";/);
});
