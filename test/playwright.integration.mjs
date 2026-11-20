import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function exec(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

function analyze(root, ...scope) {
  return JSON.parse(exec(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'src/eligibility.tsx', 'src/save.tsx',
    '--runner', 'playwright', '--spec', 'spec.json', '--audit', ...scope]));
}

test('isolated Playwright rewrites reveal an age boundary and a pending submission gap', () => {
  assert.ok(process.env.PORT, 'Run this fixture with an assigned PORT');
  const root = mkdtempSync(join(tmpdir(), 'tmt-playwright-test-'));
  try {
    cpSync('fixtures/playwright', root, { recursive: true });
    exec('git', ['-C', root, 'init', '-q']);
    exec('git', ['-C', root, 'add', '.']);
    exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    const file = join(root, 'src/eligibility.tsx');
    const changed = readFileSync(file, 'utf8').trimEnd() + ' // changed\n';
    writeFileSync(file, changed);

    const full = analyze(root);
    assert.equal(full.runner, 'playwright');
    assert.deepEqual(full.mutants.map(trial => [trial.operator, trial.status, trial.audit.status]), [
      ['<', 'survived', 'agreed'], ['||', 'survived', 'agreed'],
    ]);
    assert.deepEqual(full.diagnostics.map(gap => gap.verification), [
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
      { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' },
    ]);
    assert.ok(full.mutants.every(trial => trial.run.tests[0].browser === 'chromium'));
    assert.notEqual(full.mutants[0].run.attempt, full.mutants[1].run.attempt);

    const scoped = analyze(root, '--since', 'HEAD');
    assert.equal(scoped.mutants.length, 1);
    assert.equal(scoped.mutants[0].site, full.mutants[0].site);
    assert.equal(scoped.mutants[0].status, full.mutants[0].status);
    assert.equal(readFileSync(file, 'utf8'), changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
