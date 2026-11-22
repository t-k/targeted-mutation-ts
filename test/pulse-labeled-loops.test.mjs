import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'labels.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-labeled-loops.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [loop, placement, jump] = row.split('\t');
  test(`Pulse loop label: ${loop} ${placement} ${jump}`, () => {
    const action = {
      Break: 'break outer;', Continue: 'continue outer;', Unknown: 'break other;', Unlabeled: 'break;',
    }[jump];
    const placed = {
      Direct: action, Nested: `for (const entry of items) { ${action} }`,
      NestedNamed: `inner: for (const entry of items) { ${action} }`,
      Switch: `switch (state) { case 1: ${action} }`,
      Function: `invoke(() => { ${action} });`,
    }[placement];
    const body = `{ if (x >= y) { ${placed} } }`;
    const stmt = { For: `for (let n = 0; n < max; n++) ${body}`, While: `while (a <= b) ${body}`, Do: `do ${body} while (a <= b);` }[loop];
    const source = `/* 🧪 海 */ function run() { outer: ${stmt} return x < y; }`;
    compare(source, placement !== 'Function' && jump !== 'Unknown');
  });
}

test('a label only belongs to its loop and a function gets an independent context', () => {
  compare('outer: while (x > 1) { break outer; } while (y < 2) { break outer; }', false);
  compare('outer: while (x > 1) { inner: while (y < 2) { continue inner; break outer; } }', true);
  compare('outer: while (x > 1) { outer: while (y < 2) { break outer; } }', false);
  compare('one: while (a < b) { two: for (;;) { three: do { break one; } while (x >= y); } }', false);
  compare('outer: if (x > 1) { break outer; }', false);
  compare('outer: while (a > b) { run(() => { outer: for (;;) { break outer; } }); }', true);
  compare('outer: while (a > b) { continue\nouter; }', true);
});
