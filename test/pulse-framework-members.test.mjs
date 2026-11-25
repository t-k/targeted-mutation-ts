import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'framework.ts', mode: 'module', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-framework-members.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [key, member, suffix] = row.split('\t');
  test(`Pulse framework member: ${key} ${member} ${suffix}`, () => {
    const spelling = {
      Identifier: 'key', Qualified: 'Symbol.iterator', String: '"entry"',
      Escaped: String.raw`'\u0065ntry'`, Comparison: 'a < b', Prototype: '"prototype"',
    }[key];
    const computed = `[/* key */ ${spelling}]`;
    const declarations = {
      Field: `class Shape { static ${computed} = a < b; }`,
      Method: `class Shape { ${computed}() { return a < b; } }`,
      Optional: `class Shape { ${computed}?(a?: string): void; }`,
      Binding: `const { ${computed}: field = (a < b) } = object;`,
    };
    compare(`/* 海 🧪 */ const before = c > d; ${declarations[member]}${suffix === 'Broken' ? ' const =' : ''}`,
      // A class member takes any expression as its computed key; a binding pattern takes a name or a string.
      suffix === 'Valid' && (member !== 'Binding' || !['Escaped', 'Comparison'].includes(key)));
  });
}

test('optional signatures do not suppress runtime candidates or invalid declarations', () => {
  compare("class Shape { ['ready']?(item?: number): boolean; next?(): void; }", true);
  compare("class Shape { ['ready']?<T>(item: T): T; next?<U>(value: U): void; }", true);
  compare('class Shape { static "prototype" = age < limit; }', false);
  compare('class Shape { ready?(): boolean { return age >= 18; } }', true);
  compare('class Shape { ready?(value = (age >= 18)): boolean; }', false);
  compare('class Shape { get ready?(): boolean; }', false);
  compare('class Shape { constructor?(): void; }', false);
  compare('class Shape { field = class { [arguments.x]: number; }; }', false);
});

test('nested exported type-only namespaces keep their bindings local', () => {
  compare('export namespace Outer { type Same = number; export namespace Inner { type Same = string; } type Last = Same; } const hit = a < b;', true);
  compare('export namespace Outer { export namespace One { type Same = string; } export namespace Two { type Same = number; } }', true);
  compare('export namespace Outer { export namespace Inner { type One = string; type One = number; } }', false);
  // A namespace of types merges with a type alias of its name.
  compare('export namespace Outer { export namespace Inner { type One = string; } type Inner = number; }', true);
  compare('export namespace Outer { export namespace Inner { type One = string; } } export { Inner };', false);
  compare('export namespace Outer { export namespace Inner { const hit = a < b; } }', false);
  compare('export namespace Outer { export namespace Inner { type One = string; } const hit = a < b;', false);
  compare('export namespace O { '.repeat(20) + 'type Entry = 1;' + ' }'.repeat(20), false);
});

test('default overloads publish exactly one matching contiguous implementation', () => {
  const first = 'export default function test(x: unknown): asserts x;';
  const second = 'export default function test<T>(x: T): T;';
  const body = 'export default function test(x: unknown) { return x < limit; }';
  compare(`/* 🧪 */ ${first} ${second} ${body} const later = n >= 18;`, true);
  compare(`const before = x > y; ${first}`, false);
  compare(`${first} const between = n >= 18; ${body}`, false);
  compare(`${first} ${body.replace('test', 'other')}`, false);
  compare(`${first} ${body.replace('function', 'async function')}`, false);
  compare(`${first} ${body.replace('export default ', '')}`, false);
  compare(`${first} ${body} export default x;`, false);
  compare(`${first} ${body} const =`, false);
  compare('export default function (x: number) { return x < limit; }', true);
  compare('export default function* test() { yield x < limit; }', true);
});

test('a declared static computed field consumes a type without eating any initializer', () => {
  compare('class Shape { declare static [Symbol.metadata]: object | undefined; plain = x < y; }', true);
  compare('class Shape { declare static [Symbol.metadata]: object = a < b; }', false);
  compare('class Shape { declare static [Symbol.metadata](): number { return 1; } }', false);
  compare('class Shape { declare static [Symbol.metadata]: }', false);
  compare('class Shape { declare static [Symbol.metadata]: number; } const =', false);
});
