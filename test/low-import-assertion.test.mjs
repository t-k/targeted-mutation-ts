import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'assertion.ts', logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const type = {
  Direct: 'import("pkg")',
  Qualified: 'import("pkg").Model',
  Query: 'typeof import("pkg").factory',
  KeyOf: 'keyof import("pkg").Model',
};
const targets = { Name: 'item', Member: 'cache.item', Call: 'lookup()', Optional: 'cache?.item' };
const suffix = {
  Assign: '<Box<T>>= left < right',
  Compound: '<T> <<= left > right',
  Compare: '<T> >= limit',
  MissingClose: '<Box<T> + limit',
};
const rows = readFileSync(new URL('../verification/pict/low-import-assertion.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, operation, target] = row.split('\t');
  test(`Low* import assertion: ${kind} ${operation} ${target}`, () => {
    const source = `/* 海 */\nconst before = a <= b;\nconst result = ${targets[target]} as ${type[kind]}\n${suffix[operation]};\nconst after = a > b;`;
    compare(source, operation === 'Compare' || operation !== 'MissingClose' && (target === 'Name' || target === 'Member'));
  });
}

test('type arguments after an import assertion preserve runtime and shift boundaries', () => {
  compare('const ok = a as import("pkg")\n< b >= c;', true);
  compare('const ok = a as import("pkg")\n< b >= c > d;', true);
  compare('const ok = value as import("pkg").Model /* 海\n */ <T> >= limit;', true);
  compare('const ok = a as import("pkg")\n<< b;', false);
  compare('const ok = a as typeof Value\n< b >= c;', false);
  compare('const ok = a as NamedType\n< b >= c;', false);
});

test('assigning to an asserted operand does not make it an update target', () => {
  compare('const out = name as T = left < right;', true);
  compare('const out = cache.item satisfies T += left < right;', true);
  compare('const out = name as T as U = left < right;', true);
  compare('const out = name as T++; const live = left < right;', false);
  compare('const out = (left < right) as T = value;', false);
  compare('const out = 0 as T = value;', false);
  compare('const out = name as T = ;', false);
});
