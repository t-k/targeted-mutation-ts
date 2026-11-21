import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const arrows = {
  Plain: value => `(arg = ${value}) => arg > limit`,
  Async: value => `async (arg = ${value}, extra = null) => await run(arg >= limit, extra)`,
  Typed: value => `(arg: any = ${value}): boolean => x <= limit`,
  Destructured: value => `({ name = "", mark }: Options = ${value}) => name < mark`,
};
const values = { String: '"空"', Number: '-.5', Keyword: 'null', Reference: 'undefined',
  Object: '{ /* empty */ }', Array: '[ /* empty */ ]' };
const rows = readFileSync(new URL('../verification/pict/low-arrow-defaults.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [arrow, value, suffix] = row.split('\t');
  test(`Low* arrow default: ${arrow} ${value} ${suffix}`, () => {
    const source = `const before = a < b; const check = ${arrows[arrow](values[value])}; const after = a >= b;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('arrow defaults are non-simple for directives and do not initialize a rest binding', () => {
  compare('const before = a < b; const check = (arg = 0) => { "use strict"; return arg < limit; };', 'diagnostic');
  compare('const before = a < b; const check = async (...arg = []) => arg < limit;', 'diagnostic');
  compare('const before = a < b; const check = (arg = 0, arg = 1) => arg < limit;', 'diagnostic');
});

test('speculative arrows preserve the surrounding comparison spans when the arrow is absent', () => {
  compare('const out = (arg = 0) < limit; const ok = async(arg = {}) >= limit;', 'fast');
  compare('const out = (arg = [a < b]) < limit;', 'fast');
  compare('const check = (arg = [a < b]) => arg >= limit;', 'fallback');
  compare('const view = (arg = {}) => <Tag value={arg.count < limit} />;', 'fast', { dialect: 'tsx' });
});
