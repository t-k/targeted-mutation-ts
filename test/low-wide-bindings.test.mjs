import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const sizes = { Previous: 64, High: 128, Capacity: 256, Over: 257 };
const rows = readFileSync(new URL('../verification/pict/low-wide-bindings.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [region, count, names] = row.split('\t');
  test(`Low* names: ${region} ${count} ${names}`, () => {
    const numbers = Array.from({ length: sizes[count] }, (_, index) =>
      index === sizes[count] - 1 && names === 'Duplicate' ? 0 : index);
    const declarations = numbers.map(index => `const local${index} = 0;`).join('\n');
    const source = region === 'Module' ? declarations + '\nrecord(x < y);'
      : 'function check() {\n' + declarations + '\nreturn x < y; }';
    const actual = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(actual.path, names === 'Duplicate' ? 'diagnostic' : count === 'Over' ? 'native' : 'fast');
    assert.deepEqual(actual.candidates, reference.candidates);
    assert.deepEqual(actual.diagnostics, reference.diagnostics);
  });
}

test('the native addon can fill the module and local binding regions at once', () => {
  const declarations = count => Array.from({ length: count }, (_, index) => 'const name' + index + ' = 0;').join('\n');
  const source = declarations(255) + '\nfunction check() {\n' + declarations(256) + '\nreturn x < y; }';
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, 'fast');
  assert.deepEqual(actual.candidates, reference.candidates);
  assert.deepEqual(actual.diagnostics, reference.diagnostics);
});
