import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const matrix = readFileSync(new URL('../verification/pict/ambient-interfaces.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [declaration, member, suffix] of matrix) {
  test(`Low* ambient interfaces: ${declaration} ${member} ${suffix}`, () => {
    const head = declaration === 'Global' ? 'declare global' : `declare module 'external'`;
    const modifiers = member === 'Exported' ? 'export ' : '';
    const source = `${head} { ${modifiers}interface Control extends Record<string, unknown> {}\n` +
      `${modifiers}interface Control { readonly enabled?: () => boolean } }\n` +
      'export const keep = high > low;' + (suffix === 'Broken' ? 'const =' : '');
    for (const file of ['ambient.ts', 'ambient.tsx']) {
      const options = { file, requireNative: true };
      const result = extract(source, options);
      const reference = extractYuku(source, options);
      assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
      assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic');
      assert.deepEqual(result.candidates, reference.candidates);
    }
  });
}

test('quoted ambient modules only accept supported members and keep downstream diagnostics', () => {
  for (const [declaration, path] of [
    ['declare module "external" {}', 'fast'],
    ['declare module "external" { export const A: number; }', 'fallback'],
    ['declare module "external" { export interface A {', 'diagnostic'],
  ]) {
    const result = extract(`const keep = a < b; ${declaration}`, { requireNative: true });
    const reference = extractYuku(`const keep = a < b; ${declaration}`);
    assert.equal(result.path, path);
    assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
  }
});
