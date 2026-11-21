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

const shapes = {
  Simple: 'A extends B ? One : Two',
  Nested: 'A extends B ? C extends D ? One : Two : E extends F ? Three : Four',
  Relation: 'A extends (B extends C ? D : E) ? Set<Ready> : readonly Empty[]',
  LineAfter: 'A extends B\n ? One\n : Two',
};
const contexts = {
  Alias: condition => `type View = ${condition};`,
  Annotation: condition => `const view: ${condition} = ready;`,
  Call: condition => `const view = read<${condition}>(x < y) >= min;`,
  Assertion: condition => `const view = (item as ${condition}) > min;`,
};
const rows = readFileSync(new URL('../verification/pict/low-conditional-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [shape, context, suffix] = row.split('\t');
  test(`Low* conditional type: ${shape} ${context} ${suffix}`, () => {
    const source = `/* 空 */ const before = a < b; ${contexts[context](shapes[shape])} const after = a >= b;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('conditional type boundaries preserve runtime ternaries and invalid type diagnostics', () => {
  compare('const out = (x as Ready) ? a < b : c > d;', 'fast');
  compare('const out = (x as A extends B ? C : D) ? a < b : c > d;', 'fast');
  compare('const out = x as A extends B ? C : D ? a < b : c > d;', 'fast');
  for (const leading of ['|', '&']) {
    compare(`type View = A extends ${leading} B ? One : Two; const out = a < b;`, 'fast');
  }
  for (const type of ['A\n extends B ? C : D', 'A extends B extends C ? D : E ? F : G', 'A extends B ? C', 'A extends ? C : D', '[A?, B extends C ? D : E?]']) {
    compare(`const before = a < b; type View = ${type};`, 'diagnostic');
  }
  compare('const before = a < b; type View<T> = T extends Array<infer Value> ? Value : never;', 'fast');
});
