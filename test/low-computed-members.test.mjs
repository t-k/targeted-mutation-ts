import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const members = {
  Property: '[key < limit ? "a" : "b"]: count >= max',
  Method: '[items[index < limit]](value: number) { return value <= max; }',
  Async: 'async [prefix > limit ? "check" : "run"](value: number) { return await check(value < max); }',
};
const contexts = {
  Module: member => `const table = { ${member}, fallback: size > limit };`,
  Function: member => `function options() { return { ${member} }; }`,
  TSX: member => `const node = <Widget options={{ ${member} }} />;`,
};
const rows = readFileSync(new URL('../verification/pict/low-computed-members.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [member, context, suffix] = row.split('\t');
  test(`Low* computed member: ${member} ${context} ${suffix}`, () => {
    const source = contexts[context](members[member]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic', { file: context === 'TSX' ? 'input.tsx' : 'input.ts' });
  });
}

test('computed keys keep key-before-value order and require a value or method', () => {
  for (const source of [
    'const table = { first: a < b, [i > j]: x < y, last: u >= v };',
    'const table = { ["__proto__"]: a < b, ["__proto__"]: c > d };',
    'const table = { [await choose(x < y)]: size > limit };',
    'const table = { [a < b ? "a" : "b"]<T>(x: T) { return c >= d; } };',
  ]) compare(source, 'fast');

  for (const source of [
    'const table = { [name], other: a < b };',
    'const table = { [a < b: 2 };',
    'const table = { [a < b]: };',
    'const table = { [a < b]() };',
    'const table = { async\n[a < b]() {} };',
    'const table = { async [a < b]: true };',
  ]) compare(source, 'diagnostic');
});
