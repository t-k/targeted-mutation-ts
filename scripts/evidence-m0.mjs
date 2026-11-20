import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrototype } from '../src/prototype.mjs';
import { withCopy } from '../src/vitest.mjs';

const fixture = fileURLToPath(new URL('../fixtures/shipping', import.meta.url));
const output = resolve(process.argv[2] ?? 'build/evidence/m0');
const stryker = fileURLToPath(import.meta.resolve('@stryker-mutator/core/package.json')).replace(/package\.json$/, 'bin/stryker.js');
mkdirSync(output, { recursive: true });

const result = runPrototype(fixture, 'src/shipping.ts', { spec: 'spec.json' });
const [gap] = result.diagnostics;
assert.equal(result.diagnostics.length, 1);
assert.deepEqual(gap.verification, {
  baseline: 'passed', instrumented: 'passed', rewrite: 'passed', baselineWithWitness: 'passed', rewriteWithWitness: 'failed',
});
writeFileSync(resolve(output, 'diagnosis.json'), JSON.stringify(result, null, 2) + '\n');

for (const variant of ['existing', 'with-boundary']) {
  withCopy(fixture, root => {
    if (variant === 'with-boundary') cpSync(resolve(root, 'witness/boundary.ts'), resolve(root, 'test/boundary.test.ts'));
    const run = spawnSync(process.execPath, [stryker, 'run'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 120_000 });
    writeFileSync(resolve(output, `stryker-${variant}.log`), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
    const report = resolve(root, 'reports/mutation/mutation.json');
    cpSync(report, resolve(output, `stryker-${variant}.json`));
    const mutants = Object.values(JSON.parse(readFileSync(report, 'utf8')).files).flatMap(file => file.mutants);
    assert.ok(mutants.length > 0 && mutants.every(mutant => mutant.status === 'Killed'));
    console.log(`${variant}: ${mutants.length}/${mutants.length} standard mutants killed`);
  });
}
console.log(`TMT witness and StrykerJS JSON reports written to ${output}`);
