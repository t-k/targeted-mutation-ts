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

const shapes = {
  Index: 'Config["routes"][0][]',
  KeyOf: 'keyof Config["routes"]',
  TypeOf: 'typeof api.settings',
  Import: 'import("./types").Value',
};
const positions = {
  Alias: type => `type T = ${type}; const ok = x < limit;`,
  Signature: type => `function check(x: ${type}) { return x.size >= limit; }`,
  Call: type => `const ok = check<${type}>(n < limit).size >= max;`,
};
const rows = readFileSync(new URL('../verification/pict/low-type-access.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [shape, position, suffix] = row.split('\t');
  test(`Low* type access: ${shape} ${position} ${suffix}`, () => {
    const source = positions[position](shapes[shape]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('type queries and interface methods preserve comparison spans', () => {
  for (const source of [
    'type Q = typeof import("pkg").api; const ok = (level as Q["code"]) < limit;',
    'const ok = value as typeof api.make<Item> >= limit;',
    'const ok = value as import("pkg").Model<Item> >= limit;',
    'const ok = (value as import("pkg")) < limit;',
    'type Q<T extends keyof Models> = Models[T]; const ok = use<Q<Key>>(a) < b;',
    'interface Loader { load?(query: Input): Promise<Output>; close(): void } const ok = count < max;',
    'type X = { "lookup"(id: string, hint?: Hint): Item["result"] }; const ok = n >= limit;',
  ]) compare(source, 'fast');
  for (const source of [
    'type Q = keyof; const ok = a < b;',
    'type Q = typeof 0; const ok = a < b;',
    'type Q = import(name).X; const ok = a < b;',
    'const ok: Model\n["field"] = a < b;',
    'interface Loader { close(): } const ok = count < max;',
    'const ok = a as typeof A < b;',
    'const ok = a as import("pkg").A < b;',
    'const ok = a as keyof typeof import("pkg").A < b;',
    'const ok = a as import("pkg")\n< b >= c;',
    'const ok = a as import("pkg")\n<< b;',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});
