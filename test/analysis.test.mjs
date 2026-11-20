import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function analyze(...args) {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', ...args], { encoding: 'utf8', timeout: 50_000 });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
  return JSON.parse(run.stdout);
}

test('reports the 18-year boundary input gap once and audits the Lean replay', () => {
  const result = analyze('fixtures/eligibility', 'src/eligibility.ts', '--spec', 'spec.json', '--deterministic', '--audit');
  const [gap] = result.diagnostics;
  assert.equal(result.diagnostics.length, 1);
  assert.equal(gap.kind, 'INPUT GAP');
  assert.equal(gap.suggestedTest, 'expect(eligible(18)).toBe(true)');
  assert.equal(gap.witness.expectation, 'specification');
  assert.equal(result.mutants.length, 1);
  assert.equal(result.mutants[0].evidence, 'predicted');
  assert.equal(result.mutants[0].audit.status, 'agreed');
});

for (const [variant, status, gapKind] of [
  ['reaches-boundary', 'survived', 'ASSERTION GAP'],
  ['asserts-boundary', 'killed', undefined],
]) {
  test('reports ' + status + ' when the suite ' + variant, () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-eligibility-test-'));
    try {
      cpSync('fixtures/eligibility', root, { recursive: true });
      cpSync(join(root, 'variants', variant + '.ts'), join(root, 'test/boundary.test.ts'));
      const result = analyze(root, 'src/eligibility.ts', '--audit');
      assert.equal(result.mutants[0].status, status);
      assert.equal(result.mutants[0].audit.status, 'agreed');
      assert.equal(result.diagnostics[0]?.kind, gapKind);
      if (gapKind) assert.equal(result.diagnostics[0].tests[0].name, 'checks an 18-year-old');
      else assert.equal(result.mutants[0].tests[0].name, 'checks an 18-year-old');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('uses the product runner for the M0 threshold shift and filters on the operator line', () => {
  const result = analyze('fixtures/shipping', 'src/shipping.ts', '--spec', 'spec.json', '--lines', 'src/shipping.ts:1-1', '--audit');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].suggestedTest, 'expect(shipsFree(4999)).toBe(false)');
  assert.deepEqual(result.mutants.map(result => result.status), ['killed', 'survived']);
  assert.equal(analyze('fixtures/shipping', 'src/shipping.ts', '--lines', 'src/shipping.ts:2-2').evaluation, 'no_sites');
});

test('coercion preserves evaluation order, count and thrown exceptions without proof-based skips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-coercion-test-'));
  try {
    mkdirSync(join(root, 'test'));
    const source = `export const compare = (a: () => any, b: () => any) => a() >= b();`;
    writeFileSync(join(root, 'subject.ts'), source);
    writeFileSync(join(root, 'test/effects.test.ts'), `import { it, expect } from 'vitest';
import { compare } from '../subject';
it('keeps operand and coercion order', () => {
  const seen = [];
  expect(compare(() => { seen.push('left'); return { valueOf() { seen.push('coerce left'); return 4; } }; },
    () => { seen.push('right'); return { valueOf() { seen.push('coerce right'); return 2; } }; })).toBe(true);
  expect(seen).toEqual(['left', 'right', 'coerce left', 'coerce right']);
  expect(() => compare(() => { throw new Error('sentinel'); }, () => { throw new Error('should not run'); })).toThrow('sentinel');
});`);
    const result = analyze(root, 'subject.ts', '--deterministic', '--audit');
    assert.equal(result.instrumented.status, 'passed');
    assert.equal(result.mutants[0].status, 'survived');
    assert.equal(result.mutants[0].evidence, 'reexecuted');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports hypothetical operands without inventing a callable input', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-operand-test-'));
  try {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'subject.ts'), 'export const f = (x: number) => x >= x + 1;');
    writeFileSync(join(root, 'test/subject.test.ts'), "import { expect, it } from 'vitest'; import { f } from '../subject'; it('runs f', () => expect(f(1)).toBe(false));");
    const [gap] = analyze(root, 'subject.ts').diagnostics;
    assert.equal(gap.kind, 'INPUT GAP');
    assert.deepEqual(gap.witness.operands, [2, 2]);
    assert.equal(gap.witness.input, undefined);
    assert.equal(gap.suggestedTest, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a mutation failing an assertion about the word timeout is a kill', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-timeout-test-'));
  try {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'subject.ts'), "export const label = (x: number) => x >= 10 ? 'timeout' : 'ready';");
    writeFileSync(join(root, 'test/subject.test.ts'), "import { expect, it } from 'vitest'; import { label } from '../subject'; it('labels a timeout', () => expect(label(10)).toBe('timeout'));");
    const [result] = analyze(root, 'subject.ts').mutants;
    assert.equal(result.status, 'killed');
    assert.equal(result.tests[0].name, 'labels a timeout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unloaded instrumented module with no observations is kept out of survivor counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-unloaded-test-'));
  try {
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'subject.ts'), 'export const f = (x: number) => x >= 1;');
    writeFileSync(join(root, 'test/subject.test.ts'), "import { expect, it } from 'vitest'; it('passes without subject', () => expect(1).toBe(1));");
    const [result] = analyze(root, 'subject.ts').mutants;
    assert.equal(result.status, 'unevaluated');
    assert.equal(result.sourceVerdict, 'survived');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
