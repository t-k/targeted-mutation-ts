import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-late-export-type.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

function load(code) {
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

for (const row of rows) {
  const [prefix, statement, dialect] = row.split('\t');
  test('late type erasure after a retained declaration ' + row.replaceAll('\t', ' '), async () => {
    const exports = {
      Const: 'export const metadata = { value: 42 };',
      TwoConst: 'export const helper = true;\nexport const metadata = { value: 42 };',
      Let: 'export let metadata = { value: 42 };',
      Var: 'export var metadata = { value: 42 };',
      Function: 'export function metadata() { return { value: 42 }; }',
      Class: 'export class metadata { value = 42; }',
    };
    const types = {
      Interface: 'interface Shape { value: number }',
      Alias: 'type Shape = { value: number };',
      TypeExport: 'export type { Shape } from "pure-type-source";',
    };
    const value = 'const shape: Shape = ' + (prefix === 'Function' ? 'metadata()' : prefix === 'Class' ? 'new metadata()' : 'metadata') + ';';
    const suffix = dialect === 'TS' ? 'export const view = shape.value;' :
      'const React = { createElement: (_tag, _props, child) => child };\nexport const view = <i>{shape.value}</i>;';
    const input = [exports[prefix], '// retain this comment', types[statement], value, suffix].join('\n');
    const result = compile(input, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx', jsx: 'classic' });
    assert.equal(result.backend, 'pulse', input);
    assert.match(result.code, /retain this comment/);
    assert.doesNotMatch(result.code, /pure-type-source|interface Shape|type Shape/);
    const output = await load(result.code);
    assert.equal(output.view, 42);
    const metadata = prefix === 'Function' ? output.metadata() : prefix === 'Class' ? new output.metadata() : output.metadata;
    assert.equal(metadata.value, 42);
  });
}

test('the contextual word type can be an object with a type property', async () => {
  const source = 'export function read(type: { type: number }) { return type.type; }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal((await load(result.code)).read({ type: 42 }), 42);
});

test('the separator survives an intervening expression before a late type statement', async () => {
  const source = 'export const events: number[] = [];\nconst value = (item: number) => events.push(item);\n' +
    'value // ;\ntype T = number\n(3);\nexport const count = events.length;';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { count, events } = await load(result.code);
  assert.equal(count, 0);
  assert.deepEqual(events, []);
});

test('a local lexical declaration protects a subsequent late type statement', async () => {
  const source = 'const events = [];\nevents.push(42);\ninterface T { type: number }\n' +
    'export const value: number = events[0];';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal((await load(result.code)).value, 42);
});

test('a late type in a possible directive prologue stays on compatibility', () => {
  const source = '"use client";\ntype T = number;\n"use server";\nexport const value: T = 42;';
  const result = compile(source);
  assert.notEqual(result.backend, 'pulse');
  assert.match(result.code, /^"use client";\s+"use server";/);
});
