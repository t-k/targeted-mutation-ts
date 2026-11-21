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

const forms = {
  Value: 'export default { active: n >= max, run() { return n < min; } };',
  Named: 'export default async function ready(n: number) { return await read(n) < max; }',
  Anonymous: 'export default function<T>(arg: T) { return arg.length >= max; }',
  Star: 'export * from "./values";',
  TypeStar: 'export type * from "./types";',
};
const rows = readFileSync(new URL('../verification/pict/low-exports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, position, suffix] = row.split('\t');
  test(`Low* export: ${form} ${position} ${suffix}`, () => {
    const source = (position === 'AfterBinding' ? 'const max = 2; ' : '') + forms[form] +
      '\nconst ok = value > min;' + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('default exports preserve module binding, uniqueness, and ASI', () => {
  for (const source of [
    'export default async\nfunction ready() { return a < b; }',
    'export default function f() { return a < b; }const later = f() > min;',
    'export*from "a"; export*from "b"; const ok = left < right;',
    'export default (function ready() { return a < b; }); const ready = true;',
  ]) compare(source, 'fast');
  for (const source of [
    'export default a < b; export default 0;',
    'export default function ready() { return a < b; } const ready = 0;',
    'export default 0; export * from "mod"; export default a < b;',
    'export * "./missing"; const ok = a < b;',
    'export type *; const ok = a < b;',
    'export default;',
  ]) compare(source, 'diagnostic');
  compare('export default a < b;', 'diagnostic', { mode: 'script' });
});
