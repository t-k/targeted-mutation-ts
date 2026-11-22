import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, expected) {
  const options = { file: 'exports.ts', requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, expected, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-local-exports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [form, binding, tail] of rows) {
  test(`Low* named exports ${form} ${binding} ${tail}`, () => {
    const prefix = binding === 'Bound' ? 'const item = value < limit; type Item = string;' : 'const keep = value < limit;';
    const declaration = {
      Local: 'export { item, };', Type: 'export type { Item };',
      Quoted: 'export { item as "module.exports" };', External: 'export { item as shared } from "dep";',
    }[form];
    const expected = tail === 'Broken' ? 'diagnostic' : binding === 'Missing' && form !== 'External'
      ? form === 'Type' ? 'fallback' : 'diagnostic'
      : 'fast';
    check(`/* 🧪 */ ${prefix} ${declaration} const last = limit >= floor;${tail === 'Broken' ? ' const =' : ''}`, expected);
  });
}

test('local exports use declared bindings and exact public-name spelling', () => {
  check('import { item } from "dep"; export { item as "two words" }; const keep = a < b;', 'fast');
  check('type Item = string; export { Item }; const keep = a < b;', 'fast');
  check('export { item }; const item = a < b;', 'fallback');
  check('const item = a < b; export { item as x }; export { item as "x" };', 'diagnostic');
  check('const item = a < b; export { item as "default" }; export default item;', 'diagnostic');
  check('const item = a < b; export { item as "\\u0078" };', 'fallback');
  check('const item = a < b; export { "item" as other };', 'diagnostic');
  check('export type { "item" as Other }; const keep = a < b;', 'diagnostic');
  check('namespace N { const item = 1; export { "item" as other }; } const keep = a < b;', 'diagnostic');
  check('export { "item" as other } from "dep"; const keep = a < b;', 'fallback');
  check('export { type Missing }; const keep = a < b;', 'fallback');
});

test('reserved local source names are diagnosed before publishing any candidate', () => {
  check('export type { default }; const keep = a < b;', 'diagnostic');
  check('namespace N { export { type yield as Next }; } const keep = a < b;', 'diagnostic');
  check('export type { y\\u0069eld as Next }; const keep = a < b;', 'diagnostic');
  check('export { default as Next } from "dep"; const keep = a < b;', 'fast');
  check('export type { await as Next }; const keep = a < b;', 'fallback');
});
