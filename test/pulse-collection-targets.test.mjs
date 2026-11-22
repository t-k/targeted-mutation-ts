import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const options = { file: 'collection.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-collection-targets.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [target, loop, tail] = row.split('\t');
  test(`Pulse collection: ${target} ${loop} ${tail}`, () => {
    const prefix = { Existing: '', Var: 'var ', Let: 'let ', ConflictingVar: 'var ' }[target];
    const head = loop === 'AwaitOf' ? 'for await' : 'for';
    const before = target === 'ConflictingVar' ? '{ const value = 1; } ' : '';
    const token = loop === 'In' ? 'in' : 'of';
    const source = `/* 🧪 */ async function scan() { ${before}${head} (${prefix}value ${token} items) { check(value < max); } }` +
      (tail === 'Broken' ? ' const =' : '');
    const expected = tail === 'Broken' ? 'diagnostic' : target === 'ConflictingVar' ? 'fallback' : 'fast';
    const result = extract(source, options);
    assert.equal(result.path, expected, source);
    for (const reference of [extractTypeScript(source, options), extractYuku(source, options)]) {
      assert.deepEqual(result.candidates, reference.candidates, source);
    }
  });
}

test('collection target lookahead keeps the restricted and lexical forms separate', () => {
  for (const source of [
    'for (async of items) check(a < b);',
    'for (eval in items) check(a < b);',
    'for (arguments of items) check(a < b);',
    'function scan() { for (var value = x in items) check(value < max); }',
    'let value; for (var value of items) check(value < max);',
  ]) assert.notEqual(extract(source, options).path, 'fast', source);
  const target = 'function scan() { var value; for (value of items) check(value < max); }';
  const result = extract(target, options);
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, extractYuku(target, options).candidates);
});
