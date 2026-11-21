import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const types = {
  Alias: 'export type Input = "short" | "long";',
  Interface: 'export interface Input { readonly path: string; ready?: boolean\n values: number[] }',
  Nested: 'export type Input = Box<Record<string, Config.Entry | undefined>> & { path?: string };',
  Tuple: 'export type Input = readonly [string, { count: number }];',
};
const expressions = {
  Optional: 'state?.values?.[index < end]?.(fallback).size > limit',
  Nullish: '(state?.size ?? 0) > limit && left < right',
  Spread: 'check(...[state, threshold], { ...settings, ready: total > 3 }) >= 0',
};
const rows = readFileSync(new URL('../verification/pict/low-typed.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [type, expression, suffix] = row.split('\t');
  test(`Low* typed syntax: ${type} ${expression} ${suffix}`, () => {
    const source = `${types[type]}\nexport function compute(value: Input): boolean { return ${expressions[expression]}; }` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('typed declarations and coalescing during value parsing keep oracle diagnostics', () => {
  for (const source of [
    'export type Input = { width: }; const value = a < b;',
    'export interface Input { name: string size: number } const x = a < b;',
    'interface\nInput {} const x = a < b;',
    'interface /*\n*/ Input {} const x = a < b;',
    'type Input = string; type Input = number; const value = a < b;',
    'const x = a ?? b || c > d;',
    'const x = a && b ?? c > d;',
    'const x = (a > b) ?? (c > d && ready);',
    'const x = x?.method?.(...values, left < right);',
    'type T = readonly string; const x = a < b;',
    'type T = Box<number[]>; const x = check > 0;',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    if (source.includes('readonly string;')) assert.notEqual(result.path, 'fast', source);
  }
});
