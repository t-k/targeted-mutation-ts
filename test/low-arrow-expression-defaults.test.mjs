import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function compare(source, fast, file = 'arrow.tsx') {
  const options = { file, logical: true };
  const native = extract(source, { ...options, requireNative: true });
  const reference = (native.path === 'fast' ? extractYuku : extractFallback)(source, options);
  assert.equal(native.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(native.candidates, reference.candidates, source);
  assert.deepEqual(native.diagnostics, reference.diagnostics, source);
}

const arrows = {
  Plain: value => `(value = ${value})`,
  Async: value => `async (key: string, value = ${value})`,
  TypedGeneric: value => `<T,>(value: T = ${value}): boolean`,
  Destructured: value => `({ value }: Ready = ${value})`,
};
const defaults = {
  MemberCall: 'state.seed.fetch(key)',
  Construction: 'new Set<Item>()',
  Comparison: '(next.offset >= min)',
  JSX: '<Button disabled={before < after} />',
};
const rows = readFileSync(new URL('../verification/pict/low-arrow-expression-defaults.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [arrow, value, outcome] = row.split('\t');
  test(`Low* arrow expression default: ${arrow} ${value} ${outcome}`, () => {
    const body = outcome === 'Directive' ? '{ "use strict"; return value < max; }'
      : arrow === 'Async' ? 'await keep(value >= min)' : 'value < max';
    const suffix = outcome === 'BrokenSuffix' ? '\nconst =' : '';
    compare(`/* 🧪 */const before = a < b; const f = ${arrows[arrow](defaults[value])} => ${body}; const after = a > b;${suffix}`,
      outcome === 'Valid');
  });
}

test('a failed speculative head never publishes leftover comparison and JSX candidates', () => {
  compare('const before = a < b; const t = (arg = [(a < b), c >= d]) < cutoff; const after = a >= b;', true);
  compare('const t = (arg = <Button disabled={left < right} />) < cutoff; const after = a >= b;', true);
  compare('const t = (arg = () => item >= limit) < cutoff; const after = a > b;', true);
  compare('const f = (arg = [a < b]) => arg >= limit;', true);
  compare('const f = (arg = <Button disabled={left || right} />) => arg >= limit;', false);
});

test('default expressions use the arrow parameter lexical context', () => {
  compare('for (let f = (arg = key in value) => arg < limit; a < b;) {}', true);
  compare('class C extends A { test() { return (value = super.value < min) => value > max; } }', true);
  compare('const f = async (x = await start()) => x < max;', false);
  compare('const f = (x = (a < b), x = y) => x < max;', false);
  compare('const f = (x = (a < b), ...tail: Ready[],) => x < max;', false);
  compare('const f = (x = a < b)\n=> x < max;', false);
  compare('const f = (x = read <A, B>(key)) => x < max;', false);
});

test('typed and async default heads retry when the candidate buffer fills', () => {
  for (const prefix of ['(prior, value: Item = ', 'async (value: Item = ']) {
    for (const count of [64, 65, 4096, 4097]) {
      const source = `const f = ${prefix}[${Array(count).fill('(left < right)').join(',')}]) => value;`;
      compare(source, count <= 4096, 'arrow.ts');
      const result = extract(source, { file: 'arrow.ts', requireNative: true });
      assert.equal(result.candidates.length, count);
      assert.equal(result.metrics.candidateBytes > 0, count > 64);
      if (count > 4096) assert.equal(result.reason, 'candidate-limit');
    }
  }
});
