import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const initializers = {
  Array: '[[a < b], { result: c >= d },]',
  Object: '{ display: ready > 0, value: n < limit, kind: "🐈", existing, }',
  Arrow: 'items.map(value => ({ ready: value > limit }), () => n < limit)',
  Fraction: 'Math.random() > 0.5 ? "condense" : "preserve"',
};
const rows = readFileSync(new URL('../verification/pict/low-values.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [value, dialect, suffix] = row.split('\t');
  test(`Low* values: ${value} ${dialect} ${suffix}`, () => {
    const source = 'import { oldValue as existing, type Limit } from "./fixture";\n' +
      `const result = ${initializers[value]};` + (suffix === 'Invalid' ? '\nconst broken =' : '');
    const options = { requireNative: true, dialect: dialect.toLowerCase() };
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('mixed imports, compound values and simple type annotations are parsed as a full module', () => {
  const source = [
    'import { build, type Mode } from "./values";',
    'const items: Route[] = [{ path: "/", render: () => "🐈" }];',
    'const updated: { [K in keyof Route]: boolean } = ready;',
    'let mode: "short" | "long" = Math.random() > 0.5 ? "short" : "long";',
    'if (Math.random() >= 0.25) mode = "long";',
    'build({ items, mode });',
  ].join('\n');
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fast');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('compound syntax keeps unsupported cases on the reference route', () => {
  for (const source of [
    'const x = { __proto__: a < b, "__proto__": c > d };',
    'import type { type Limit } from "limits"; const x = a < b;',
    'const x = (a, a) => a < b;',
    'const x = a\n=> a < b;',
    'const x = (...[arg], last) => arg < 2;',
    '{ a: b < c }',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

test('arrow bodies retain angle ambiguity until the surrounding list closes', () => {
  for (const source of ['f(x => a < b, c > (d));', 'const result = [x => a < b, c > (d)];']) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(reference.candidates, []);
    assert.deepEqual(result.candidates, reference.candidates, source);
  }
});

test('type arguments and array suffixes cannot cross a line terminator', () => {
  for (const source of [
    'const x: A\n[] = a < b;',
    'const x: A /*\n*/ [] = a < b;',
    'const x: A | B\n<C> = a < b;',
    'const x: A | B /*\n*/ <C> = a < b;',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, 'diagnostic', source);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});
