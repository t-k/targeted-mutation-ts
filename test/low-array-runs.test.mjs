import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  if (path) assert.equal(result.path, path);
  assert.deepEqual(result.candidates, reference.candidates);
  assert.deepEqual(result.diagnostics, reference.diagnostics);
  return result;
}

const depths = { Shallow: 5, Deep: 96, Worker: 1000 };
const elements = { Single: 'a >= b', Wide: 'a >= b, c > d, ...values', Trivia: '/* > */ item /* < */ <= limit' };
const rows = readFileSync(new URL('../verification/pict/low-array-runs.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [depth, element, suffix] = row.split('\t');
  test(`Low* array chain: ${depth} ${element} ${suffix}`, () => {
    const whitespace = element === 'Trivia' ? ' /* not an opener [ */ ' : '';
    const wrappers = depths[depth];
    const source = 'const before = lo > hi; const list = ' + ('[' + whitespace).repeat(wrappers) +
      elements[element] + ' ]'.repeat(wrappers) + '.length <= max;' + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('a deep array run preserves valid wrappers with extra syntax through fallback', () => {
  const open = '['.repeat(120);
  const close = ']'.repeat(119);
  compare('const a = ' + open + 'b < c] .length >= 0' + close + ';', 'fallback');
  compare('const a = ' + open + 'b < c], b > c' + close + ';', 'fallback');
  compare('const a = ' + open + 'b < c' + close + ';', 'diagnostic');
});

test('depth metrics include active structures inside collapsed arrays', () => {
  const open = '['.repeat(100);
  const close = ']'.repeat(100);
  const source = value => 'const items = ' + open + value + close + ';';
  const plain = compare(source('a < b'), 'fast');
  const grouped = compare(source('(a < b)'), 'fast');
  const object = compare(source('({ size: a < b })'), 'fast');
  const callback = compare(source('() => { let n = a; return n < b; }'), 'fast');
  assert.equal(plain.metrics.maxDepth, 100);
  assert.equal(grouped.metrics.maxDepth, 101);
  assert.equal(object.metrics.maxDepth, 102);
  assert.equal(callback.metrics.maxDepth, 101);
  const doubleRun = compare(source('(' + open + 'a < b' + close + ')'), 'fast');
  assert.equal(doubleRun.metrics.maxDepth, 201);
});

test('the deep Low* array run fits a short-stack Node worker', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const workerSource = `
    import assert from 'node:assert/strict';
    import { extract } from ${JSON.stringify(module)};
    const source = 'const x = ' + '['.repeat(1000) + 'a < b' + ']'.repeat(1000) + ';';
    const result = extract(source, { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.equal(result.candidates.length, 1);
    assert.ok(result.metrics.maxDepth >= 1000);
  `;
  const program = `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true, resourceLimits: { stackSizeMb: 0.5 } });
    const exit = await new Promise((resolve, reject) => {
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    assert.equal(exit, 0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.signal ?? child.stderr);
});
