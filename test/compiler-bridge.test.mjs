import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const samples = {
  Module: 'import type { Input } from "fixture"; export function pick(input: Input): number { const a: number = input.value; return a; }',
  Script: '// export const marker = 0\nconst local: number = 1; function run() { return this; }',
  Invalid: 'export function pick(x: number, x: number) { return x; } export const broken =',
  Empty: '#!/usr/bin/env node\n/* license */\nimport type { Input } from "unused";\nexport interface Box { input: Input; }',
  Runtime: 'export enum Mode { Ready = read() } export const next = Mode.Ready;',
};
const rows = readFileSync(new URL('../verification/pict/compiler-bridge.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [source, target, map] = row.split('\t');
  test('native erasure bridge ' + row.replaceAll('\t', ' '), async () => {
    const input = samples[source];
    const result = compile(input, { target: target === 'Modern' ? 'esnext' : 'es2018', sourceMap: map === 'On' });
    const bridged = (source === 'Module' || source === 'Empty') && target === 'Modern' && map === 'Off';
    assert.equal(result.backend, bridged ? 'node-strip' : 'typescript');
    if (source === 'Invalid') assert.equal(result.code, null);
    if (bridged && source === 'Module') {
      const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(module.pick({ value: 42 }), 42);
    }
    if (bridged && source === 'Empty') assert.match(result.code, /^#!.*\n\/\* license \*\//);
    if (source === 'Script') assert.match(result.code, /"use strict"/);
  });
}

test('erasure needs an original ESM declaration and a surviving ESM marker', () => {
  for (const source of [
    'import type { X } from "fixture";\nconst local: number = 42;\nconsole.log(local);',
    '"export const x = 1";\nconst local: number = 1;',
    'import("fixture"); const local: number = 1;',
    'import.meta.url; const local: number = 1;',
    '/// <reference />\nexport const value: Set<number> = new Set();',
  ]) assert.notEqual(compile(source).backend, 'node-strip', source);
});

test('later module markers survive erasure and runtime text is not a triple-slash directive', async () => {
  const source = 'import type { X } from "fixture";\nconst prefix: string = "a:///b";\n' +
    'export function read(_value: X): string { return prefix; }';
  const lowered = compile(source);
  assert.equal(lowered.backend, 'node-strip');
  const module = await import('data:text/javascript;base64,' + Buffer.from(lowered.code).toString('base64'));
  assert.equal(module.read(null), 'a:///b');
});

test('a hashbang can precede a later module marker', () => {
  const result = compile('#!/usr/bin/env node\nconst value: number = 1;\nexport function read() { return value; }');
  assert.equal(result.backend, 'node-strip');
  assert.match(result.code, /^#!\/usr\/bin\/env node/);
});

test('parameter properties can lower without TypeScript while preserving constructor order', async () => {
  const source = [
    'const log: string[] = [];',
    'class Base { constructor() { log.push("base"); } }',
    'export class Widget extends Base {',
    '  observed = log.push("field");',
    '  constructor(public value: number) { super(); log.push("body"); }',
    '}',
    'export function read() { return log.slice(); }',
  ].join('\n');
  const result = compile(source);
  if (Number(process.versions.node.split('.')[0]) <= 25) assert.equal(result.backend, 'node-transform');
  const baseline = compile(source, { sourceMap: true });
  for (const code of [result.code, baseline.code]) {
    const m = await import('data:text/javascript;base64,' + Buffer.from(code + (code === result.code ? '\n// first' : '\n// second')).toString('base64'));
    const instance = new m.Widget(42);
    assert.equal(instance.value, 42);
    assert.equal(instance.observed, 2);
    assert.deepEqual(m.read(), ['base', 'field', 'body']);
  }
});


test('a fully erased module retains an explicit ESM marker and its comments', async () => {
  const result = compile(samples.Empty.replace(/^#!.*\n/, ''), { file: 'input.mts' });
  assert.equal(result.backend, 'node-strip');
  assert.match(result.code, /\/\* license \*\//);
  assert.match(result.code, /export \{\};\n$/);
  const empty = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.deepEqual(Object.keys(empty), []);
});
