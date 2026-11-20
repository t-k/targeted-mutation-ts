import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { arch, cpus, platform, release } from 'node:os';

const modes = {
  'full-scope / source replay': [],
  'full-scope / Lean replay': ['--deterministic'],
  'line-scope / source replay': ['--lines', 'src/eligibility.ts:1-1'],
  'line-scope / Lean replay': ['--lines', 'src/eligibility.ts:1-1', '--deterministic'],
};
const fixture = ['bin/tmt.mjs', 'analyze', 'fixtures/eligibility', 'src/eligibility.ts', '--spec', 'spec.json'];
const repetitions = 5;
const results = Object.fromEntries(Object.keys(modes).map(mode => [mode, []]));
let expected;
for (let repeat = 0; repeat < repetitions; repeat++) {
  const entries = Object.entries(modes);
  if (repeat % 2) entries.reverse();
  for (const [mode, flags] of entries) {
    const start = performance.now();
    const run = spawnSync(process.execPath, [...fixture, ...flags], { encoding: 'utf8', timeout: 30_000 });
    const elapsedMs = performance.now() - start;
    assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
    const report = JSON.parse(run.stdout);
    const outcome = report.mutants.map(trial => [trial.site, trial.status]);
    if (!expected) expected = outcome;
    assert.deepEqual(outcome, expected);
    assert.equal(report.diagnostics[0]?.suggestedTest, 'expect(eligible(18)).toBe(true)');
    results[mode].push({ elapsedMs, evidence: report.mutants[0].evidence, tests: report.baseline.tests });
  }
}
console.log(JSON.stringify({
  node: process.version, os: [platform(), release(), arch()].join(' '), cpu: cpus()[0]?.model, repetitions,
  startup: 'new process per run, warmed filesystem caches',
  modes: Object.entries(results).map(([mode, runs]) => {
    const sorted = runs.map(run => run.elapsedMs).sort((a, b) => a - b);
    return { mode, evidence: runs[0].evidence, baselineTests: runs[0].tests, medianMs: sorted[2], minMs: sorted[0], maxMs: sorted.at(-1) };
  }),
}, null, 2));
