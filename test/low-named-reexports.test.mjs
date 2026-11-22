import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const exportsByForm = {
  Named: 'export { out', Alias: 'export { source as out', TypeList: 'export type { Source as out',
  InlineType: 'export { type Source as out', DefaultAlias: 'export { source as default',
};
const rows = readFileSync(new URL('../verification/pict/low-named-reexports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [form, collision, comparison] = row.split('\t');
  test(`Low* named re-export: ${form} ${collision} ${comparison}`, () => {
    const exported = form === 'DefaultAlias' ? 'default' : 'out';
    const other = exported === 'default' ? 'export default 0;' : 'export const out = 0;';
    const comparisonStatement = 'const ok = a < b;';
    const reexport = exportsByForm[form] + (collision === 'SameList' ? `, other as ${exported}` : ',') + '} from "lib";';
    const source = ['/* 海 */', comparison === 'Before' ? comparisonStatement : '',
      collision === 'Previous' ? other : '', reexport, collision === 'Following' ? other : '',
      comparison === 'After' ? comparisonStatement : ''].join('\n');
    compare(source, collision === 'None' ? 'fast' : 'diagnostic');
  });
}

test('identifier names, empty lists, and direct type declarations preserve reference behavior', () => {
  for (const source of [
    'export { default as if, type as while } from "lib";',
    'export type Out = string; export { source as Out } from "lib";',
    'export { source as Out } from "lib"; export interface Out {}',
    'export {}; export type {} from "lib";',
  ]) compare(`${source} const ok = a < b;`, 'fast');
});

test('complete named export lists use Low* and cross-list duplicates reject a prefix', () => {
  compare('const ok = a < b; export { first as value } from "a"; export type { Second as value } from "b";', 'diagnostic');
  compare('const ok = a < b; export { source as value } from;', 'diagnostic');
  compare('const ok = a < b; export { absent };', 'diagnostic');
  compare('const ok = a < b; export { ok };', 'fast');
  compare('const ok = a < b; export { source as "punctuation!" } from "a";', 'fallback');
});

test('the per-list and total re-export limits preserve complete candidates', () => {
  const list = (count, start = 0) => `export { ${Array.from({ length: count }, (_, i) => `item${start + i}`).join(', ')} } from "lib";`;
  compare(list(64) + 'const ok = a < b;', 'fast');
  compare(list(65) + 'const ok = a < b;', 'fallback');
  const full = Array.from({ length: 8 }, (_, i) => list(64, i * 64)).join('\n');
  compare(full + 'const ok = a < b;', 'fast');
  compare(full + list(1, 512) + 'const ok = a < b;', 'fallback');
});
