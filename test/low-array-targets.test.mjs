import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, expected, file = 'targets.ts') {
  const options = { file, requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, expected, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-array-targets.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [feature, dialect, suffix] of rows) {
  test(`Low* array targets and bracket syntax ${feature} ${dialect} ${suffix}`, () => {
    const body = {
      ArrayTarget: 'let first; [first, model[i < max ? i : 0]] = [source, value > bound];',
      NumericBinding: 'const { 0: full, 1: scopedName } = source; const keep = full.length >= scopedName.length;',
      BracketTypeMember: 'type T = { label: string\n [token]: true\n [key: string]: any }; const keep = value > bound;',
    }[feature];
    check('/* 🧪 */ ' + body + (suffix === 'Broken' ? ' const =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic',
      dialect === 'TSX' ? 'targets.tsx' : 'targets.ts');
  });
}

test('array patterns distinguish plain assignment, candidates, and malformed elements', () => {
  check('let first, last; ([first, , last] = row); const test = first < last;', 'fast');
  check('const rows = [a < b, , c >= d]; inspect(a > b);', 'fast');
  check('[model?.x, other] = pair; const keep = a < b;', 'diagnostic');
  check('[first, 0] = pair; const keep = a < b;', 'diagnostic');
  check('[first, other] += pair; const keep = a < b;', 'diagnostic');
  check('[first, ...rest] = pair; const keep = a < b;', 'fast');
  check('[...rest, first] = pair; const keep = a < b;', 'diagnostic');
  check('[[first], other] = pair; const keep = a < b;', 'fallback');
});

test('type suffixes distinguish bracket members from indexed access and expression statements', () => {
  check('type T = { rows: U[RowKey]; next: U[]\n [token]: true }; const keep = a < b;', 'fast');
  check('type T = Array<string>; const keep = 1 as T\n[2 >= 3];', 'fast');
  check('const keep = (1 as T\n[2 >= 3]);', 'diagnostic');
  check('type T = { rows: U\n [] }; const keep = a < b;', 'diagnostic');
  check('const { 1.5: { id } } = source; const keep = id < 4;', 'fast');
  check('const { 0 } = source; const keep = a < b;', 'diagnostic');
});
