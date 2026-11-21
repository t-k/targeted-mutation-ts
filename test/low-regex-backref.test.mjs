import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
  return actual.path;
}

const patterns = {
  Ordinary: ['(a)', 1],
  Named: ['(?<letter>a)', 1],
  Nested: ['(?=(a))(?<outer>(b))', 3],
  Alternation: [String.raw`([\w$]+)\s+as\s+App\1|([\w$]+)\s+as\s+default`, 2],
};
const rows = readFileSync(new URL('../verification/pict/low-regex-backref.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [kind, flag, reference] = row.split('\t');
  test(`Low* numeric regex reference: ${kind} ${flag} ${reference}`, () => {
    const [captures, last] = patterns[kind];
    const pattern = reference === 'Forward' ? `\\${last}${captures}` :
      `${captures}\\${reference === 'Missing' ? last + 1 : last}`;
    const path = compare(`/* £ */const before = a < b; const match = /${pattern}/${flag === 'Unicode' ? 'u' : ''} >= limit;`);
    if (reference === 'Valid') assert.equal(path, 'fast');
    else assert.notEqual(path, 'fast');
  });
}

test('numeric escapes distinguish decimal references from NUL, literal backslashes and class escapes', () => {
  const fixture = pattern => `const ok = /${pattern}/u < limit;`;
  assert.equal(compare(fixture('(a)'.repeat(10) + '\\10')), 'fast');
  assert.equal(compare(fixture('(a)'.repeat(100) + '\\99\\100')), 'fast');
  assert.equal(compare(fixture(String.raw`(a)\0\\1\1`)), 'fast');
  for (const pattern of [String.raw`(a(b))\1\2`, String.raw`(?=(a))(?:b)(?<x>c)\1\2`, String.raw`(a)|(b)\2`, String.raw`(\1)`]) {
    assert.equal(compare(fixture(pattern)), 'fast', pattern);
  }
  for (const pattern of [String.raw`(a)\10`, String.raw`(a)\01`, String.raw`(a)[\1]`, String.raw`(?:a)\1`, String.raw`(?<=a)\1`]) {
    assert.notEqual(compare(fixture(pattern)), 'fast', pattern);
  }
  for (const reference of ['\\100', '\\999999', '\\1000000']) {
    assert.notEqual(compare(fixture('(a)'.repeat(99) + reference)), 'fast', reference);
  }
  assert.notEqual(compare(String.raw`const a = /(a)\1/; const ok = /\1/ < limit;`), 'fast');
});
