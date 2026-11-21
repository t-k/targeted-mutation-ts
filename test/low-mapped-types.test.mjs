import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'mapping.ts', logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const modifiers = {
  Plain: ['', ''],
  ReadonlyOptional: ['readonly ', '?'],
  RemoveReadonly: ['- /* negative */ readonly ', '+ ?'],
  SetReadonly: ['+readonly\n', '-?'],
};
const members = {
  Basic: ['keyof Ready', ': Ready[Key]'],
  Remapped: ['keyof Ready as `get${Key}`', ': Box<Ready[Key]>'],
  NoValue: ['keyof Ready', ''],
  ExtraMember: ['keyof Ready', ': boolean; extra: boolean'],
  MissingSource: ['', ': boolean'],
};
const placement = {
  Alias: mapping => `type M = ${mapping};\nconst keep = a < b;`,
  Assertion: mapping => `const keep = (value as ${mapping}) >= limit;`,
  Nested: mapping => `type M = After<{ update: ${mapping}; }> | Ready;\nconst keep = a > b;`,
  Annotation: mapping => `const value: ${mapping} = start;\nconst keep = a <= b;`,
};
const rows = readFileSync(new URL('../verification/pict/low-mapped-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [modifier, use, member] = row.split('\t');
  test(`Low* mapped type: ${modifier} ${use} ${member}`, () => {
    const [readonly, optional] = modifiers[modifier];
    const [sourceType, result] = members[member];
    const mapped = `{ ${readonly}[Key in ${sourceType}]${optional}${result}, }`;
    const source = `/* 海 */\nconst before = a >= b;\n${placement[use](mapped)}`;
    compare(source, member !== 'ExtraMember' && member !== 'MissingSource');
  });
}

test('mapped type prefixes leave ordinary object type members alone', () => {
  compare('type T = { readonly: number; readonly x: string; [index: string]: unknown; [Symbol.iterator](): Item; }; const keep = a < b;', true);
  compare('type T = { readonly [Key in X] }; const keep = a < b;', true);
  compare('type T = { [Key in A extends B ? C : D as Key]: X }; const keep = a < b;', true);
  compare('type T = { [Key in T] -? }; const keep = a < b;', true);
  compare('type T = { [Key in T]: U;; }; const keep = a < b;', false);
  compare('type T = { [Key in T]+: U }; const keep = a < b;', false);
  compare('type T = { [eval in T]: U }; const keep = a < b;', false);
  compare('type T = { [static in T]: U }; const keep = a < b;', false);
});
