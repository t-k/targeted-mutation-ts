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

const operations = { Plain: '=', Arithmetic: '+=', Logical: '??=' };
const targets = { Name: 'item', Field: 'items.current', Index: 'items[index < bound]' };
const rows = readFileSync(new URL('../verification/pict/low-assignment.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [operation, target, context] = row.split('\t');
  test(`Low* assignment: ${operation} ${target} ${context}`, () => {
    const value = `${targets[target]} ${operations[operation]} upper >= lower`;
    const source = context === 'Statement' ? `${value};` : `const ok = (${value}) < max;`;
    compare(source + (context === 'Invalid' ? '\nconst =' : ''), context === 'Invalid' ? 'diagnostic' : 'fast');
  });
}

test('assignments associate right and preserve target restrictions', () => {
  for (const source of [
    'target[flags < 4] = intermediate = level > max;',
    'const ok = value >= bound ? (x.result = value) : (y[index > limit] ||= upper >= lower);',
    'let x; x = (start < stop);',
    'for (let i = 0; i < max; steps[i] += i > 0) run();',
    'const ok = ((target?.member).next = value >= limit) < max;',
  ]) compare(source, 'fast');
  for (const source of [
    'target?.field.next = level > max;',
    'target?.make()[index] = level > max;',
    'eval = a < b;',
    'arguments = a < b;',
    'a < b = c;',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

test('ambient and uninitialized bindings respect type boundaries and scope', () => {
  for (const source of [
    'declare const table: Record<string, number>; let total: number; if (total < 1) total = 0;',
    'export declare let budget: number\nif (budget >= 100) report();',
    'function check() { let fresh\nif (a < b) fresh = true; return fresh; }',
    'declare\nconst ok = a < b;',
  ]) compare(source, 'fast');
  for (const source of [
    'declare const budget: number; const budget = a < b;',
    'let [count]; const ok = a < b;',
    'const broken; const ok = a < b;',
  ]) compare(source, 'diagnostic');
});
