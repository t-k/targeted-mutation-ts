import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { benchmarkCache, comparisonCohorts, textInput } from '../scripts/bench-compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-bench-cache.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const engines = ['tmt', 'oxc', 'yuku', 'swc-next'];

for (const row of rows) {
  const [cache, workload, acceptance, input] = row.split('\t');
  test('compiler benchmark cache and cohorts ' + row.replaceAll('\t', ' '), () => {
    const flags = cache === 'Disabled' ? ['--no-compilation-cache'] : [];
    assert.deepEqual(benchmarkCache(flags), {
      mode: cache === 'Disabled' ? 'disabled' : 'repeated', flags,
    });
    const prepared = { source: 'prepared', bytes: Buffer.from('偏り') };
    const source = textInput(input === 'Bytes' ? 'bytes' : 'prepared');
    assert.equal(source(prepared), input === 'Bytes' ? '偏り' : 'prepared');
    const size = workload === 'Official' ? 1 : 2;
    const accepted = Object.fromEntries(engines.map(name => [name, Array(size).fill(true)]));
    if (acceptance === 'YukuDeclines') accepted.yuku[1] = false;
    if (acceptance === 'TmtDeclines') accepted.tmt[size - 1] = false;
    const cohorts = comparisonCohorts(accepted, size, workload === 'Official');
    const common = acceptance === 'Complete' ? '1'.repeat(size) : '1'.repeat(size - 1) + '0';
    assert.equal(cohorts[0].mask, common);
    if (acceptance === 'YukuDeclines') {
      assert.deepEqual(cohorts[1], { cohort: 'tmt-oxc-swc-next', engines: ['tmt', 'oxc', 'swc-next'], mask: '11' });
    } else assert.equal(cohorts.length, 1);
  });
}

test('a first-emission subprocess receives the selected V8 flag', () => {
  const child = spawnSync(process.execPath, [...benchmarkCache(['--no-compilation-cache']).flags,
    '-e', 'process.stdout.write(JSON.stringify(process.execArgv[0]))'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), '--no-compilation-cache');
});

test('benchmark input preparation rejects unknown modes', () => {
  assert.throws(() => textInput('utf16'), /TMT_BENCH_INPUT/);
});

test('the first-process sample detects a loaded TypeScript compiler after the timed region', async () => {
  const { loadedTypeScript } = await import('../scripts/bench-compiler.mjs');
  assert.deepEqual(loadedTypeScript({ '/repo/src/compiler.cjs': {}, '/repo/build/compiler-module.node': {} }), []);
  const loaded = { '/repo/node_modules/typescript/lib/typescript.js': {}, '/repo/build/typescript-syntax.cjs': {},
    'C:\\repo\\node_modules\\typescript\\lib\\typescript.js': {}, '/repo/src/typescript-compiler.mjs': {} };
  assert.deepEqual(loadedTypeScript(loaded), Object.keys(loaded).slice(0, 3));
});

test('the first-process child does not inherit the parent-only module flag', async () => {
  const { firstProcessEnvironment } = await import('../scripts/bench-compiler.mjs');
  const environment = firstProcessEnvironment({ PATH: '/bin', NODE_COMPILE_CACHE: '/tmp/cache',
    NODE_OPTIONS: '--experimental-vm-modules --max-old-space-size=512  --experimental-vm-modules' });
  assert.deepEqual(environment, { PATH: '/bin', NODE_COMPILE_CACHE: '/tmp/cache',
    NODE_OPTIONS: '--max-old-space-size=512', NODE_DISABLE_COMPILE_CACHE: '1' });
  assert.equal(firstProcessEnvironment({ NODE_OPTIONS: '--experimental-vm-modules' }).NODE_OPTIONS, '');
  assert.equal(firstProcessEnvironment({}).NODE_OPTIONS, undefined);
  assert.equal(firstProcessEnvironment({ NODE_OPTIONS: '--no-experimental-vm-modules-x' }).NODE_OPTIONS,
    '--no-experimental-vm-modules-x');
});
