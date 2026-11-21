import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const types = {
  Function: 'type Input = (value: string, hint?: Label) => number;',
  Grouped: 'type Input = (X | Y)[];',
  Generic: 'type Input<T = X | Y, U = Z> =\n  | (T | U)[]\n  | { readonly item?: T };',
  Constrained: 'type Input<T extends X = Y> = (value: T) => number;',
};
const bindings = { Name: 'value', Object: '{ item: value }', Array: '[index, value]' };
const rows = readFileSync(new URL('../verification/pict/low-declarations.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [type, binding, suffix] = row.split('\t');
  test(`Low* declarations: ${type} ${binding} ${suffix}`, () => {
    compare(`${types[type]} const ${bindings[binding]}: Input = source; const accepted = value < limit;` +
      (suffix === 'Invalid' ? '\nconst =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('default and optional parameters preserve candidate order and function boundaries', () => {
  compare('function f(input: string = width >= 1 ? a : b, hint?: number) { return input.length < limit; }', 'fast');
  compare('function f({ value }: Input = factory()) { const [start, stop] = value; return start < stop; }', 'fast');
  compare('function f(input = a < b) { const input = other; }', 'diagnostic');
  compare('const f = async () => true; async function g(a = await f()) { return a < b; }', 'diagnostic');
  compare('function g(a = 0) { "use strict"; return a < b; }', 'diagnostic');
  compare('type Async = (fn: (value: Item) => Foo) => Bar; const f = (n?: number) => n < 3;', 'fast');
});

test('destructuring retains duplicate checks, ASI, and logical assignments', () => {
  compare('const { first: count } = values; function f() { const [first] = values; return first > count; }', 'fast');
  compare('const { first: count } = values; const [count] = values; const x = count < limit;', 'diagnostic');
  compare('function f() { const [x, x] = values; return x < limit; }', 'diagnostic');
  compare('function f() { if (value < limit) return\nrun(); value &&= query().length >= 1; }', 'fast');
  compare('store.current ||= max < minimum; store.result ??= value > threshold;', 'fast');
  compare('type X = (value: string) => ; const x = a < b;', 'diagnostic');
  compare('type X = A | | B; const x = a < b;', 'diagnostic');
});

test('function types require parentheses inside unions and intersections', () => {
  for (const prefix of ['|', '&', 'A |', 'A &']) {
    compare(`type Shape = ${prefix} (value: Input) => Result; const x = a < b;`, 'diagnostic');
    compare(`type Shape = ${prefix} ((value: Input) => Result); const x = a < b;`, 'fast');
  }
  compare('type Shape = (value: Input) => First | Second; const x = a < b;', 'fast');
});
