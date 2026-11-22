import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, path, file = 'hotspot.ts') {
  const options = { file, requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-generic-hotspots.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [feature, dialect, suffix] of rows) {
  test(`Low* generic hotspots ${feature} ${dialect} ${suffix}`, () => {
    const tsx = dialect === 'TSX';
    const source = {
      ConstParam: tsx ? 'const choose = <const Item>(value: Item) => <Box count={value < max} />;' :
        'export function choose<const Item extends Thing>(value: Item) { return value < max; }',
      Unique: 'const key: unique symbol = Symbol("name"); const keep = a < b;',
      Global: 'declare global { interface Window { item?: Thing | null; } } export const keep = a < b;',
      Captures: 'const keep = /^(?<importedName>x)(?<localName>y)$/.test(value) && x < y;',
    }[feature];
    check('/* 🧪 */ ' + source + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic',
      tsx ? 'hotspot.tsx' : 'hotspot.ts');
  });
}

test('const type parameters keep bindings, constraints and arrow ambiguity', () => {
  check('const select = <const T = Item, R extends T>(a: R) => a < b;', 'fast', 'types.tsx');
  check('/* 🧪 */ const pick = <const T>(x: T) => x < low || (x > high && x <= max);', 'fast', 'types.tsx');
  check('const select = <const\nT>(a: T) => a < b;', 'fast');
  check('type Box<const T> = T; interface Shape<const T> { value: T } class C<const T> { value: T; } const keep = a < b;', 'fast');
  check('const choose = <const T>(a: T) => a < b; const other = <const T={1}>hi</const>;', 'fast', 'types.tsx');
  check('const choose = <const>(a: Type) => a < b;', 'diagnostic');
});

test('augmentation and unique types keep their enclosing boundaries', () => {
  check('type Window = string; declare global { interface Window {} interface Window { item: Thing } } const keep = a < b;', 'fast');
  check('declare global { let item: Thing; } const keep = a < b;', 'fallback');
  check('declare global { interface Window {} type Window = Thing; } const keep = a < b;', 'diagnostic');
  check('const item: readonly unique symbol[] = keys; const keep = a < b;', 'fast');
  check('const item: unique Alternate = key; const keep = a < b;', 'fallback');
  check('const item: unique symbol<T> = key; const keep = a < b;', 'diagnostic');
});

test('duplicate named regex groups always leave candidate extraction to compatibility parsing', () => {
  const source = 'const regex = /(?<same>x)(?<same>y)/; const keep = a < b;';
  const ref = extractYuku(source);
  const result = extract(source, { requireNative: true });
  assert.notEqual(result.path, 'fast');
  assert.equal(result.path, ref.path);
  assert.deepEqual(result.candidates, ref.candidates);
});

test('ambient interface names preserve module and script restrictions', () => {
  for (const declaration of ['declare interface await {}', 'declare global { interface await {} }']) {
    const source = `${declaration} const keep = a < b;`;
    check(source, 'diagnostic');
    const options = { file: 'ambient.ts', mode: 'script', requireNative: true };
    const reference = extractYuku(source, options);
    const result = extract(source, options);
    assert.equal(result.path, 'fallback');
    assert.deepEqual(result.candidates, reference.candidates);
  }
  check('declare global { interface eval {} } const keep = a < b;', 'fallback');
});
