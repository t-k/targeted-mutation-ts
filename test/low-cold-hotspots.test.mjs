import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, path, file = 'hotspots.ts') {
  const options = { file, requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const matrix = readFileSync(new URL('../verification/pict/low-cold-hotspots.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [feature, dialect, suffix] of matrix) {
  test(`Low* cold startup hotspots ${feature} ${dialect} ${suffix}`, () => {
    const body = {
      Exponent: 'const value = 2 * base ** exponent ** order < end; const other = (a < b) ** (c >= d);',
      Capture: 'const value = /(?<memoName>a)(?<componentName>b)(?<previousName>c)(?<nextName>d)(?<body>e)/.test(name) && root < end;',
      Attribute: 'import data from "config" with { type: "json" }; const value = data.size >= limit;',
    }[feature];
    check('/* 🧪 */ ' + body + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic',
      dialect === 'TSX' ? 'hotspots.tsx' : 'hotspots.ts');
  });
}

test('exponents bind more tightly than multiplication and preserve unary boundaries', () => {
  check('const keep = base ** -n >= limit;', 'fast');
  check('const keep = (++base ** n) > end;', 'fast');
  check('const keep = (-base) ** (n + 2) > end;', 'fast');
  check('const keep = -base ** n > end;', 'diagnostic');
  check('const keep = base ** typeof n ** high > end;', 'diagnostic');
  check('const keep = await base ** n > end;', 'diagnostic');
  check('const keep = (await base) ** n > end;', 'fast');
  check('const keep = ' + 'base ** '.repeat(65) + 'n > end;', 'fallback');
  check('let value = base; value **= n; const keep = value > end;', 'fallback');
});

test('the capture mask distinguishes both sets of production capture names', () => {
  check('const ok = /(?<componentName>a)(?<props>b)(?<keyCode>c)/.test(text) && a < b;', 'fast');
  check('const ok = /(?<items>a)(?<itemName>b)(?<componentName>c)(?<props>d)(?<runtimeKeyCode>e)/.test(text) && a < b;', 'fast');
  check('const ok = /(?<ala>a)(?<aav>b)/.test(text) && a < b;', 'fallback');
});

test('static import attributes keep their own statement and exact source boundary', () => {
  check('import "data" with {}; const keep = a < b;', 'fast');
  check('import data from "data"\nwith { type: "json", }\nconst keep = a < b;', 'fast');
  check('export { data } from "config" with { type: "json" }; const keep = a < b;', 'fast');
  check('import data from "data" with { type: 1 }; const keep = a < b;', 'diagnostic');
  check('import data from "data" with { type: "json", type: "json" }; const keep = a < b;', 'diagnostic');
  check('export { data } from "config" with { "type": "json", type: "json" }; const keep = a < b;', 'diagnostic');
  check('import "data" assert { type: "json", type: "json" }; const keep = a < b;', 'diagnostic');
  check('type T = import("data", { with: { type: "json", type: "json" } }).Schema; const keep = a < b;', 'fallback');
  check('const parsed = import("data", { with: { type: "json", type: "json" } }); const keep = a < b;', 'fast');
  check('import "data"; with ({ value: 1 }) { const keep = a < b; }', 'diagnostic');
});
