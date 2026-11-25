import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatProgressSummary, renderText, summarizeReport } from '../src/cli-output.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/shipping', import.meta.url));
const scenarios = readFileSync(new URL('../verification/pict/dual-output-summary.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

const countOf = label => ({ Zero: 0, One: 1, Many: 3 }[label]);

function buildReport(profile, gapCount, otherSurvivors) {
  const location = { file: 'src/app.ts', line: 10, column: 5, start: 100, end: 110 };
  const mutants = [];
  const diagnostics = [];
  for (let i = 0; i < gapCount; i++) {
    const id = `t${i}`;
    mutants.push({
      ...(profile === 'full' ? { id, mutatorName: 'nullish-fallback/v1' } : { site: id, rule: 'nullish-fallback/v1' }),
      location: { ...location, line: 10 + i },
      original: 'a ?? b',
      replacement: '(a || b)',
      status: 'survived',
    });
    diagnostics.push({
      kind: 'INPUT GAP',
      site: id,
      rule: 'nullish-fallback/v1',
      location: { ...location, line: 10 + i },
      expression: 'a ?? b',
      mutations: [{ rule: 'nullish-fallback/v1', replacement: '(a || b)' }],
    });
  }
  for (let i = 0; i < otherSurvivors; i++) {
    mutants.push({
      id: `s${i}`,
      mutatorName: 'StringLiteral',
      location: { ...location, line: 30 + i },
      original: '"hello"',
      replacement: '""',
      status: 'survived',
    });
  }
  mutants.push({
    ...(profile === 'full' ? { id: 'k0', mutatorName: 'ArithmeticOperator' } : { site: 'k0', rule: 'arithmetic-swap/v1' }),
    location: { ...location, line: 50 },
    original: 'a + b',
    replacement: 'a - b',
    status: 'killed',
  });
  return {
    schemaVersion: 1,
    runner: 'vitest',
    mutators: profile,
    evaluation: 'evaluated',
    baseline: { status: 'passed', tests: gapCount === 1 ? 1 : 10 },
    extraction: [],
    mutants,
    diagnostics,
  };
}

for (const [stdoutFormat, jsonOut, sarifOut, profileLabel, gapLabel, otherLabel] of scenarios) {
  test(`dual-output-summary PICT: ${stdoutFormat} jsonOut=${jsonOut} sarifOut=${sarifOut} ${profileLabel} gaps=${gapLabel} other=${otherLabel}`, () => {
    const profile = profileLabel.toLowerCase();
    const gapCount = countOf(gapLabel);
    const otherCount = countOf(otherLabel);
    const report = buildReport(profile, gapCount, otherCount);
    const summary = summarizeReport(report);
    assert.equal(summary.gaps, gapCount);
    assert.equal(summary.otherSurvivors, otherCount);

    const text = renderText(report);
    const progress = formatProgressSummary(report);
    const gapWord = gapCount === 1 ? 'gap' : 'gaps';
    const otherWord = otherCount === 1 ? 'other survivor' : 'other survivors';
    if (otherCount > 0) {
      assert.match(text, new RegExp(`${gapCount} targeted ${gapWord} \\(${otherCount} ${otherWord}\\)$`));
      assert.match(progress, new RegExp(`${gapCount} targeted ${gapWord}, ${otherCount} ${otherWord}\\).$`));
    } else {
      assert.match(text, new RegExp(`${gapCount} test ${gapWord}$`));
      assert.match(progress, new RegExp(`${gapCount} ${gapWord}\\).$`));
    }
  });
}

test('CLI writes --json-out and --sarif-out while printing --format text to stdout', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-dual-out-'));
  try {
    const jsonPath = resolve(dir, 'nested/report.json');
    const sarifPath = resolve(dir, 'nested/report.sarif');
    const run = spawnSync(process.execPath, [
      cli, 'analyze', fixture, 'src/shipping.ts',
      '--format', 'text',
      '--json-out', jsonPath,
      '--sarif-out', sarifPath,
      '--progress',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /vitest, \d+ baseline tests?:/);
    assert.match(run.stderr, /\[tmt\] Completed \(evaluated, \d+ edits?, \d+ gaps?\)\./);
    assert.ok(existsSync(jsonPath));
    assert.ok(existsSync(sarifPath));

    const jsonReport = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(jsonReport.runner, 'vitest');
    assert.equal(jsonReport.evaluation, 'evaluated');

    const sarifReport = JSON.parse(readFileSync(sarifPath, 'utf8'));
    assert.equal(sarifReport.version, '2.1.0');
    assert.equal(sarifReport.runs[0].tool.driver.name, 'targeted-mutation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects empty or NUL output paths for --json-out and --sarif-out', () => {
  for (const flag of ['--json-out', '--sarif-out']) {
    const empty = spawnSync(process.execPath, [cli, 'analyze', fixture, 'src/shipping.ts', flag, '   '], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /valid file path/);
  }
});

test('CLI rejects colliding output paths across --json-out, --sarif-out, --write-baseline, and --checkpoint', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-out-collide-'));
  try {
    const target = resolve(dir, 'report.out');
    const same = spawnSync(process.execPath, [
      cli, 'analyze', fixture, 'src/shipping.ts',
      '--json-out', target,
      '--sarif-out', resolve(dir, './report.out'),
    ], { encoding: 'utf8' });
    assert.equal(same.status, 1);
    assert.match(same.stderr, /Output paths must be distinct/);

    const withCkpt = spawnSync(process.execPath, [
      cli, 'analyze', fixture, 'src/shipping.ts',
      '--json-out', target,
      '--checkpoint', target,
    ], { encoding: 'utf8' });
    assert.equal(withCkpt.status, 1);
    assert.match(withCkpt.stderr, /Output paths must be distinct/);

    // Symlink ancestor with uncreated nested directory
    const realDir = resolve(dir, 'real');
    const aliasDir = resolve(dir, 'alias');
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, 'dir');
    const viaSymlink = spawnSync(process.execPath, [
      cli, 'analyze', fixture, 'src/shipping.ts',
      '--json-out', resolve(aliasDir, 'nested/report.out'),
      '--sarif-out', resolve(realDir, 'nested/report.out'),
    ], { encoding: 'utf8' });
    assert.equal(viaSymlink.status, 1);
    assert.match(viaSymlink.stderr, /Output paths must be distinct/);

    // Hardlink to the same existing file
    const fileA = resolve(dir, 'a.out');
    const fileB = resolve(dir, 'b.out');
    writeFileSync(fileA, 'keep');
    linkSync(fileA, fileB);
    const hardlink = spawnSync(process.execPath, [
      cli, 'analyze', fixture, 'src/shipping.ts',
      '--json-out', fileA,
      '--sarif-out', fileB,
    ], { encoding: 'utf8' });
    assert.equal(hardlink.status, 1);
    assert.match(hardlink.stderr, /Output paths must be distinct/);
    assert.equal(readFileSync(fileA, 'utf8'), 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
