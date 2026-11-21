import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const sizes = { Previous: 256, High: 384, Capacity: 512, Over: 513 };
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
    assert.equal(actual.path, names === 'Duplicate' ? 'diagnostic' : count === 'Over' ? 'fallback' : 'fast');
    assert.deepEqual(actual.candidates, reference.candidates);
    assert.deepEqual(actual.diagnostics, reference.diagnostics);
  });
}

test('the native addon can fill the export, module, and local binding regions at once', () => {
  const declarations = count => Array.from({ length: count }, (_, index) => 'const name' + index + ' = 0;').join('\n');
  const exports = Array.from({ length: 8 }, (_, index) =>
    `export { ${Array.from({ length: 64 }, (_, offset) => `item${index * 64 + offset}`).join(', ')} } from "lib";`).join('\n');
  const source = exports + '\n' + declarations(511) + '\nfunction check() {\n' + declarations(512) + '\nreturn x < y; }';
  const actual = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(actual.path, 'fast');
  assert.deepEqual(actual.candidates, reference.candidates);
  assert.deepEqual(actual.diagnostics, reference.diagnostics);

  const extractModule = new URL('../src/extract.mjs', import.meta.url).href;
  const worker = `
    import assert from 'node:assert/strict';
    import { extract } from ${JSON.stringify(extractModule)};
    const result = extract(${JSON.stringify(source)}, { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.equal(result.candidates.length, 1);
  `;
  const parent = `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    const child = new Worker(${JSON.stringify(worker)}, { eval: true, resourceLimits: { stackSizeMb: 0.5 } });
    const exit = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(exit, 0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.signal ?? child.stderr);
});
