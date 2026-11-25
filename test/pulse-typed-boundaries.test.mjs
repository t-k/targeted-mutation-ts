import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'receiver.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const union = count => Array.from({ length: count }, (_, index) => `"item-${index}"`).join('\n  | ');
const rows = readFileSync(new URL('../verification/pict/pulse-typed-boundaries.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, context, suffix] = row.split('\t');
  test(`Pulse type boundary: ${form} ${context} ${suffix}`, () => {
    const text = {
      ThisType: 'interface Runner { on(value: string): this; }',
      ThisQuery: 'class Runner { method() { const field = value as keyof typeof this.fields; return field; } }',
      Receiver: 'const Runner = { transform(this, entry) { return entry; } };',
      PublicAbstract: 'abstract class Runner { public abstract run(value: string): void; }',
      DeclareAlias: 'declare type Runner<Context = unknown> = (input: Context) => void;',
      EscapedBacktick: "const hint = 'Use \\\x60composed\\\x60 instead';",
      LongUnion: `type Runner = ${union(160)};`,
    }[form];
    const prefix = context === 'AfterImport' ? 'import "module"; ' : '';
    const source = `${prefix}/* 🧪 海 */ ${text} const hit = age >= limit;` + (suffix === 'Malformed' ? ' const =' : '');
    compare(source, suffix === 'Comparison');
  });
}

test('unannotated receivers and public abstract modifiers remain contextual', () => {
  for (const source of [
    'const Runner = { transform(value, this) { return value > limit; } };',
    'const check = (this, x) => x > 3;',
    'class Runner { public abstract run(value: string): void; }',
    'abstract class Runner { public abstract run(): boolean { return a > b; } }',
    'type Query = this.invalid; const done = a < b;',
    'declare type Name = ; const done = a < b;',
    `type Union = ${union(16385)}; const done = a < b;`,
  ]) compare(source, false);
});
