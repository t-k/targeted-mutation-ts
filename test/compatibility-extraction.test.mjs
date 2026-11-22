import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

test('the ordinary addon has no external native parser', () => {
  const load = createRequire(import.meta.url);
  const addon = load('../build/tmt.node');
  assert.equal(addon.syntax, undefined);
  assert.equal(addon.standalone, undefined);
  const source = 'const result = run <number>() < limit;';
  const actual = extract(source, { requireNative: true });
  assert.equal(actual.path, 'fallback');
  assert.deepEqual(actual.candidates, extractFallback(source).candidates);
});

const inputs = {
  Plain: 'function ready(state: { count: number }) { if (ready <number>(state.count /* > */) >= 3) return true; }',
  Nested: 'const name = "🧪"; const fit = (a < b) <= (c > d); namespace Model { export type Name = string; }',
  Logical: 'const label = "🐈"; export const view = <button disabled={saving || (!valid)}>{label}</button>;',
  None: 'const label = join <string>("no comparison"); label.trim();',
};
const rows = readFileSync(new URL('../verification/pict/broad-native.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [dialect, mode, candidate, validity] = row.split('\t');
  test(`compatibility fallback: ${dialect} ${mode} ${candidate} ${validity}`, () => {
    const source = Buffer.from(inputs[candidate] + {
      Valid: '', Syntax: '\nconst =', Semantic: '\nconst checked = 1; let checked = 2;',
    }[validity]);
    const options = { dialect: dialect.toLowerCase(), mode: mode.toLowerCase(), logical: true, requireNative: true };
    const reference = extractFallback(source, options);
    const result = extract(source, options);
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
    assert.equal(result.path, reference.path);
  });
}

test('module early errors keep exact fallback diagnostics and discard candidate prefixes', () => {
  for (const suffix of [
    'function bad(eval: number) {}',
    'function bad() { import "late"; }',
    'export { missing };',
    'let value = 010;',
    'let value = "\\01";',
    'delete name;',
    'if (true) function declaration() {}',
    'while (false) function declaration() {}',
    'named: function declaration() {}',
    'static: while (true) { break static; }',
    'for (var iterator = 2 in entries) {}',
    '\n<!-- legacy comment',
    '\n--> legacy comment',
    'interface A { readonly /* trivia */ get x(): number; }',
    'type A = { readonly set x(value: number); }',
    'export class C { readonly get x() { return edge < 5; } }',
    'export class C { const constructor() {} }',
    'export class C { in constructor() {} }',
    'export class C { out constructor() {} }',
    'export class C implements void {}',
    'export class C implements null.Member {}',
    'function nested() { export const x = 1; }',
    'function nested() { export import A = B; }',
    'if (a) { export {}; }',
    '{ export default x; }',
    'function nested() { export * from "dependency"; }',
    'namespace T { function nested() { export const x = 1; } }',
    'class C { default field: string; }',
    'class C { default method() {} }',
    'const x = 1; export { x }; export { x };',
    'export function f() {} export function f() {}',
    'export function f(x: number): boolean; export { f }; export function f(x: number) { return x < 5; }',
  ]) {
    const source = `const first = x < y; ${suffix}`;
    const oracle = extractFallback(source);
    assert.equal(oracle.path, 'diagnostic', source);
    const actual = extract(source, { requireNative: true });
    assert.equal(actual.path, 'diagnostic', source);
    assert.deepEqual(actual.candidates, []);
    assert.deepEqual(actual.diagnostics, oracle.diagnostics);
  }
});

test('namespace exports and class members named default retain their candidates', () => {
  const source = 'namespace T { export class C { default = 3; method() { return this.default < 10; } } }';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fallback');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('a syntax refusal discards the Low* prefix and extracts the entire file', () => {
  const source = 'const first = a < b; namespace T { export const second = c >= d; }';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fallback');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('directly exported overload declarations preserve exact candidates', () => {
  const source = [
    'export function ready(value: number): boolean;',
    'export function ready(value: string): boolean;',
    'export function ready(value: number | string) { return Number(value) < 5; }',
  ].join('\n');
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fast');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});
