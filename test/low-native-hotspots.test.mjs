import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, expected, file = 'hotspots.ts') {
  const options = { file, requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, expected, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-native-hotspots.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [feature, dialect, suffix] of rows) {
  test(`Low* production hotspots ${feature} ${dialect} ${suffix}`, () => {
    const body = {
      ConstructorProperty: 'class C extends Base { constructor(public readonly x: T, protected y?: T, private z: U) { super(); if (z < max) run(); } }',
      GroupedAssertion: 'const keep = left > right; (state.index as number) += ready >= threshold ? 1 : 0;',
      RegexBrace: 'const keep = left > right; const matches = /(?:} finally \\{)+/g.test(text) && right < end;',
    }[feature];
    check('/* 🧪 */ ' + body + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic',
      dialect === 'TSX' ? 'hotspots.tsx' : 'hotspots.ts');
  });
}

test('parameter modifiers remain isolated to typed instance constructor properties', () => {
  check('class C { constructor(private readonly num: number = left >= right ? 2 : 1) {} }', 'fast');
  check('class C { constructor(readonly public item: T) {} } const keep = a < b;', 'fast');
  check('class C { static constructor(public item: T) {} } const keep = a < b;', 'diagnostic');
  check('class C { ordinary(public item: T) {} } const keep = a < b;', 'diagnostic');
  check('class C { constructor(public private item: T) {} } const keep = a < b;', 'fallback');
  check('class C { constructor(public ...items: T[]) {} } const keep = a < b;', 'diagnostic');
});

test('only eligible single assignments retain their target through grouping', () => {
  check('((state.index as number)) = ready >= threshold;', 'fast');
  check('(state satisfies T) = ready >= threshold;', 'fast');
  check('(state?.index as number) = ready >= threshold;', 'diagnostic');
  check('(a, state.index as number) = ready >= threshold;', 'diagnostic');
  check('(state.index as number)++; const keep = a < b;', 'fallback');
});

test('raw regex braces persist across groups and remain separate from escapes and classes', () => {
  check('const keep = /(?:a}|b)(c[}])/gi.test(input) && a < b;', 'fast');
  check('const keep = /(?:a}|b)(c[}])/ui.test(input) && a < b;', 'fallback');
  check('const keep = /(?:a\\}|b)(c[}])/u.test(input) && a < b;', 'fast');
  check('const keep = /(?:a}|b)/gg.test(input) && a < b;', 'diagnostic');
});
