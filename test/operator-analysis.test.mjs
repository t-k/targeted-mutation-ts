import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = `export function price(quantity: number, unit: number, member: boolean): number {
  const total = quantity * unit;
  if (member === true && total >= 100) return total - 10;
  return total;
}
export function unused(a: number, b: number): number {
  return a + b;
}
`;
const suite = `import { expect, it } from 'vitest';
import { price } from '../src/price';
it('charges the plain total', () => expect(price(2, 30, false)).toBe(60));
it('discounts a large member order', () => expect(price(4, 30, true)).toBe(110));
`;

function analyze(...args) {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-operator-analysis-'));
  try {
    const project = join(scratch, 'project');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'test'));
    writeFileSync(join(project, 'src/price.ts'), source);
    writeFileSync(join(project, 'test/price.test.ts'), suite);
    symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'junction');
    return spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', project, 'src/price.ts', ...args],
      { encoding: 'utf8', timeout: 240_000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('the default profile is targeted and reports both comparison gaps and targeted rules in one session', () => {
  const run = analyze();
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.deepEqual([report.mutators, report.operatorExecution, report.evaluation], ['targeted', 'session', 'evaluated']);
  assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-boundary/v1' && mutant.status === 'survived'));
  assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-threshold/v1' && mutant.replacement === '99' && mutant.status === 'survived'));
  assert.ok(report.mutants.some(mutant => mutant.rule === 'arithmetic-swap/v1' && mutant.location.line === 2 && mutant.status === 'killed'));
  assert.ok(report.mutants.some(mutant => mutant.rule === 'arithmetic-swap/v1' && mutant.location.line === 7 && mutant.status === 'unreached'));
  assert.ok(report.diagnostics.some(gap => gap.kind === 'INPUT GAP' && gap.location.line === 3));
  assert.deepEqual(report.instrumented, { status: 'passed' });
});

test('the text report shows targeted edits clearly', () => {
  const run = analyze('--lines', 'src/price.ts:7', '--format', 'text');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /^src\/price\.ts:7:10 {2}unreached {2}arithmetic-swap\/v1: a \+ b -> \(a - b\)$/m);
});

test('removed profiles and empty flags are rejected and PICT profile-dispatch matrix routes cleanly', () => {
  const rows = readFileSync(new URL('../verification/pict/profile-dispatch.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const seeds = readFileSync(new URL('../verification/pict/profile-dispatch.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows);
  for (const seed of seeds) assert.ok(table.has(seed), seed);

  for (const removed of ['', 'focused', 'operators', 'standard', 'all', 'everything']) {
    const unknown = analyze(`--mutators=${removed}`);
    assert.equal(unknown.status, 1, removed);
    assert.equal(unknown.stderr, 'Expected --mutators targeted|full\n');
  }
  assert.equal(analyze('--runner=').stderr, 'Expected --runner vitest|playwright\n');
  for (const profile of ['targeted', 'full']) {
    const witnesses = analyze('--mutators', profile, '--witnesses');
    assert.equal(witnesses.status, 1);
    assert.equal(witnesses.stderr, '--witnesses runs its own Vitest source trials\n');
  }
  // Drive representative PICT rows for invalid combinations and flag rejection before test execution.
  for (const line of rows) {
    const [mutators, runner, , mode] = line.split('\t');
    const cliArgs = [];
    if (mutators === 'Targeted') cliArgs.push('--mutators', 'targeted');
    else if (mutators === 'Full') cliArgs.push('--mutators', 'full');
    else if (mutators === 'RemovedProfile') cliArgs.push('--mutators', 'standard');
    if (runner === 'Playwright') cliArgs.push('--runner', 'playwright');
    if (mode === 'Audit') cliArgs.push('--audit');
    else if (mode === 'Witnesses') cliArgs.push('--witnesses');
    else if (mode === 'UndoChanges') cliArgs.push('--undo-changes');
    else if (mode === 'SuggestAssertions') cliArgs.push('--suggest-assertions');
    const expectsReject = mutators === 'RemovedProfile' || mode === 'UndoChanges';
    if (!expectsReject) continue;
    const run = analyze(...cliArgs);
    assert.equal(run.status, 1, line);
    assert.match(run.stderr, mutators === 'RemovedProfile' ? /Expected --mutators targeted\|full/ : /--undo-changes requires --since REV/);
  }
});

test('the full profile runs the complete built-in mutation set without an extra package', () => {
  const run = analyze('--mutators', 'full');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.deepEqual([report.mutators, report.operatorExecution, report.evaluation], ['full', 'session', 'evaluated']);
  const byName = {};
  for (const mutant of report.mutants) (byName[mutant.mutatorName ?? mutant.rule] ??= []).push(mutant.status);
  assert.deepEqual(Object.keys(byName).sort(), ['ArithmeticOperator', 'BlockStatement', 'BooleanLiteral', 'ConditionalExpression',
    'EqualityOperator', 'LogicalOperator', 'comparison-boundary/v1', 'comparison-threshold/v1']);
  // `total >= 100` -> `total > 100` is reported once, by the focused analysis with its missing input.
  assert.deepEqual(byName['comparison-boundary/v1'], ['survived']);
  assert.deepEqual(byName['comparison-threshold/v1'], ['survived']);
  assert.ok(report.diagnostics.some(gap => gap.kind === 'INPUT GAP' && gap.location.line === 3));
  const equality = report.mutants.filter(mutant => mutant.mutatorName === 'EqualityOperator').map(mutant => [mutant.original, mutant.replacement, mutant.status]);
  assert.deepEqual(equality, [['member === true', 'member !== true', 'killed'], ['total >= 100', 'total < 100', 'killed']]);
  // Nothing calls `unused`, so per-test coverage reports its mutations as unreached.
  const unused = report.mutants.filter(mutant => mutant.location.line >= 6);
  assert.deepEqual(unused.map(mutant => [mutant.mutatorName, mutant.status]), [['BlockStatement', 'unreached'], ['ArithmeticOperator', 'unreached']]);
  assert.equal(report.mutants.find(mutant => mutant.mutatorName === 'BlockStatement' && mutant.location.line === 1).status, 'killed');
  assert.equal(report.mutants.every(mutant => mutant.source === undefined && mutant.operatorSwap === undefined), true);
  assert.equal(new Set(report.mutants.map(mutant => `${mutant.id ?? mutant.site}:${mutant.rule ?? mutant.mutatorName}:${mutant.replacement}`)).size, report.mutants.length);
});

test('the full profile reads as mutator, original and replacement in the text report', () => {
  const run = analyze('--mutators', 'full', '--lines', 'src/price.ts:7', '--format', 'text');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /^src\/price\.ts:7:10 {2}unreached {2}ArithmeticOperator: a \+ b -> a - b$/m);
});
