import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as analysis from '../src/analysis.mjs';

const matrix = readFileSync(new URL('../verification/pict/focused-coverage.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [observed, hits, identity] of matrix) {
  test(`focused independent coverage ${observed} ${hits} ${identity}`, () => {
    const observations = new Map([['a', [[20, 18], [21, 18]]]]);
    if (observed === 'Multiple') observations.set('b', [[30, 18]]);
    const counted = new Map(observations.entries().map(([id, values]) => [id, values.length]));
    counted.set('a', counted.get('a') + { Exact: 0, Missing: -1, Extra: 1 }[hits]);
    if (identity !== 'Same') {
      counted.set(identity === 'Static' ? null : 'unknown', counted.get('a'));
      counted.delete('a');
    }
    assert.equal(analysis.matchesFocusedCoverage(observations, counted), hits === 'Exact' && identity === 'Same');
  });
}

function analyzeProject({ commonjs = false, throwOperand = false, audit = false }) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-focused-coverage-'));
  const file = commonjs ? 'subject.cjs' : 'subject.mjs';
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, file),
      (throwOperand ? "const value = n => { if (n === 0) throw new Error('operand'); return n; };\n" : 'const value = n => n;\n') +
      (commonjs ? 'module.exports = n => value(n) >= 18;' : 'export const eligible = n => value(n) >= 18;'));
    const load = commonjs
      ? "import { createRequire } from 'node:module'; const eligible = createRequire(import.meta.url)('./subject.cjs');"
      : "import { eligible } from './subject.mjs';";
    writeFileSync(join(root, 'subject.test.mjs'), `
      import { expect, it } from 'vitest';
      ${load}
      it('reaches eligibility', () => {
        expect(eligible(20)).toBe(true);
        expect(eligible(21)).toBe(true);
        ${throwOperand ? "expect(() => eligible(0)).toThrow('operand');" : ''}
      });
      it('does not reach eligibility', () => expect(6).toBe(6));
    `);
    const run = spawnSync(process.execPath,
      ['bin/tmt.mjs', 'analyze', root, file, '--deterministic', ...(audit ? ['--audit'] : [])],
      { encoding: 'utf8', timeout: 25_000 });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.baseline, { status: 'passed', tests: 2 });
    assert.deepEqual(report.instrumented, { status: 'passed', stable: true });
    assert.equal(report.mutants.length, 1);
    const [trial] = report.mutants;
    assert.equal(trial.status, 'survived');
    return trial;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('focused Lean replay accepts a counted subset and still audits a source rewrite', () => {
  const trial = analyzeProject({ audit: true });
  assert.equal(trial.evidence, 'predicted');
  assert.deepEqual(trial.audit, { status: 'agreed', source: 'survived', probe: 'survived' });
});

test('focused Lean replay counts the CommonJS comparison independently', () => {
  const trial = analyzeProject({ commonjs: true });
  assert.equal(trial.evidence, 'predicted');
});

test('an attempt whose operand throws prevents a partial prediction', () => {
  const trial = analyzeProject({ throwOperand: true });
  assert.equal(trial.evidence, 'reexecuted');
});
