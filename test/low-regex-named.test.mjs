import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  if (path) assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  return actual;
}

const patterns = {
  Named: String.raw`(?<entry>\.[^<]+)`,
  Nested: String.raw`(?:(?<entry>[\w]+)|other)+`,
  Siblings: String.raw`(?<a>x)(?<b>y){1,3}`,
  Lookaround: String.raw`(?<!(?<before>x))(?<entry>y)(?<=y)`,
};
const flags = { None: '', Global: 'g', Unicode: 'u' };
const rows = readFileSync(new URL('../verification/pict/low-regex-named.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [shape, flag, suffix] = row.split('\t');
  test(`Low* named regex: ${shape} ${flag} ${suffix}`, () => {
    const source = `/* 雨 */ const before = a < b; const match = /${patterns[shape]}/${flags[flag]} < limit;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('malformed and repeated capture names decline the Low* path', () => {
  for (const regex of ['/(?<>a)/', '/(?<1a>a)/u', '/(?<ab-a>a)/', '/(?<x a)/',
    '/(?<a>x)(?<a>y)/u', '/(?:(?<a>x))(?<a>y)/', '/(?<a>(?<a>x))/', '/(?<=(?<a>x))(?<a>y)/u']) {
    const source = `const before = a < b; const value = ${regex} >= limit;`;
    assert.notEqual(compare(source).path, 'fast', source);
  }
});

test('each literal has its own captures and class text does not open a group', () => {
  const source = 'const a = /[(?<name>x)](?<name>x)/ < limit; const b = /(?<name>y)/ >= min;';
  compare(source, 'fast');
  compare('const view = <A>{/(?<_entry$>a)/.test(value) && amount < max}</A>;', 'fast', { dialect: 'tsx' });
});

test('the capture mask and group depth decline conservatively', () => {
  assert.notEqual(compare('const ok = /(?<ab>x)(?<ba>y)/ < limit;').path, 'fast');
  const source = count => `const ok = /${'(?:'.repeat(count)}(?<entry>x)${')'.repeat(count)}/ < limit;`;
  compare(source(31), 'fast');
  assert.notEqual(compare(source(32)).path, 'fast');
});
