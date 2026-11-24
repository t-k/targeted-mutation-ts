import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const types = { Reference: 'Map<Key, Value>', Object: '{ log(message: string): void; }', Invalid: '' };
const scopes = {
  Module: value => value,
  Export: value => `export ${value}`,
  Function: value => `function read() { ${value} return left < right; }`,
};
const rows = readFileSync(new URL('../verification/pict/low-ambient-var.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [kind, scope, type] = row.split('\t');
  test(`Low* ambient binding: ${kind} ${scope} ${type}`, () => {
    const declaration = `declare ${kind.toLowerCase()} item: ${types[type]};`;
    const source = `/* 海 */ const first = a < b; ${scopes[scope](declaration)} const second = item >= max;`;
    compare(source, scope !== 'Function' && type !== 'Invalid');
  });
}

test('ambient var modifiers and declarations retain namespace and initializer boundaries', () => {
  compare('declare var item: Options; type item = string; const ok = item < limit;', true);
  compare('const before = a < b; declare\nvar item: T;', true);
  compare('const before = a < b; declare var item;', true);
  compare('const before = a < b; declare var item, other: T;', true);
  for (const suffix of ['declare var item: T; const item = 0;', 'declare var item: T = a > b;',
    'declare var item, item: T;']) {
    compare(`const before = a < b; ${suffix}`, false);
  }
});
