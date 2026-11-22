import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function differential(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const loops = {
  For: body => `for (let i = 0; i < max; i++) { ${body} }`,
  While: body => `while (i < max) { ${body} }`,
  Do: body => `do { ${body} } while (i < max);`,
  Collection: body => `for (const i of values) { ${body} }`,
};
const endings = { Explicit: ';', Newline: '\nif (i >= max) run();', Brace: '' };
const rows = readFileSync(new URL('../verification/pict/low-jumps.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [loop, jump, end] = row.split('\t');
  test(`Low* loop jumps: ${loop} ${jump} ${end}`, () => {
    differential(loops[loop](`if (i >= 1) ${jump.toLowerCase()}${endings[end]}`), 'fast');
  });
}

test('jump permission is scoped to loop bodies and resets at functions', () => {
  for (const source of [
    'if (a < b) break;',
    'while (a < b) continue; break;',
    'while (a < b) run(() => { if (a < c) break; });',
    'for (const x of rows) { while (x < y) break; } if (x >= y) continue;',
    'while (a < b) { break missing; }',
  ]) differential(source, 'diagnostic');
  differential('while (a < b) { run(() => { while (b < c) break; }); continue; }', 'fast');
  differential('while (a < b) { if (b < c) continue/*\n*/run(); }', 'fast');
  differential('outer: while (a < b) { if (a >= x) continue outer; }', 'fast');
});
