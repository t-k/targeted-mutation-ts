import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const alias = 'type Entry<T extends string = "name"> = { key: T; values: [T, number] };';
const placements = {
  Direct: alias,
  If: `if (a < b) ${alias} else record(c <= d);`,
  While: `while (a < b) ${alias}`,
  Do: `do ${alias} while(a < b);`,
  For: `for (let i = 0; i < limit; i++) ${alias}`,
  Switch: `switch (a < b) { case 0: ${alias} break; }`,
  Block: `{ ${alias} record(a < b); }`,
};
const following = { Return: 'return balance >= threshold;', Expression: 'record(balance >= threshold);' };
const rows = readFileSync(new URL('../verification/pict/low-local-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [placement, next, suffix] = row.split('\t');
  test(`Low* local alias: ${placement} ${next} ${suffix}`, () => {
    const source = `function read() { ${placements[placement]} ${following[next]} }` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('local alias declarations persist through transparent controls only', () => {
  const transparent = ['if (x < y)', 'while (x < y)', 'if (x < y) if (nothing)', 'do'];
  for (const head of transparent) {
    const alias = head + ' type Entry = T;' + (head === 'do' ? ' while (x < y);' : '');
    compare(`function read() { ${alias} type Entry = U; return a >= b; }`, 'diagnostic');
    compare(`function read() { type Entry = U; ${alias} return a >= b; }`, 'diagnostic');
    compare(`function read() { ${alias} type Other = U; return a >= b; }`, 'fast');
  }
  for (const local of [
    'for (let x = 0; x < y; x++) type Entry = T;',
    'for (;;) if (x < y) type Entry = T;',
    'switch (x < y) { case 0: type Entry = T; }',
    '{ type Entry = T; }',
  ]) {
    compare(`function read() { type Entry = U; ${local} return a >= b; }`, 'fast');
  }
  compare('function f() { if (x < y) type Entry = T; else type Entry = U; }', 'diagnostic');
  compare('function f() { switch (x < y) { case 0: type T = A; default: type T = B; } }', 'diagnostic');
});

test('local alias syntax preserves terminators and the contextual type identifier', () => {
  compare('function f() { type Item = number\nreturn value < limit; }', 'fast');
  compare('function f() { type\nItem = value < limit; type(); }', 'fast');
  compare('function f() { if (x < y) type Item =; else action(); }', 'diagnostic');
  compare('function f() { type Item = string; const Item = x < y; }');
  compare('function f() { if (x < y) type Item = T\n< limit; }', 'diagnostic');
});
