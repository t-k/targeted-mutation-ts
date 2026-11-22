import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const deep = 'const x = ' + '['.repeat(1000) + 'a < b], 2' + ']'.repeat(999) + ';';
const deeplyGrouped = 'const x = ' + '('.repeat(3000) + 'a < b' + ')'.repeat(3000) + ';';
const deeplyNested = 'const x = ' + '['.repeat(3000) + 'a < b' + ']'.repeat(3000) + ';';
const extractModule = new URL('../src/extract.mjs', import.meta.url).href;
const examples = {
  Deep: { source: deep, file: 'deep.ts' },
  Diagnostic: { source: 'const before = x < y;\nconst broken =', file: 'invalid.ts' },
  Logical: { source: 'const msg = "🌊"; const entry = <button disabled={a || (x >= y)}>{msg}</button>;', file: 'view.tsx' },
};

test('native extraction leaves the child-process builtin unloaded', () => {
  const program = `
    import { extract } from ${JSON.stringify(extractModule)};
    const loaded = () => process.moduleLoadList.includes('NativeModule child_process');
    const before = loaded();
    const result = extract('const ok = a < b;', { requireNative: true });
    const after = loaded();
    await import('node:child_process');
    console.log(JSON.stringify([before, result.path, after, loaded()]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [false, 'fast', false, true]);
});

function runWorker(entry, sample, mode, setup = '') {
  const { source, file } = sample;
  const options = { file, mode, logical: true };
  const worker = `
    import { parentPort } from 'node:worker_threads';
    import { ${entry} as parse } from ${JSON.stringify(extractModule)};
    ${setup}
    try {
      parentPort.postMessage(parse(${JSON.stringify(source)}, ${JSON.stringify(options)}));
    } catch (error) {
      parentPort.postMessage({ failure: error.message, code: error.cause?.code, detail: error.cause?.message });
    }
  `;
  const parent = `
    import assert from 'node:assert/strict';
    import { Worker } from 'node:worker_threads';
    const child = new Worker(${JSON.stringify(worker)}, { eval: true, resourceLimits: { stackSizeMb: 0.5 } });
    child.once('message', result => process.stdout.write(JSON.stringify(result)));
    const exit = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(exit, 0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.signal ?? child.stderr);
  return JSON.parse(child.stdout);
}

test('an isolated parser launch failure is distinct from a source diagnostic', () => {
  const result = runWorker('extractFallback', examples.Deep, 'module', 'process.execPath += ".missing";');
  assert.match(result.failure, /isolated parser/i);
  assert.equal(result.code, 'ENOENT');
});

test('an isolated parser exit preserves the cause of the child startup failure', () => {
  const setup = 'process.env.NODE_OPTIONS = "--tmt-unsupported-argument";';
  const result = runWorker('extractFallback', examples.Deep, 'module', setup);
  assert.match(result.failure, /isolated parser.*status/i);
  assert.match(result.detail, /tmt-unsupported-argument/);
});

test('fallback output is separate from Node preload output and preserves the compatibility route', () => {
  const sample = { source: 'namespace Model { export type Value = number; } declare const values: Array<number>; for (let i = 0; i < values.length; i++) {}', file: 'values.ts' };
  const options = { file: sample.file, mode: 'script', logical: true };
  const expected = extract(sample.source, options);
  assert.equal(expected.fallback, 'typescript');
  const setup = 'process.env.NODE_OPTIONS = "--import=data:text/javascript,console.log%28%22preload%22%29";';
  assert.deepEqual(runWorker('extract', sample, options.mode, setup), expected);
});

test('stack exhaustion retries the whole source in an isolated parser from the main thread', () => {
  const code = `
    import { extract, extractFallback } from ${JSON.stringify(extractModule)};
    const sources = ${JSON.stringify([deep, deeplyGrouped, deeplyNested])};
    const options = { file: 'deep.ts' };
    process.stdout.write(JSON.stringify([extract(sources[0], options), ...sources.slice(1).map(source => extractFallback(source, options))]));
  `;
  const parsed = spawnSync(process.execPath, ['--stack-size=512', '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(parsed.status, 0, parsed.error?.message ?? parsed.stderr);
  const results = JSON.parse(parsed.stdout);
  assert.equal(results[0].reason, 'depth-limit');
  for (const result of results) {
    assert.equal(result.path, 'fallback');
    assert.equal(result.fallback, 'typescript');
    assert.deepEqual(result.candidates.map(({ operator }) => operator), ['<']);
  }
});

test('module extraction after a native depth refusal preserves the complete candidate in a worker', () => {
  const result = runWorker('extract', examples.Deep, 'module');
  assert.equal(result.path, 'fallback');
  assert.equal(result.reason, 'depth-limit');
  assert.deepEqual(result.candidates, extractFallback(examples.Deep.source).candidates);
  assert.equal(result.candidates.length, 1);
});

const rows = readFileSync(new URL('../verification/pict/fallback-worker.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [entry, mode, result] = row.split('\t');
  test(`fallback on short-stack worker: ${entry} ${mode} ${result}`, () => {
    const sample = examples[result];
    const options = { file: sample.file, mode: mode.toLowerCase(), logical: true };
    const parse = entry === 'Extract' ? extract : extractFallback;
    const expected = parse(sample.source, options);
    assert.deepEqual(runWorker(parse.name, sample, options.mode), expected);
  });
}
