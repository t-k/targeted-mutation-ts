import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const cli = (...args) => spawnSync(process.execPath, ['bin/tmt.mjs', ...args], { encoding: 'utf8', timeout: 120_000 });
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function withProject(run) {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-cli-usability-'));
  try {
    const project = join(scratch, 'fixtures', 'eligibility');
    cpSync('fixtures/eligibility', project, { recursive: true });
    symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'junction');
    return run(project);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const flag of ['--version', '-v']) {
  test(`${flag} prints the package version`, () => {
    const run = cli(flag);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${version}\n`);
  });
}

test('a version flag after a command still prints the version', () => {
  assert.equal(cli('analyze', '--version').stdout, `${version}\n`);
});

test('an unknown command is named before the usage', () => {
  const run = cli('analyse');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Unknown command: analyse\n\nUsage: targeted-mutation /);
  assert.equal(run.stdout, '');
});

test('a known command with the wrong arguments says so', () => {
  const run = cli('extract');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Unexpected arguments for extract\.\n\nUsage: /);
});

test('an unknown report format fails before any test run', () => {
  const run = cli('analyze', 'fixtures/eligibility', 'src/eligibility.ts', '--format', 'yaml');
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'Expected --format text|json\n');
});

test('a single line selects the same site as a one-line range', () => {
  const [single, range] = ['1', '1-1'].map(lines => {
    const run = cli('analyze', 'fixtures/eligibility', '--lines', `src/eligibility.ts:${lines}`);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  });
  assert.ok(single.mutants.length > 0);
  assert.deepEqual(single.mutants, range.mutants);
  for (const malformed of ['src/eligibility.ts', 'src/eligibility.ts:0', 'src/eligibility.ts:2-1', 'src/eligibility.ts:1-']) {
    const run = cli('analyze', 'fixtures/eligibility', '--lines', malformed);
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'Expected --lines FILE:FROM-TO\n');
  }
});

test('a piped analysis prints JSON and --format text prints the readable report', () => {
  const piped = cli('analyze', 'fixtures/eligibility', 'src/eligibility.ts');
  assert.equal(piped.status, 0, piped.stderr);
  const report = JSON.parse(piped.stdout);
  assert.equal(report.evaluation, 'evaluated');
  const text = cli('analyze', 'fixtures/eligibility', 'src/eligibility.ts', '--format', 'text');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^src\/eligibility\.ts:1:\d+ {2}survived {2}comparison-boundary\/v1: >= -> >$/m);
  assert.match(text.stdout, /^ {2}suggested test: expect\(eligible\(18\)\)\.toBe\(true\)$/m);
  assert.match(text.stdout, new RegExp(`^vitest, 2 baseline tests: ${report.mutants.length} edits .*${report.diagnostics.length} test gaps$`, 'm'));
});

test('a failed baseline names the failed test in both formats', () => withProject(project => {
  writeFileSync(join(project, 'test/broken.test.ts'),
    "import { expect, it } from 'vitest'; it('adds', () => expect(1 + 1).toBe(3));");
  const json = cli('analyze', project, 'src/eligibility.ts');
  assert.equal(json.status, 1, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.evaluation, 'baseline_error');
  assert.equal(report.baseline.status, 'failed');
  assert.equal(report.baseline.failedTests.length, 1);
  const [failed] = report.baseline.failedTests;
  assert.deepEqual([failed.file, failed.name], ['test/broken.test.ts', 'adds']);
  assert.match(failed.failures[0], /expected 2 to be 3/);
  const text = cli('analyze', project, 'src/eligibility.ts', '--format', 'text');
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^ {2}FAILED test\/broken\.test\.ts > adds\n {4}.*expected 2 to be 3/m);
}));

test('--concurrency and --isolated-trials are checked before anything runs', () => {
  for (const value of ['0', '-1', '1.5', 'many', '']) {
    const run = cli('analyze', 'fixtures/eligibility', `--concurrency=${value}`);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Expected --concurrency to be a positive integer/);
  }
  for (const excluded of [['--witnesses'], ['--audit'], ['--runner', 'playwright']]) {
    const isolated = cli('analyze', 'fixtures/eligibility', ...excluded, '--isolated-trials');
    assert.equal(isolated.status, 1);
    assert.match(isolated.stderr, /apply to Vitest sessions/);
  }
  // --witnesses runs its suites side by side, so it takes a concurrency too.
  for (const excluded of [['--audit'], ['--runner', 'playwright']]) {
    const run = cli('analyze', 'fixtures/eligibility', ...excluded, '--concurrency', '2');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--concurrency applies to Vitest sessions and to --witnesses/);
  }
  assert.match(cli('analyze', 'fixtures/eligibility', '--verify-trials', 'some').stderr, /Expected --verify-trials to be a count/);
  assert.match(cli('analyze', 'fixtures/eligibility', '--audit', '--verify-trials', '2').stderr, /apply to Vitest sessions/);
  assert.match(cli('--help').stdout, /--concurrency N[\s\S]*--isolated-trials/);
});

function scratchProject(files, run) {
  const project = mkdtempSync(join(tmpdir(), 'tmt-cli-project-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
    return run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test('a trial in which the runner breaks down makes the analysis incomplete and the command fail', () => scratchProject({
  'subject.ts': 'export const adult = (n: number) => n >= 18;\n',
  // With the boundary edit the test kills the runner instead of failing an assertion.
  'subject.test.ts': `import { expect, it } from 'vitest';
import { adult } from './subject';
it('adult', () => { if (!adult(18)) process.kill(process.pid, 'SIGKILL'); expect(adult(18)).toBe(true); expect(adult(17)).toBe(false); });
`,
}, project => {
  const run = cli('analyze', project, 'subject.ts', '--format', 'json');
  const report = JSON.parse(run.stdout);
  assert.equal(report.mutants.find(mutant => mutant.replacement === '>').status, 'error');
  assert.equal(report.evaluation, 'incomplete');
  assert.equal(run.status, 1);
  const text = cli('analyze', project, 'subject.ts', '--format', 'text');
  assert.match(text.stdout, /evaluation incomplete/);
  assert.equal(text.status, 1);
}));

test('--timeout bounds one run of the suite and is checked before anything runs', () => scratchProject({
  'subject.ts': 'export const adult = (n: number) => n >= 18;\n',
  'subject.test.ts': `import { expect, it } from 'vitest';
import { adult } from './subject';
it('slow', async () => { await new Promise(resolve => setTimeout(resolve, 6000)); expect(adult(18)).toBe(true); }, 20000);
`,
}, project => {
  for (const value of ['0', '1.5', 'soon', '-3']) {
    assert.match(cli('analyze', project, `--timeout=${value}`).stderr, /Expected --timeout to be a number of seconds/);
  }
  const started = Date.now();
  const short = cli('analyze', project, 'subject.ts', '--timeout', '2', '--format', 'json');
  const report = JSON.parse(short.stdout);
  assert.deepEqual([report.evaluation, report.baseline.status, short.status], ['baseline_error', 'timeout', 1]);
  assert.ok(Date.now() - started < 30_000);
  // With room for the slow test the same suite is analyzed.
  const long = JSON.parse(cli('analyze', project, 'subject.ts', '--timeout', '90', '--format', 'json').stdout);
  assert.equal(long.evaluation, 'evaluated');
  assert.ok(long.mutants.length >= 1);
}));
