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

const predicates = { Name: 'value is Input', Asserts: 'asserts value', AssertsIs: 'asserts value is Input' };
const positions = {
  Declaration: type => `function check(value: Input): ${type} { if (value.size < max) run(); }`,
  Arrow: type => `const check = (value: Input): ${type} => value.size < max;`,
  Interface: type => `interface Validator { check(value: Input): ${type}; } const ok = a >= b;`,
  FunctionType: type => `type Validator = (value: Input) => ${type}; const ok = a < b;`,
};
const rows = readFileSync(new URL('../verification/pict/low-predicates.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [position, predicate, suffix] = row.split('\t');
  test(`Low* predicate: ${position} ${predicate} ${suffix}`, () => {
    const source = positions[position](predicates[predicate]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('method predicates, heritage and typed this share exact scope and source boundaries', () => {
  for (const source of [
    'interface Check extends pkg.Base<Input>, Other { ready(this: Check, value: unknown): value is Input } const ok = count < limit;',
    'function ready(this: Input, value: unknown): this is Ready { return this.size >= 2; }',
    'function ready(this: Input): asserts this is Ready { if (this.size < 0) throw err; }',
    'type Ready = (this: Input, value: Input) => value is Active; const ok = a < b;',
    'const x = { ready(this: Input, value: unknown): value is Input { return count < max; } };',
    'type Refine = (value: Input) => asserts value\nis Ready; const ok = a < b;',
  ]) compare(source, 'fast');
  for (const source of [
    'interface Check extends Base<Input>, { ready(): boolean } const ok = a < b;',
    'function ready(value: Input): value\nis Ready { return a < b; }',
    'function ready(this: Input = fallback) { return a < b; }',
    'const x = value as asserts as target > limit;',
    'type Refine = (value: Input) => asserts is; const ok = a < b;',
    'function ready(value: Input): asserts/**/is { return a < b; }',
    'type Refine = (value: Input) => asserts value\nis(a < b);',
    'interface Refine { f(value: Input): asserts value\nis: T; } const ok = a < b;',
  ]) compare(source, 'diagnostic');
});
