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
  return actual;
}

const tuples = {
  Named: '[label: string, default: Options<T>]',
  Optional: 'readonly [head: string, count?: number, next?: string]',
  Rest: '[head: string, ...tail: U[], done: boolean]',
  Unnamed: '[string?, number?, ...U[]]',
};
const contexts = {
  Alias: value => `type List<T, U> = ${value};`,
  Interface: value => `interface List<T, U> { value: ${value}; }`,
  Call: value => `const actual = read<${value}>(count < max) > limit;`,
};
const rows = readFileSync(new URL('../verification/pict/low-tuple-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [tuple, context, suffix] = row.split('\t');
  test(`Low* tuple type: ${tuple} ${context} ${suffix}`, () => {
    const source = `const before = x < y; ${contexts[context](tuples[tuple])} const after = x >= y;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('tuple optionality is not reset by a rest item', () => {
  for (const tuple of ['[a?: string, b: boolean]', '[a?: string, ...tail: number[], b: boolean]', '[x: number,, y: boolean]']) {
    compare(`type Row = ${tuple}; const ok = a < b;`, 'diagnostic');
  }
  compare('type Row<T> = [head?: string, ...tail: T[], done?: boolean]; const ok = a < b;', 'fast');
  compare('type Row<T> = [head: string, ...tail: T[], boolean]; const ok = a < b;', 'fast');
  compare('type Row<T> = Set<head: string>; const ok = a < b;', 'diagnostic');
});

test('a postfix tuple question mark cannot begin on the next line', () => {
  for (const separator of ['\n', '/*\n*/']) {
    compare(`type Row<T> = [T${separator}?]; const ok = a < b;`, 'diagnostic');
  }
  compare('type Row<T> = [T /*same line*/ ?]; const ok = a < b;', 'fast');
  compare('type Row<T> = [label\n?\n: T]; const ok = a < b;', 'fast');
});

test('tuple grammar declines ambiguous modifiers and malformed elements', () => {
  for (const tuple of ['[...string?]', '[...x?: string[]]', '[x: string?]', '[T??]', '[x:]', '[?: T]']) {
    const source = `const before = a < b; type Row<T> = ${tuple}; const after = a > b;`;
    assert.notEqual(compare(source).path, 'fast', source);
  }
  for (const tail of ['T | U', 'T & U', '() => T', 'keyof T', 'readonly T[]']) {
    compare(`const before = a < b; type Row<T, U> = [T?, ${tail}?];`, 'diagnostic');
  }
  compare('type Row<T> = [T[]?, api.Value?]; const ok = a < b;', 'fast');
  compare('type Row<T> = [Array<T>?]; const ok = a < b;');
});

test('labeled tuples check the element count independently of the label count', () => {
  const source = count => `type Row = [${Array.from({ length: count }, (_, i) => `slot${i}: number`).join(',')}]; const ok = a < b;`;
  compare(source(64), 'fast');
  assert.notEqual(compare(source(65)).path, 'fast');
});
