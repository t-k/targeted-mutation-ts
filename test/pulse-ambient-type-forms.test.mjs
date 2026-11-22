import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'ambient.ts', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-ambient-type-forms.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, prelude, tail] = row.split('\t');
  test(`Pulse ambient type form: ${form} ${prelude} ${tail}`, () => {
    const text = {
      Protected: 'export abstract class Base { protected abstract resolve(input: number): string; }',
      Declared: 'declare abstract class Base { resolve(input: number): string; }',
      Infer: 'type Read<T> = T extends Record<string, infer Value extends number> ? Value : never;',
      Concrete: 'class Base { protected abstract resolve(input: number): string; }',
      Implementation: 'declare abstract class Base { resolve(): boolean { return a > b; } }',
      MissingType: 'declare abstract class Base { resolve(input); }',
    }[form];
    const prefix = prelude === 'Import' ? 'import "setup"; ' : '';
    const source = `${prefix}/* 海 🧪 */ ${text} const hit = a >= b;` + (tail === 'Broken' ? ' const =' : '');
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
    assert.equal(result.path === 'fast', tail === 'Comparison' && ['Protected', 'Declared', 'Infer'].includes(form), source);
  });
}
