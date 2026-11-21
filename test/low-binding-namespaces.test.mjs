import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const types = { Alias: 'export type Signal = number;', Interface: 'export interface Signal { value: number }' };
const values = {
  Const: 'export const Signal = size < bound;',
  Pattern: 'export const { contents: [Signal] } = build(size <= bound);',
  Function: 'export function Signal() { return size > bound; }',
};
const rows = readFileSync(new URL('../verification/pict/low-binding-namespaces.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [type, value, order, suffix] = row.split('\t');
  test(`Low* module namespaces: ${type} ${value} ${order} ${suffix}`, () => {
    const pair = order === 'TypeFirst' ? [types[type], values[value]] : [values[value], types[type]];
    const source = pair.join('\n') + (suffix === 'Invalid' ? '\nconst =' : '\nconst last = n >= max;');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('existing duplicate checks apply when binding namespaces overlap', () => {
  compare('type Signal = number; export default function Signal() { return a < b; }', 'fast');
  compare('interface Signal {} declare const Signal: Signal; const ok = x < y;', 'fast');
  compare('type Signal = number; type Signal = string; const ok = a < b;', 'diagnostic');
  compare('type Signal = number; let Signal = x < y; function Signal() {}', 'diagnostic');
  compare('import { Signal } from "lib"; const { Signal } = values; const ok = a < b;', 'fallback');
  compare('import type { Signal } from "lib"; const Signal = a < b;');
  compare('function ready() { const { Value, nested: { Value } } = values; return a < b; }', 'diagnostic');
});
