import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function analyze(...args) {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', ...args], { encoding: 'utf8', timeout: 90_000 });
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
  assert.deepEqual(gap.verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
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
  const result = analyze('fixtures/shipping', 'src/shipping.ts', '--spec', 'spec.json', '--lines', 'src/shipping.ts:1-1', '--deterministic', '--audit');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].suggestedTest, 'expect(shipsFree(4999)).toBe(false)');
  assert.deepEqual(result.diagnostics[0].verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
  assert.deepEqual(result.mutants.map(result => result.status), ['killed', 'survived']);
  assert.equal(result.mutants[1].evidence, 'predicted');
  assert.deepEqual(result.mutants[1].audit, { status: 'agreed', source: 'survived', probe: null });
  assert.throws(
    () => analyze('fixtures/shipping', 'src/shipping.ts', '--lines', 'src/shipping.ts:2-2'),
    /out of range/,
  );
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
    const report = analyze(root, 'subject.ts');
    const gap = report.diagnostics.find(entry => entry.mutations.some(m => m.rule === 'comparison-boundary/v1'));
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

test('generated witnesses run under a Vitest config with an explicit include file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-custom-include-test-'));
  try {
    cpSync('fixtures/eligibility', root, { recursive: true });
    const selected = 'test/eligibility.test.ts';
    const before = readFileSync(join(root, selected), 'utf8');
    writeFileSync(join(root, 'vitest.config.mjs'), `export default { test: { include: [${JSON.stringify(selected)}] } };`);
    const [gap] = analyze(root, 'src/eligibility.ts', '--audit').diagnostics;
    assert.deepEqual(gap.verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
    assert.equal(readFileSync(join(root, selected), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reexecutes a one-unit tightening and reports the missing assertion', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-displacement-test-'));
  try {
    const source = 'export const keep = (count: number) => count > 0;\n';
    writeFileSync(join(root, 'subject.ts'), source);
    const suite = join(root, 'subject.test.ts');
    const original = "import { expect, it } from 'vitest'; import { keep } from './subject'; it('checks two', () => expect(keep(2)).toBe(true)); it('exercises zero', () => { keep(0); }); it('exercises one', () => { keep(1); });";
    writeFileSync(suite, original);
    const result = analyze(root, 'subject.ts', '--displace-thresholds', '--deterministic');
    const displaced = result.mutants.find(mutant => mutant.rule === 'comparison-tighten/v1');
    assert.equal(displaced.replacement, '1');
    assert.equal(displaced.status, 'survived');
    assert.equal(displaced.evidence, 'reexecuted');
    const gap = result.diagnostics.find(diagnostic => diagnostic.mutations[0].rule === displaced.rule);
    assert.equal(gap.kind, 'ASSERTION GAP');
    assert.deepEqual(gap.tests.map(test => test.name), ['exercises one']);
    assert.deepEqual(gap.example, { operands: [1, 0], original: true, mutant: false });
    const boundaryGap = result.diagnostics.find(diagnostic => diagnostic !== gap);
    assert.deepEqual(boundaryGap.tests.map(test => test.name), ['exercises zero']);
    writeFileSync(suite, original + " it('checks one', () => expect(keep(1)).toBe(true));");
    const confirmed = analyze(root, 'subject.ts', '--displace-thresholds');
    assert.equal(confirmed.mutants.find(mutant => mutant.rule === 'comparison-tighten/v1').status, 'killed');
    assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audits a generated witness for a callable strict threshold and finds <= and internal threshold gaps directly', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-strict-witness-'));
  try {
    writeFileSync(join(root, 'subject.ts'), `export function keep(count: number) { return count < 4; }
export const withinLimit = (n: number) => { return n <= 10; };
const CAP = 100;
export function accepts(x: number, label: string) { return label.length > 0 && x <= CAP; }
`);
    writeFileSync(join(root, 'subject.test.ts'), `import { expect, it } from 'vitest';
import { accepts, keep, withinLimit } from './subject';
it('checks', () => {
  expect(keep(2)).toBe(true);
  expect(withinLimit(10)).toBe(true);
  expect(withinLimit(20)).toBe(false);
  expect(accepts(100, 'ok')).toBe(true);
  expect(accepts(200, 'ok')).toBe(false);
});
`);
    const result = analyze(root, 'subject.ts', '--audit');
    const keepGap = result.diagnostics.find(d => d.location.line === 1 && d.mutations.some(m => m.rule === 'comparison-threshold/v1'));
    assert.equal(keepGap.suggestedTest, 'expect(keep(3)).toBe(true)');
    assert.deepEqual(keepGap.verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
    const leGap = result.diagnostics.find(d => d.location.line === 2 && d.mutations.some(m => m.rule === 'comparison-threshold/v1'));
    assert.equal(leGap.suggestedTest, 'expect(withinLimit(11)).toBe(false)');
    assert.deepEqual(leGap.verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
    const capGap = result.diagnostics.find(d => d.location.line === 4 && d.witness?.operands?.[1] === 100 && d.mutations.some(m => m.rule === 'comparison-threshold/v1'));
    assert.equal(capGap.kind, 'INPUT GAP');
    assert.deepEqual(capGap.witness.operands, [101, 100]);
    assert.deepEqual(capGap.feasibleThresholds, [100, 199]);
    const lenGap = result.diagnostics.find(d => d.location.line === 4 && d.witness?.operands?.[1] === 0 && d.mutations.some(m => m.rule === 'comparison-threshold/v1'));
    assert.equal(lenGap.kind, 'INPUT GAP');
    assert.deepEqual(lenGap.witness.operands, [1, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps both focused probe bindings fresh for escaped identifiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-probe-escape-'));
  try {
    writeFileSync(join(root, 'subject.ts'), String.raw`
const __tmtCompar\u0065 = 1;
const __tmtCompar\u0065_\u004coaded = 2;
export const positive = (value: number) => value > 0;
`);
    writeFileSync(join(root, 'subject.test.ts'),
      "import { expect, it } from 'vitest'; import { positive } from './subject'; it('checks two', () => expect(positive(2)).toBe(true));");
    const result = analyze(root, 'subject.ts', '--audit');
    assert.equal(result.instrumented.status, 'passed');
    assert.equal(result.mutants[0].status, 'survived');
    assert.equal(result.mutants[0].audit.status, 'agreed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kills a focused mutation when the tests import through a project alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-probe-symlink-'));
  try {
    writeFileSync(join(root, 'subject.ts'), 'export const positive = (value: number) => value > 0;');
    symlinkSync('subject.ts', join(root, 'alias.ts'), 'file');
    writeFileSync(join(root, 'subject.test.ts'),
      "import { expect, it } from 'vitest'; import { positive } from './alias'; it('checks zero', () => expect(positive(0)).toBe(false));");
    const result = analyze(root, 'subject.ts');
    assert.equal(result.instrumented.status, 'passed');
    assert.equal(result.mutants.find(m => m.rule === 'comparison-boundary/v1').status, 'killed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze succeeds via the TypeScript parser when the native addon is unavailable or fails to load', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-no-native-'));
  try {
    const tool = join(scratch, 'tool');
    cpSync('bin', join(tool, 'bin'), { recursive: true });
    cpSync('src', join(tool, 'src'), { recursive: true });
    cpSync('package.json', join(tool, 'package.json'));
    symlinkSync(join(process.cwd(), 'node_modules'), join(tool, 'node_modules'), 'dir');
    const project = join(scratch, 'project');
    cpSync('fixtures/eligibility', project, { recursive: true });
    for (const label of ['missing', 'dlopen-failed']) {
      if (label === 'dlopen-failed') {
        mkdirSync(join(tool, 'build'), { recursive: true });
        writeFileSync(join(tool, 'build/tmt.node'), 'not a valid native addon');
      }
      const run = spawnSync(process.execPath, [join(tool, 'bin/tmt.mjs'), 'analyze', project, 'src/eligibility.ts', '--format', 'json'],
        { encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, `${label}: ${run.stderr}${run.stdout}`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.evaluation, 'evaluated', label);
      assert.equal(report.extraction[0].path, 'fallback', label);
      assert.equal(report.extraction[0].reason, 'native-unavailable', label);
      assert.equal(report.diagnostics[0].suggestedTest, 'expect(eligible(18)).toBe(true)', label);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
