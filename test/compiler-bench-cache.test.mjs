import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { benchmarkCache, comparisonCohorts } from '../scripts/bench-compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-bench-cache.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const engines = ['tmt', 'oxc', 'yuku', 'swc-next'];

for (const row of rows) {
  const [cache, workload, acceptance] = row.split('\t');
  test('compiler benchmark cache and cohorts ' + row.replaceAll('\t', ' '), () => {
    const flags = cache === 'Disabled' ? ['--no-compilation-cache'] : [];
    assert.deepEqual(benchmarkCache(flags), {
      mode: cache === 'Disabled' ? 'disabled' : 'repeated', flags,
    });
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
