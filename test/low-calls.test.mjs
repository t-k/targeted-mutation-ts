import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const callees = { Plain: 'check', Member: 'table.check', Constructor: 'new API.Result' };
const types = { Simple: 'Value', Union: 'Value | Other, boolean', Nested: 'Map<string, Item[]>' };
const rows = readFileSync(new URL('../verification/pict/low-calls.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [callee, type, suffix] = row.split('\t');
  test(`Low* typed call: ${callee} ${type} ${suffix}`, () => {
    const source = `const ok = ${callees[callee]}<${types[type]}>(a < b).value >= limit;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('type-argument lookahead leaves comparisons and nested call operands intact', () => {
  for (const source of [
    'const ok = table.count<limit;',
    'const ok = f<0>(input) >= limit;',
    'const ok = outer(f<T>(x < y), make<U>(0) >= limit);',
    'const ok = new Result<Value[]>(a > b).weight <= 0;',
    'const ok = new API.Result(input < required).passed > 0;',
    'const ok = f<a,b>(x) >= limit;',
    'const ok = left < check<U>(n) && n >= limit;',
  ]) compare(source, 'fast');
  compare('const earlier = a < b; const ok = f<Outer<T>>(bad >= );', 'diagnostic');
});
