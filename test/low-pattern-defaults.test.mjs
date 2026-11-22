import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  return actual.path;
}

const patterns = {
  Array: value => `[, name = ${value}]`,
  Shorthand: value => `{ name = ${value} }`,
  Renamed: value => `{ 'title': name = ${value} }`,
};
const contexts = {
  Module: pattern => `const ${pattern} = source;`,
  Function: pattern => `function select(${pattern}) { return name < b; }`,
  Arrow: pattern => `const select = (${pattern}) => name > b;`,
  Collection: pattern => `for (const ${pattern} of values) { pick(name >= b); }`,
};
const values = { String: '"海"', Number: '-0.2', Keyword: 'true', Invalid: '' };
const rows = readFileSync(new URL('../verification/pict/low-pattern-defaults.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [pattern, context, value] = row.split('\t');
  test(`Low* binding default: ${pattern} ${context} ${value}`, () => {
    const source = `const before = a < b; ${contexts[context](patterns[pattern](values[value]))} const after = a >= b;`;
    compare(source, value === 'Invalid' ? 'diagnostic' : 'fast');
  });
}

test('literal defaults compose with nested bindings and preserve speculative arrow candidates', () => {
  compare('const data = ([{ label: { text = null } } = false]) => text < limit;', 'fast');
  compare('const { key: [value = "",] = null } = input; const ok = value < max;', 'fast');
  compare('const data = { punctuation: left < right }; const ok = x > y;', 'fast');
});

test('binding defaults can use names and empty collections without adding candidates', () => {
  compare('const [first = fallback, second = {}, third = []] = input; const ok = first < max;', 'fast');
});

test('rest and malformed defaults refuse, and expressions retain their comparison candidates', () => {
  for (const source of ['const [...name = 0] = input;', 'const { ...name = null } = input;',
    'const [name = "unfinished] = input;', 'const [name = true] ;']) {
    compare(`const before = a < b; ${source}`, 'diagnostic');
  }
  for (const source of ['const [name = 0 < limit] = input;', 'for (const { key = foo() } of values) { pick(key >= b); }']) {
    compare(`const before = a < b; ${source}`, 'fast');
  }
});
