import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const forms = {
  Ordinary: 'function select(item: Ready): boolean;',
  Exported: 'export function select(item: Ready): boolean;',
  Generic: 'function select<T = string>(item: T, flag?: boolean): T;',
  Rest: 'function select(...items: Ready[]): boolean;',
};
const rows = readFileSync(new URL('../verification/pict/low-function-overloads.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [form, following, comparison] = row.split('\t');
  test(`Low* function overload: ${form} ${following} ${comparison}`, () => {
    const exported = form === 'Exported' ? 'export ' : '';
    const definition = `${exported}function select(item: Ready): boolean { return item.count < limit; }`;
    const next = {
      SignatureOnly: `${exported}function select(item: number): boolean;`,
      OneBody: definition,
      TwoBodies: `${definition}\n${definition}`,
      ValueCollision: 'const select = threshold;',
    }[following];
    const comparisonStatement = 'const keep = left >= right;';
    const source = ['/* 海 */', comparison === 'Before' ? comparisonStatement : '', forms[form], next,
      comparison === 'After' ? comparisonStatement : ''].join('\n');
    compare(source, following === 'SignatureOnly' || following === 'OneBody');
  });
}

test('bodyless signatures use ASI but do not reserve runtime export names', () => {
  compare('export function select(value: Ready): boolean\nexport { other as select } from "lib";\nconst keep = x < y;', true);
  compare('export function select(value: Ready): boolean;\nexport function select(value: Ready) { return x < y; }\nexport { other as select } from "lib";', false);
  compare('type select = boolean; function select(x: Ready): select; function select(x: Ready): select { return x.count > 0; }', true);
  compare('function select(value = a < b): boolean;\nconst keep = x < y;', false);
});

test('adjacent local signatures resolve to one function binding', () => {
  compare('function forms() { function bind<T>(x: T): T; function bind(x: string): string; function bind(x: string) { return x.length < limit; } return p <= q; }', true);
  compare('function forms() { var result; function bind(x: number): number\nfunction bind(x: number) { return x < limit; } return p <= q; }', true);
  for (const tail of [
    'function other(x: number) { return x < limit; }',
    'const middle = a < b; function bind(x: number) { return x < limit; }',
    'async function bind(x: number) { return x < limit; }',
    '',
  ]) compare(`function forms() { function bind(x: number): number; ${tail} }`, false);
});
