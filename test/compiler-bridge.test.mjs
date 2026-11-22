import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const samples = {
  Module: 'import type { Input } from "fixture"; export function pick(input: Input): number { const a: number = input.value; return a; }',
  Script: '// export const marker = 0\nconst local: number = 1; function run() { return this; }',
  Invalid: 'export function pick(x: number, x: number) { return x; } export const broken =',
  Runtime: 'export enum Mode { Ready = read() } export const next = Mode.Ready;',
};
const rows = readFileSync(new URL('../verification/pict/compiler-bridge.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [source, target, map] = row.split('\t');
  test('native erasure bridge ' + row.replaceAll('\t', ' '), async () => {
    const input = samples[source];
    const result = compile(input, { target: target === 'Modern' ? 'esnext' : 'es2018', sourceMap: map === 'On' });
    const bridged = source === 'Module' && target === 'Modern' && map === 'Off';
    assert.equal(result.backend, bridged ? 'node-strip' : 'typescript');
    if (source === 'Invalid') assert.equal(result.code, null);
    if (bridged) {
      const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(module.pick({ value: 42 }), 42);
    }
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
