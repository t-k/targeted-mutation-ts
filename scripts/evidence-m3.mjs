import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analysis.mjs';
import { withCopy } from '../src/vitest.mjs';

const fixture = fileURLToPath(new URL('../fixtures/playwright', import.meta.url));
const output = resolve(process.argv[2] ?? 'build/evidence/m3');
const stryker = fileURLToPath(import.meta.resolve('@stryker-mutator/core/package.json')).replace(/package\.json$/, 'bin/stryker.js');
if (!process.env.PORT) throw new Error('Assign PORT before running this fixture');
mkdirSync(output, { recursive: true });

const analysis = analyze(fixture, ['src/eligibility.tsx', 'src/save.tsx'], { runner: 'playwright', spec: 'spec.json', audit: true });
assert.equal(analysis.evaluation, 'evaluated', analysis.baseline?.output);
assert.deepEqual(analysis.diagnostics.map(gap => gap.verification), [
  { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
  { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
]);
writeFileSync(resolve(output, 'analysis.json'), JSON.stringify(analysis, null, 2));

for (const variant of ['existing', 'with-pending']) {
  withCopy(fixture, root => {
    if (variant === 'with-pending') cpSync(resolve(root, 'variants/pending.ts'), resolve(root, 'e2e/pending.spec.ts'));
    const run = spawnSync(process.execPath, [stryker, 'run'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 150_000 });
    writeFileSync(resolve(output, `stryker-${variant}.log`), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
    const report = resolve(root, 'reports/mutation/mutation.json');
    cpSync(report, resolve(output, `stryker-${variant}.json`));
    const mutants = Object.values(JSON.parse(readFileSync(report, 'utf8')).files).flatMap(file => file.mutants);
    console.log(variant, mutants.map(mutant => [mutant.replacement, mutant.status]));
  });
}
