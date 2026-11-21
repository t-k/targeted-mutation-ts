import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const receivers = { Member: 'node?.select', Index: 'node?.[left < right]', Call: 'callback?.' };
const args = { Name: 'HTMLElement', Nested: 'Node<Item<T>>', Pair: 'T, U' };
const rows = readFileSync(new URL('../verification/pict/low-optional-generics.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

for (const row of rows) {
  const [receiver, types, suffix] = row.split('\t');
  test(`Low* optional generic: ${receiver} ${types} ${suffix}`, () => {
    const source = `const ok = ${receivers[receiver]}<${args[types]}>(n < max) >= bound;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('optional generic calls preserve chain state and spaced type argument fallback', () => {
  compare('const ok = firstCard?.querySelector<HTMLElement>("[data-id=a]")?.count < bound;', 'fast');
  compare('const ok = callback?.<T>(n < max).length++ >= bound;', 'diagnostic');
  compare('const ok = node?.select <T>(n < max) >= bound;', 'fallback');
  compare('const ok = callback?.<T,>(n < max) >= bound;', 'fast');
});
