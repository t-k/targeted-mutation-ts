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

const escapes = {
  Hex: String.raw`\x3C`,
  CodeUnit: String.raw`\uD800`,
  CodePoint: String.raw`\u{1f680}`,
  Continuation: '\\\r\n',
};
const rows = readFileSync(new URL('../verification/pict/low-escapes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [escape, placement, suffix] = row.split('\t');
  test(`Low* escape: ${escape} ${placement} ${suffix}`, () => {
    const quote = placement === 'String' ? '"' : '`';
    const source = `const ok = ${quote}猫${escapes[escape]}end${quote}.length < limit;` +
      (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('unicode bounds, regex NUL escapes, and decoded keys retain reference boundaries', () => {
  compare(String.raw`const ok = "\u{00000010FFFF}".length > limit && /\0/g.test(text);`, 'fast');
  for (const escape of [String.raw`\u{}`, String.raw`\u{110000}`, String.raw`\u123`, String.raw`\x3G`]) {
    compare(`const early = a < b; const value = "${escape}";`, 'diagnostic');
  }
  const proto = String.raw`const ok = ({__proto__: a, "\u005f_proto__": b}).length < limit;`;
  const actual = extract(proto, { requireNative: true });
  const reference = extractFallback(proto);
  assert.notEqual(actual.path, 'fast');
  assert.deepEqual(actual.candidates, reference.candidates);
  assert.deepEqual(actual.diagnostics, reference.diagnostics);
});

test('delete supports member targets without accepting strict identifier deletes', () => {
  for (const source of [
    'const ok = (delete target.field) < bound;',
    'delete target[index < max];',
    'const ok = delete target?.[index < max] && count >= 2;',
    'function run() { delete (options as Config).cached; return count < cap; }',
  ]) compare(source, 'fast');
  for (const source of [
    'const early = a < b; delete value;',
    'const early = a < b; delete (value);',
  ]) compare(source, 'diagnostic');
});
