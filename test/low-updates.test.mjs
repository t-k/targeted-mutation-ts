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

const targets = { Name: 'count', Member: 'table.count', Index: 'table[index < limit]' };
const forms = {
  PreIncrement: target => '++' + target,
  PreDecrement: target => '--' + target,
  PostIncrement: target => target + '++',
  PostDecrement: target => target + '--',
};
const positions = {
  Comparison: update => `const ok = ${update} + extra < bound;`,
  Assignment: update => `record.count = ${update}; const ok = count >= bound;`,
  Loop: update => `for (let i = 0; i < max; ${update}) run();`,
};
const rows = readFileSync(new URL('../verification/pict/low-updates.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, target, position] = row.split('\t');
  test(`Low* update: ${form} ${target} ${position}`, () => {
    compare(positions[position](forms[form](targets[target])), 'fast');
  });
}

test('update expressions respect line breaks, maximal token width and targets', () => {
  for (const source of [
    'function update() { index++\n + value < limit; }',
    'function update() { index\n++other < limit; }',
    'function update() { index/*\n*/--other < limit; }',
    'const ok = index+++extra <= limit;',
    'const ok = ++\nindex < limit;',
    'const ok = `item-${index++}`.length > 10;',
  ]) compare(source, 'fast');
  for (const source of [
    'const ok = call()++ < limit;',
    'const ok = ++item?.count < limit;',
    'const ok = ++eval < limit;',
    'const ok = --arguments < limit;',
    'const ok = ++count++ < limit;',
    'const ok = count++() < limit;',
  ]) compare(source, 'diagnostic');
});

test('typed and untyped arrow rest parameters enforce last position', () => {
  for (const source of [
    'const count = (...args) => args.length < limit;',
    'const read = async (source: Source, ...args: Item[]) => (await source(...args)).length >= limit;',
    'type Filter = (...items: Item[]) => boolean; const ok = count < limit;',
    'interface Runner { check(...items: Item[]): boolean } const ok = count < limit;',
  ]) compare(source, 'fast');
  for (const source of [
    'const count = (...args, other) => args.length < limit;',
    'const count = (...args,) => args.length < limit;',
    'const count = (...args) => { "use strict"; return args.length < limit; };',
    'type Filter = (...items: Item[], other: Item) => boolean; const ok = count < limit;',
  ]) compare(source, 'diagnostic');
});
