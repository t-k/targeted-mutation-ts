import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const summary = report => report.mutants.map(mutant => [mutant.location.line, mutant.operator, mutant.replacement, mutant.status]);

test('the operators profile edits equality, logical and arithmetic operators without an extra package', () => {
  const run = analyze('--mutators', 'operators');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mutators, 'operators');
  assert.equal(report.evaluation, 'evaluated');
  assert.deepEqual(summary(report), [
    [2, '*', '/', 'killed'],
    [3, '===', '!==', 'killed'],
    // No test has a member order under 100 or a non-member order of 100 or more.
    [3, '&&', '||', 'survived'],
    [3, '>=', '>', 'survived'],
    [3, '-', '+', 'killed'],
    // Never called: the edit survives and reach is not measured for operator edits.
    [7, '+', '-', 'survived'],
  ]);
  const rules = Object.fromEntries(report.mutants.map(mutant => [mutant.operator, mutant.rule]));
  assert.deepEqual(rules, { '*': 'arithmetic-operator/v1', '===': 'equality-negation/v1', '&&': 'logical-operator/v1',
    '>=': 'comparison-boundary/v1', '-': 'arithmetic-operator/v1', '+': 'arithmetic-operator/v1' });
  const unreached = report.mutants.at(-1);
  assert.equal(unreached.evidence, 'reexecuted');
  assert.equal(unreached.sourceVerdict, undefined);
  assert.ok(report.mutants[0].tests.length > 0);
  assert.deepEqual(report.diagnostics.map(gap => [gap.kind, gap.location.line]), [['INPUT GAP', 3]]);
  assert.deepEqual(report.instrumented, { status: 'passed' });
});

test('the default profile keeps reporting comparison edits only', () => {
  const run = analyze();
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.mutators, undefined);
  assert.deepEqual(summary(report), [[3, '>=', '>', 'survived']]);
});

test('the text report shows an operator edit as an operator change', () => {
  const run = analyze('--mutators', 'operators', '--lines', 'src/price.ts:7', '--format', 'text');
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /^src\/price\.ts:7:12 {2}survived {2}arithmetic-operator\/v1: \+ -> -$/m);
});

test('the operators profile is refused with the witness profile and unknown profiles keep their error', () => {
  const witnesses = analyze('--mutators', 'operators', '--witnesses');
  assert.equal(witnesses.status, 1);
  assert.equal(witnesses.stderr, '--witnesses runs its own Vitest source trials\n');
  const unknown = analyze('--mutators', 'everything');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr, 'Expected --mutators focused|operators|standard|all\n');
});
