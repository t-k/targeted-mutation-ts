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

const members = {
  Call: '(x: unknown): x is string;',
  GenericCall: '<T extends string = "id">(x: T): T;',
  Construct: 'new <T extends Record<string, unknown> = Record<string, unknown>>(x: T): Factory<T>;',
  Method: 'load?<T>(this: Factory, value?: T, ...next: T[]): T;',
  Index: 'readonly [name: string]: number | undefined;',
};
const containers = {
  Alias: body => `type Factory<T = unknown> = { ${body} fallback?: T };`,
  Interface: body => `interface Factory<T = unknown> { ${body} fallback?: T }`,
  Inline: body => `const table: { ${body} value?: number } = supplied;`,
};
const rows = readFileSync(new URL('../verification/pict/low-type-signatures.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, type, suffix] = row.split('\t');
  test(`Low* type signature: ${kind} ${type} ${suffix}`, () => {
    const source = 'const before = now < then;\n' + containers[type](members[kind]) +
      '\nconst after = count >= limit;' + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('signature members remain separate from ordinary properties and executable computed keys', () => {
  for (const source of [
    'interface I { new: string; new?(): string; new <T>(value: T): T; } const ok = a < b;',
    'type T = { <F extends { <K>(x: K): K }>(f: F): F }; const ok = a >= b;',
    'type T = { readonly: string; readonly [key: number]: string; "make"<T>(x: T): T }; const ok = a >= b;',
    // A parameter of a signature may stand without a type.
    'interface I { <T>(x) : T; } const ok = a < b;',
  ]) compare(source, 'fast');

  for (const source of [
    'interface I { <T>(x: T); } const ok = a < b;',
    'interface I { [x: string, y: string]: number; } const ok = a < b;',
    'interface I { [a < b ? "on" : "off"]: string; } const ok = a < b;',
    'interface I { readonly load<T>(): T; } const ok = a < b;',
  ]) {
    assert.notEqual(extract(source, { requireNative: true }).path, 'fast');
    compare(source);
  }
});

test('a generic call signature starts after a line break following a type reference', () => {
  compare('interface Factory { (x: number): Result\n<T>(x: T): T; } const check = a < b;', 'fast');
  compare('interface Factory { (x: number): Result<T>(x: T): T; } const check = a < b;', 'diagnostic');
});
