import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'declared-field.ts', mode: 'module', requireNative: true };
function compare(source, fast) {
  const actual = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  assert.equal(actual.path === 'fast', fast, source);
}
const rows = readFileSync(new URL('../verification/pict/pulse-declare-fields.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [modifier, key, tail] = row.split('\t');
  test(`Pulse declare field: ${modifier} ${key} ${tail}`, () => {
    const access = modifier === 'Plain' ? '' : modifier.toLowerCase() + ' ';
    const property = { Identifier: 'entries', Computed: '[Symbol.metadata]', Private: '#entries' }[key];
    const optional = tail === 'Optional' ? '?' : '';
    const initializer = tail === 'Initialized' ? ' = c > d' : '';
    compare(`/* 海 */ class Shape { declare ${access}${property}${optional}: boolean${initializer}; ordinary = a < b; }`,
      key !== 'Private' && tail !== 'Initialized');
  });
}
test('declare remains a legal member name and invalid declaration suffixes delegate', () => {
  compare('class Shape { declare = a < b; }', true);
  compare('class Shape { declare(n: number) { return n < 0; } }', true);
  compare('class Shape { declare private pluginCache?: Map<string, unknown>; next = a < b; }', true);
  compare('class Shape { declare public readonly task: number; next = a > b; }', true);
  compare('class Shape { declare constructor: number; }', false);
  compare('class Shape { declare static prototype: number; }', false);
  compare('class Shape { declare override entry: number; }', false);
  compare('class Shape { declare field!: number; }', false);
  compare('class Shape { declare field: number; } const =', false);
});
