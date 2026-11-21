import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'list.ts', logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const bindings = {
  Plain: (name, value) => `${name} = ${value}`,
  Typed: (name, value) => `${name}: Ready = ${value}`,
  Pattern: (name, value) => `{${name}} = ${value}`,
};
const rows = readFileSync(new URL('../verification/pict/low-module-declaration-list.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [declaration, binding, outcome] = row.split('\t');
  test(`Low* module declaration list: ${declaration} ${binding} ${outcome}`, () => {
    const keyword = { Const: 'const', Let: 'let', Exported: 'export const' }[declaration];
    const head = bindings[binding]('first', 'left >= right');
    const tail = bindings[binding](outcome === 'Duplicate' ? 'first' : 'second', outcome === 'MissingValue' ? '' : 'left < right');
    const end = outcome === 'BadSuffix' ? '\nconst =' : '\nconst keep = left > right;';
    compare(`/* 海 */\n${keyword} ${head},\n/* states */ ${tail};${end}`, outcome === 'Complete');
  });
}

test('typed let lists handle ASI, definite assignment and later initializers', () => {
  compare('let first: string, second!: Ready, third = left < right\nconst keep = left > right;', true);
  compare('export let first: string, second: Ready\nlet third = left < right;', true);
  compare('let first: string, second!: Ready = left < right;', false);
  compare('let first: string, { second }; const keep = left > right;', false);
});

test('all list names participate in module and export conflicts', () => {
  compare('type second = Ready; export const first = 0, second = left < right; export { second as other } from "path";', true);
  compare('export const first = 0, second = left < right; export { external as second } from "path";', false);
  compare('export const first = 0, {second} = state; export { external as second } from "path";', false);
  compare('export const first = 0, second = left < right; let second: Ready;', false);
  compare('const later = 0; const first = left >= right, later = sentinel;', false);
  compare('export const first = 0, second = left < right,;', false);
});

test('exposed type angles across a comma keep the reference result', () => {
  compare('const outcome = pick <A, B>(key); const keep = left > right;', false);
  compare('const first = left < right, second = a > b;', false);
  compare('const first = pick<A, B>(key), second = a > b;', true);
  compare('const first = (left < right), second = a < b;', true);
});
