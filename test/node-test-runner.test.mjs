import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { analyzeNodeAsync, verdict } from '../src/analysis.mjs';
import { classifyNodeTestEvents, runNodeTest } from '../src/node-test.mjs';
import { mergeProjectConfig } from '../src/project-config.mjs';

const pictRows = readFileSync(new URL('../verification/pict/node-test-runner.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function buildSyntheticEvents(structure, outcome, inventory) {
  const file = 'test/sample.test.mjs';
  if (outcome === 'MalformedReport') return { report: null, exitCode: 1 };
  if (outcome === 'Timeout') {
    return {
      report: {
        events: [
          { type: 'test:start', file, name: 'slow test', nesting: 0, line: 3, column: 1 },
          { type: 'test:fail', file, name: 'slow test', nesting: 0, line: 3, column: 1, testType: 'test',
            error: { message: 'test timed out', failureType: 'testTimeoutFailure' } },
        ],
        summary: { success: false, counts: { tests: 1, failed: 1, passed: 0 } },
      },
      exitCode: 1,
    };
  }
  if (outcome === 'ModuleLoadError') {
    return {
      report: {
        events: [
          { type: 'test:start', file, name: file, nesting: 0, line: 1, column: 1 },
          { type: 'test:fail', file, name: file, nesting: 0, line: 1, column: 1,
            error: { message: 'load sentinel', failureType: 'testCodeFailure' } },
        ],
        summary: { success: false, counts: { tests: 1, failed: 1, passed: 0 } },
      },
      exitCode: 1,
    };
  }
  if (outcome === 'MissingFiles') {
    return {
      report: {
        events: [
          { type: 'test:start', file: 'test/other.test.mjs', name: 'other', nesting: 0, line: 3, column: 1 },
          { type: 'test:pass', file: 'test/other.test.mjs', name: 'other', nesting: 0, line: 3, column: 1, testType: 'test' },
        ],
        summary: { success: true, counts: { tests: 1, failed: 0, passed: 1 } },
      },
      exitCode: 0,
    };
  }

  const events = [];
  const failFirst = outcome === 'FailedAssertion';
  const hookErr = outcome === 'HookError';

  if (structure === 'NestedDescribe') {
    events.push({ type: 'test:start', file, name: 'suite', nesting: 0, line: 2, column: 1 });
    if (hookErr) {
      events.push({ type: 'test:fail', file, name: 'suite', nesting: 0, line: 2, column: 1, testType: 'suite',
        error: { message: 'before hook boom', failureType: 'hookFailed' } });
    } else {
      const names = inventory === 'MissingTest' ? ['a']
        : inventory === 'ExtraTest' ? ['a', 'b', 'c']
          : inventory === 'RenamedTest' ? ['a-renamed', 'b']
            : ['a', 'b'];
      for (let i = 0; i < names.length; i++) {
        events.push({ type: 'test:start', file, name: names[i], nesting: 1, line: 3 + i, column: 3 });
        if (failFirst && i === 0) {
          events.push({ type: 'test:fail', file, name: names[i], nesting: 1, line: 3 + i, column: 3, testType: 'test',
            error: { message: 'expected 1 to equal 2', failureType: 'testCodeFailure', code: 'ERR_ASSERTION' } });
        } else {
          events.push({ type: 'test:pass', file, name: names[i], nesting: 1, line: 3 + i, column: 3, testType: 'test' });
        }
      }
      if (failFirst) {
        events.push({ type: 'test:fail', file, name: 'suite', nesting: 0, line: 2, column: 1, testType: 'suite',
          error: { message: '1 subtest failed', failureType: 'subtestsFailed' } });
      } else {
        events.push({ type: 'test:pass', file, name: 'suite', nesting: 0, line: 2, column: 1, testType: 'suite' });
      }
    }
  } else if (structure === 'DuplicateNames') {
    const names = inventory === 'MissingTest' ? ['dup']
      : inventory === 'ExtraTest' ? ['dup', 'dup', 'dup']
        : inventory === 'RenamedTest' ? ['dup-x', 'dup']
          : ['dup', 'dup'];
    for (let i = 0; i < names.length; i++) {
      events.push({ type: 'test:start', file, name: names[i], nesting: 0, line: 3 + i, column: 1 });
      if (failFirst && i === 0) {
        events.push({ type: 'test:fail', file, name: names[i], nesting: 0, line: 3 + i, column: 1, testType: 'test',
          error: { message: 'dup failed', failureType: 'testCodeFailure', code: 'ERR_ASSERTION' } });
      } else {
        events.push({ type: 'test:pass', file, name: names[i], nesting: 0, line: 3 + i, column: 1, testType: 'test' });
      }
    }
  } else if (structure === 'SkippedAndTodo') {
    const cases = [
      { name: 'runs', kind: 'run' },
      { name: 'skip-me', kind: 'skip' },
      { name: 'todo-me', kind: 'todo' },
    ];
    const chosen = inventory === 'MissingTest' ? cases.slice(0, 2)
      : inventory === 'ExtraTest' ? [...cases, { name: 'extra', kind: 'run' }]
        : inventory === 'RenamedTest' ? [{ name: 'runs-x', kind: 'run' }, cases[1], cases[2]]
          : cases;
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      events.push({ type: 'test:start', file, name: c.name, nesting: 0, line: 3 + i, column: 1 });
      if (c.kind === 'skip') {
        events.push({ type: 'test:pass', file, name: c.name, nesting: 0, line: 3 + i, column: 1, testType: 'test', skip: true });
      } else if (c.kind === 'todo') {
        events.push({ type: 'test:pass', file, name: c.name, nesting: 0, line: 3 + i, column: 1, testType: 'test', todo: true });
      } else if (failFirst && i === 0) {
        events.push({ type: 'test:fail', file, name: c.name, nesting: 0, line: 3 + i, column: 1, testType: 'test',
          error: { message: 'assertion failed', failureType: 'testCodeFailure', code: 'ERR_ASSERTION' } });
      } else {
        events.push({ type: 'test:pass', file, name: c.name, nesting: 0, line: 3 + i, column: 1, testType: 'test' });
      }
    }
  } else {
    // Flat
    const names = inventory === 'MissingTest' ? ['t1']
      : inventory === 'ExtraTest' ? ['t1', 't2', 't3']
        : inventory === 'RenamedTest' ? ['t1-renamed', 't2']
          : ['t1', 't2'];
    for (let i = 0; i < names.length; i++) {
      events.push({ type: 'test:start', file, name: names[i], nesting: 0, line: 3 + i, column: 1 });
      if (hookErr && i === 0) {
        events.push({ type: 'test:fail', file, name: names[i], nesting: 0, line: 3 + i, column: 1, testType: 'test',
          error: { message: 'hook failure', failureType: 'hookFailed' } });
      } else if (failFirst && i === 0) {
        events.push({ type: 'test:fail', file, name: names[i], nesting: 0, line: 3 + i, column: 1, testType: 'test',
          error: { message: 'assertion failed', failureType: 'testCodeFailure', code: 'ERR_ASSERTION' } });
      } else {
        events.push({ type: 'test:pass', file, name: names[i], nesting: 0, line: 3 + i, column: 1, testType: 'test' });
      }
    }
  }

  const failed = failFirst || hookErr;
  return {
    report: { events, summary: { success: !failed, counts: { tests: events.length } } },
    exitCode: failed ? 1 : 0,
  };
}

for (const [outcome, structure, inventory] of pictRows) {
  test(`node:test classification PICT: ${outcome} / ${structure} / ${inventory}`, () => {
    const baseInput = buildSyntheticEvents(structure, 'Passed', 'MatchesBaseline');
    const baseline = classifyNodeTestEvents(baseInput.report, baseInput.exitCode, ['test/sample.test.mjs']);
    assert.equal(baseline.status, 'passed');
    if (structure === 'SkippedAndTodo') {
      assert.deepEqual(baseline.tests.map(t => t.status), ['passed', 'skipped', 'todo']);
    }
    if (structure === 'DuplicateNames') {
      assert.equal(new Set(baseline.tests.map(t => t.id)).size, 2);
    }

    const trialInput = buildSyntheticEvents(structure, outcome, inventory);
    const trial = classifyNodeTestEvents(trialInput.report, trialInput.exitCode, ['test/sample.test.mjs']);
    const v = verdict(trial, baseline);

    if (outcome === 'Timeout') {
      assert.equal(trial.status, 'timeout');
      assert.equal(v, 'timeout');
    } else if (outcome === 'ModuleLoadError') {
      assert.equal(trial.status, 'error');
      assert.equal(trial.moduleErrors.length, 1);
      assert.equal(trial.fileErrors[0].file, 'test/sample.test.mjs');
      assert.equal(v, 'error');
    } else if (outcome === 'HookError' || outcome === 'MalformedReport' || outcome === 'MissingFiles') {
      assert.equal(trial.status, 'error');
      assert.equal(v, 'error');
    } else if (inventory !== 'MatchesBaseline') {
      assert.equal(v, 'unstable');
    } else if (outcome === 'Passed') {
      assert.equal(v, 'survived');
    } else if (outcome === 'FailedAssertion') {
      assert.equal(v, 'killed');
    }
  });
}

test('runNodeTest distinguishes pass, assertion kill, module load error, hook error, and timeout on real processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-node-runner-int-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
    writeFileSync(join(dir, 'src/math.mjs'), 'export function isAdult(age) { return age >= 18; }\n');
    writeFileSync(join(dir, 'test/math.test.mjs'), `
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAdult } from '../src/math.mjs';
describe('isAdult', () => {
  it('checks boundary', () => {
    assert.equal(isAdult(20), true);
    assert.equal(isAdult(10), false);
  });
  it('checks boundary', () => {
    assert.equal(isAdult(18), true);
  });
  it.skip('skipped case', () => {});
  it.todo('todo case');
});
`);

    const passRun = runNodeTest(dir, dir, { testFiles: ['test/math.test.mjs'], timeout: 10_000 });
    assert.equal(passRun.status, 'passed');
    assert.deepEqual(passRun.files, ['test/math.test.mjs']);
    assert.equal(passRun.tests.length, 4);
    assert.equal(new Set(passRun.tests.map(t => t.id)).size, 4);
    assert.deepEqual(passRun.tests.map(t => t.status), ['passed', 'passed', 'skipped', 'todo']);

    // Mutate >= to > -> killed by the second duplicate-named test!
    writeFileSync(join(dir, 'src/math.mjs'), 'export function isAdult(age) { return age > 18; }\n');
    const killRun = runNodeTest(dir, dir, { testFiles: ['test/math.test.mjs'], timeout: 10_000 });
    assert.equal(killRun.status, 'failed');
    assert.equal(verdict(killRun, passRun), 'killed');

    // Module load error -> error (NOT killed!)
    writeFileSync(join(dir, 'src/math.mjs'), 'throw new Error("boom at import");\nexport function isAdult(age) { return age >= 18; }\n');
    const loadErrRun = runNodeTest(dir, dir, { testFiles: ['test/math.test.mjs'], timeout: 10_000 });
    assert.equal(loadErrRun.status, 'error');
    assert.equal(loadErrRun.moduleErrors.length, 1);
    assert.equal(loadErrRun.fileErrors[0].file, 'test/math.test.mjs');
    assert.equal(verdict(loadErrRun, passRun), 'error');

    // Infinite loop -> timeout with statusReason
    writeFileSync(join(dir, 'src/math.mjs'), 'for (;;) {}\nexport function isAdult(age) { return age >= 18; }\n');
    const timeoutRun = runNodeTest(dir, dir, { testFiles: ['test/math.test.mjs'], timeout: 1_500 });
    assert.equal(timeoutRun.status, 'timeout');
    assert.match(timeoutRun.statusReason, /Node test (?:runner timed out|timeout)/);
    assert.equal(verdict(timeoutRun, passRun), 'timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeNodeAsync runs targeted mutations and emits SURVIVED diagnostics with equivalence hints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-node-analyze-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
    writeFileSync(join(dir, 'src/calc.mjs'), `
export function isAdult(age) {
  return age >= 18;
}
export function shardSize(items, total) {
  return Math.floor(items.length / total);
}
`);
    writeFileSync(join(dir, 'test/calc.test.mjs'), `
import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdult, shardSize } from '../src/calc.mjs';
test('adult checks', () => {
  assert.equal(isAdult(20), true);
  assert.equal(isAdult(10), false);
});
test('shard size', () => {
  assert.equal(shardSize([1, 2, 3, 4, 5], 2), 2);
});
`);
    const report = await analyzeNodeAsync(dir, ['src/calc.mjs'], {
      runner: 'node',
      mutators: 'targeted',
      test: ['test/calc.test.mjs'],
      concurrency: 2,
      timeout: 15,
    });
    assert.equal(report.runner, 'node');
    assert.equal(report.evaluation, 'evaluated');
    assert.equal(report.baseline.tests, 2);
    const boundary = report.mutants.find(m => m.rule === 'comparison-boundary/v1' && m.replacement === '>');
    assert.equal(boundary?.status, 'survived');
    const floorTruncDiag = report.diagnostics.find(d => d.rule === 'rounding-swap/v1' && d.mutations?.[0]?.replacement?.includes('Math.trunc'));
    assert.ok(floorTruncDiag, 'expected surviving floor->trunc diagnostic');
    assert.equal(floorTruncDiag.equivalenceHint, 'likely-equivalent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI validates --runner node flags and supports runner in project config', () => {
  const bin = resolve('bin/tmt.mjs');
  for (const badArgs of [
    ['analyze', '--runner', 'node', '--related'],
    ['analyze', '--runner', 'node', '--suggest-assertions'],
    ['analyze', '--runner', 'node', '--displace-thresholds'],
    ['analyze', '--runner', 'node', '--isolated-trials'],
    ['analyze', '--runner', 'node', '--witnesses'],
    ['analyze', '--runner', 'node', '--config', 'vitest.config.ts'],
    ['analyze', '--runner', 'node', '--audit'],
    ['analyze', '--runner', 'jest'],
  ]) {
    assert.throws(() => execFileSync(process.execPath, [bin, ...badArgs], { stdio: 'pipe' }), /Error|Command failed/);
  }
  const merged = mergeProjectConfig({ runner: 'node', tests: ['test/*.test.mjs'] }, {}, []);
  assert.equal(merged.values.runner, 'node');
  assert.deepEqual(merged.values.test, ['test/*.test.mjs']);
});

test('helper-registered tests, checkpoint resume, stderr load details, and all-skipped baseline work on --runner node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-node-edge-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
    writeFileSync(join(dir, 'src/check.mjs'), 'export function ok(n) { return n >= 10; }\n');
    writeFileSync(join(dir, 'test/helper.mjs'), `
import assert from 'node:assert/strict';
import { it } from 'node:test';
export function registerBoundary(fn, val, expected) {
  it('helper check ' + val, () => assert.equal(fn(val), expected));
}
`);
    writeFileSync(join(dir, 'test/a.test.mjs'), `
import { describe } from 'node:test';
import { ok } from '../src/check.mjs';
import { registerBoundary } from './helper.mjs';
describe('suite a', () => { registerBoundary(ok, 10, true); });
`);
    writeFileSync(join(dir, 'test/b.test.mjs'), `
import { describe } from 'node:test';
import { ok } from '../src/check.mjs';
import { registerBoundary } from './helper.mjs';
describe('suite b', () => { registerBoundary(ok, 5, false); });
`);

    // 1. Helper-registered tests across two selected files must not trigger selection mismatch
    const run = runNodeTest(dir, dir, { testFiles: ['test/a.test.mjs', 'test/b.test.mjs'], timeout: 10_000 });
    assert.equal(run.status, 'passed');
    assert.deepEqual(run.files, ['test/a.test.mjs', 'test/b.test.mjs']);
    assert.equal(run.tests.length, 2);
    assert.ok(run.tests.every(t => t.name.includes(' > helper check ')));

    // 2. Checkpoint resume restores full mutant metadata (location, rule, edit, replacement, statusReason)
    const { analyzeOperators } = await import('../src/operator-analysis.mjs');
    const ckptFile = join(dir, 'ckpt.jsonl');
    const first = await analyzeOperators(dir, ['src/check.mjs'], {
      runner: 'node', mutators: 'targeted', test: ['test/a.test.mjs', 'test/b.test.mjs'], checkpoint: ckptFile, timeout: 15,
    });
    assert.equal(first.evaluation, 'evaluated');
    const second = await analyzeOperators(dir, ['src/check.mjs'], {
      runner: 'node', mutators: 'targeted', test: ['test/a.test.mjs', 'test/b.test.mjs'], checkpoint: ckptFile, timeout: 15,
    });
    assert.equal(second.evaluation, 'evaluated');
    assert.equal(second.checkpoint.resumed, true);
    assert.equal(second.mutants.length, first.mutants.length);
    for (let i = 0; i < first.mutants.length; i++) {
      assert.deepEqual(second.mutants[i].location, first.mutants[i].location);
      assert.equal(second.mutants[i].rule, first.mutants[i].rule);
      assert.deepEqual(second.mutants[i].edit, first.mutants[i].edit);
      assert.equal(second.mutants[i].replacement, first.mutants[i].replacement);
      assert.equal(second.mutants[i].status, first.mutants[i].status);
    }

    // 3. Baseline error on missing import surfaces real stderr detail in fileErrors
    writeFileSync(join(dir, 'test/broken.test.mjs'), "import './does-not-exist.mjs';\n");
    const broken = await analyzeNodeAsync(dir, ['src/check.mjs'], {
      runner: 'node', mutators: 'targeted', test: ['test/broken.test.mjs'], timeout: 10,
    });
    assert.equal(broken.evaluation, 'baseline_error');
    assert.equal(broken.baseline.fileErrors?.[0]?.file, 'test/broken.test.mjs');
    assert.match(broken.baseline.fileErrors?.[0]?.message ?? '', /ERR_MODULE_NOT_FOUND|Cannot find module/);

    // 4. All-skipped baseline surfaces statusReason in baseline.errors
    writeFileSync(join(dir, 'test/skipped.test.mjs'), "import { it } from 'node:test'; it.skip('only skipped', () => {});\n");
    const skipped = await analyzeNodeAsync(dir, ['src/check.mjs'], {
      runner: 'node', mutators: 'targeted', test: ['test/skipped.test.mjs'], timeout: 10,
    });
    assert.equal(skipped.evaluation, 'baseline_error');
    assert.match(skipped.baseline.statusReason ?? '', /executed no tests/);
    assert.ok(skipped.baseline.errors.some(err => /executed no tests/.test(err)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-dogfooding: CLI --runner node analyzes TMT src/source-text.mjs with unmodified test/source-text.test.mjs', () => {
  const bin = resolve('bin/tmt.mjs');
  const stdout = execFileSync(process.execPath, [
    bin, 'analyze', '--runner', 'node', '--no-config', '--format', 'json',
    '--test', 'test/source-text.test.mjs',
    '--lines', 'src/source-text.mjs:1-25',
    '--concurrency', '2',
    '--copy-exclude', 'build',
    '--copy-exclude', 'proof',
    '--copy-exclude', 'fixtures',
    '.', 'src/source-text.mjs',
  ], { encoding: 'utf8', timeout: 60_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.runner, 'node');
  assert.equal(report.evaluation, 'evaluated');
  assert.ok(report.baseline.tests >= 4);
  assert.ok(report.mutants.length >= 1);
  assert.ok(report.mutants.some(m => m.status === 'killed'));
});
