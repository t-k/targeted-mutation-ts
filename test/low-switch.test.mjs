import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const shapes = {
  Empty: 'switch (left < right) {}',
  Cases: 'switch (item >= bound) { case min < max: if (count > 0) break; case 2: record(count <= 2); }',
  Default: 'switch (item) { case low < high: const n = 0; default: record(n < max); break; case 0: run(); }',
};
const contexts = {
  Module: body => body,
  Function: body => `function run(item) { ${body} return item < max; }`,
  Loop: body => `while (n < max) { ${body} if (ready) continue; }`,
};
const rows = readFileSync(new URL('../verification/pict/low-switch.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [shape, context, suffix] = row.split('\t');
  test(`Low* switch: ${shape} ${context} ${suffix}`, () => {
    const source = contexts[context](shapes[shape]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('switch clauses share one lexical scope and inherit only existing loop permissions', () => {
  for (const source of [
    'while (n < max) { switch (item) { case 0: continue; default: if (x < limit) break; } continue; }',
    'switch (value) { case 0: const mark = 1; default: { const mark = 2; if (mark < high) break; } } const mark = a < b;',
    'switch (value) { case x < y ? 1 : 2: break; default: run(); }',
    'switch (value < limit) { case 1: case 2: default: }',
  ]) compare(source, 'fast');
  for (const source of [
    'switch (value < limit) { default: continue; }',
    'switch (value < limit) { default: break; default: break; }',
    'switch (value) { case 1: const x = a < b; case 2: let x = 0; }',
    'switch (value < limit) { const x = 0; }',
    'switch (value < limit) { case 1 run(); }',
    'switch (value < limit) { default: call(() => { break; }); }',
    'switch (value < limit) { default: break; } break;',
  ]) compare(source, 'diagnostic');
  compare('switch (value < limit) { case 0: let local = 1; break; default: run(); }', 'fast', { mode: 'script' });
});
