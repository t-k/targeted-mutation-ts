import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'forward.ts', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-forward-exports.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, availability, tail] = row.split('\t');
  test(`Pulse local forward export: ${kind} ${availability} ${tail}`, () => {
    const named = { Direct: 'item', Alias: 'item as value', Quoted: 'item as "a value"', External: 'item as value' }[kind];
    const exports = `export { ${named} }${kind === 'External' ? ' from "external"' : ''};`;
    const binding = 'const item = price >= threshold;';
    const first = availability === 'Before' ? binding : '';
    const last = availability === 'After' ? binding : availability === 'Nested' ? `function run() { ${binding} }` : '';
    const end = tail === 'Broken' ? 'const =' : tail === 'Duplicate' ? exports : '';
    const source = `/* 🧪 海 */ const keep = a < b; ${first} ${exports} ${last} ${end}`;
    compare(source, tail === 'Complete' && (kind === 'External' || availability === 'Before' || availability === 'After'));
  });
}

test('deferred lists preserve all members and accept declarations of different kinds', () => {
  compare('export { selected, Asset, T }; class Asset {} type T = string; function selected(x: number) { return x < 3; }', true);
  compare('export { selected, missing }; function selected(x: number) { return x < 3; }', false);
});

test('deferred export storage has a bounded limit independent of ordinary re-exports', () => {
  const forward = count => {
    const names = Array.from({ length: count }, (_, index) => 'item' + index);
    return names.map(name => `export { ${name} };`).join('\n') +
      '\n' + names.map(name => `const ${name} = a >= b;`).join('\n');
  };
  compare(forward(64), true);
  compare(forward(65), false);
});
