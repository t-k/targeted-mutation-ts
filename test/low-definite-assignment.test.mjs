import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const markers = { Adjacent: '!', Spaced: ' /* gap */ ! ', LineBefore: '\n!', LineAfter: '!\n' };
const endings = { Typed: ': Array<Ready>;', MissingType: ';', Initialized: ': Ready = x < max;' };
const contexts = {
  ModuleLet: body => `export let value${body}`,
  LocalLet: body => `function read() { let value${body} return value < max; }`,
  LocalVar: body => `function read() { var value${body} return value >= max; }`,
};
const rows = readFileSync(new URL('../verification/pict/low-definite-assignment.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [scope, marker, ending] = row.split('\t');
  test(`Low* definite assignment: ${scope} ${marker} ${ending}`, () => {
    const source = `/* 空 */ const before = a < b; ${contexts[scope](markers[marker] + endings[ending])} const after = a > b;`;
    compare(source, marker === 'LineBefore' || ending !== 'Typed' ? 'diagnostic' : 'fast');
  });
}

test('non-mutable, destructured, and duplicate bindings retain early diagnostics', () => {
  for (const declaration of ['const value!: Ready;', 'let [value]!: Ready;', 'let value!: Ready; let value = other;']) {
    compare(`const before = a < b; ${declaration}`, 'diagnostic');
  }
  compare('const before = a < b; let value!\n: Ready\nrecord(value > limit);', 'fast');
  compare('const before = a < b; let value\n!other; const after = value >= limit;', 'fast');
});
