import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decisionBinaryName } from '../src/runtime-binaries.mjs';
import { planFocusedTrials } from '../src/analysis.mjs';
import { renderText } from '../src/cli-output.mjs';
import { extract } from '../src/extract.mjs';
import { checkedMarginGaps, marginGap } from '../src/threshold.mjs';

function evalOp(operator, x, t) {
  switch (operator) {
    case '<': return x < t;
    case '<=': return x <= t;
    case '>': return x > t;
    case '>=': return x >= t;
  }
}

function oracleMargin(pairs, operator = '>=') {
  if (!pairs.length) return null;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [l, r] = pair;
    if (!Number.isSafeInteger(l) || !Number.isSafeInteger(r) || !Number.isSafeInteger(l - r)) return null;
  }
  const upper = operator === '>' || operator === '<=';
  let lo = Number.MIN_SAFE_INTEGER;
  let hi = Number.MAX_SAFE_INTEGER;
  for (const [l, r] of pairs) {
    const d = l - r;
    const loForR = r < 0 ? Number.MIN_SAFE_INTEGER - r : Number.MIN_SAFE_INTEGER;
    const hiForR = r > 0 ? Number.MAX_SAFE_INTEGER - r : Number.MAX_SAFE_INTEGER;
    lo = Math.max(lo, loForR);
    hi = Math.min(hi, hiForR);
    if (upper) {
      if (d <= 0) lo = Math.max(lo, d);
      else hi = Math.min(hi, d - 1);
    } else {
      if (d < 0) lo = Math.max(lo, d + 1);
      else hi = Math.min(hi, d);
    }
  }
  let alternate = null;
  let witness = null;
  if (upper) {
    if (0 < hi) (alternate = 1, witness = 1);
    else if (lo < 0) (alternate = -1, witness = 0);
  } else {
    if (lo < 0) (alternate = -1, witness = -1);
    else if (0 < hi) (alternate = 1, witness = 0);
  }
  if (alternate === null) return null;
  if (pairs.some(([, r]) => !Number.isSafeInteger(r + alternate))) return null;
  return {
    interval: [lo, hi],
    alternate,
    witness,
    expected: evalOp(operator, witness, 0),
    mutant: evalOp(operator, witness, alternate),
  };
}

const rows = readFileSync(new URL('../verification/pict/margin-gaps.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));
const opSymbols = { Lt: '<', Le: '<=', Gt: '>', Ge: '>=' };

test('the margin-gaps PICT table has every required seed', () => {
  const seeds = readFileSync(new URL('../verification/pict/margin-gaps.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
});

for (const [opName, slack, rhsKind] of rows) {
  test(`PICT margin: ${opName} / ${slack} / ${rhsKind}`, () => {
    const op = opSymbols[opName];
    const upper = op === '>' || op === '<=';
    const min = Number.MIN_SAFE_INTEGER;
    const max = Number.MAX_SAFE_INTEGER;
    const rhsA = 50;
    const rhsB = rhsKind === 'Constant' ? 50 : 80;
    const pairs = {
      BothWithSlack: [[rhsA - 10, rhsA], [rhsB + 10, rhsB]],
      BelowOnly: [[rhsA - 10, rhsA], [rhsB - 5, rhsB]],
      AboveOnly: [[rhsA + 10, rhsA], [rhsB + 5, rhsB]],
      Tight: upper ? [[rhsA, rhsA], [rhsB + 1, rhsB]] : [[rhsA - 1, rhsA], [rhsB, rhsB]],
      Empty: [],
      UnsafeDiff: [[max, -10], [0, 10]],
      UnsafeShift: upper ? [[max, max], [max - 1, max]] : [[min, min], [min + 1, min]],
      Fraction: [[10.5, 10], [20, 15]],
    }[slack];
    const expected = oracleMargin(pairs, op);
    assert.deepEqual(marginGap(pairs, op), expected);
    assert.deepEqual(checkedMarginGaps([{ operator: op, pairs }]), [expected]);

    // Check planFocusedTrials integration for varying vs constant RHS.
    if (slack !== 'Fraction' && slack !== 'Empty' && slack !== 'UnsafeDiff' && slack !== 'UnsafeShift') {
      const passing = { id: 'p', file: 't.ts', project: '', status: 'passed' };
      const input = Buffer.from(`export const ok = (a: number, b: number) => a ${op} b;\n`);
      const [site] = extract(input, { file: 'f.ts' }).candidates.map(c => ({ ...c, id: 's0' }));
      const trace = [{ loaded: ['s0'] }, ...pairs.map(([l, r]) => ({
        site: 's0', operator: op, identity: passing, operands: [l, r], result: evalOp(op, l, r),
      }))];
      const planned = planFocusedTrials([{ file: 'f.ts', input, sites: [site] }], trace, { tests: [passing] }, {}, false);
      const marginTrial = planned.find(t => t.rule === 'comparison-margin/v1');
      const thresholdTrial = planned.find(t => t.rule === 'comparison-threshold/v1');
      if (rhsKind === 'Constant') {
        assert.equal(marginTrial, undefined);
      } else if (slack === 'Tight') {
        assert.equal(marginTrial, undefined);
        assert.equal(thresholdTrial, undefined);
      } else if (expected) {
        const boundaryEquiv = (op === '>=' || op === '<') ? expected.alternate === 1 : expected.alternate === -1;
        assert.equal(Boolean(marginTrial), !boundaryEquiv);
        if (marginTrial) assert.equal(marginTrial.adjustment, expected.alternate);
      }
    }
  });
}

test('Lean replay accepts shift operators only for safe integer pairs that agree and rejects ambiguous tags', () => {
  const valid = {
    candidate: 's0', traceCandidate: 's0', complete: true, deterministic: true,
    original: '>=', replacement: { geShift: -1 }, observations: [[100, 50], [20, 50], [80, 60]],
  };
  const differs = { ...valid, observations: [[49, 50], [100, 50]] };
  const unsafeShift = { ...valid, observations: [[Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]] };
  const wrongOp = { ...valid, original: '<' };
  const ambiguous = { ...valid, replacement: { geLiteral: 0, geShift: 1 }, observations: [[5, 5]] };
  const run = spawnSync(`build/${decisionBinaryName()}`, [], { encoding: 'utf8', input: JSON.stringify([valid, differs, unsafeShift, wrongOp, ambiguous]) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [true, false, false, false, false]);
});

test('marginGap falls back to the opposite safe direction when the preferred shift overflows safe integers', () => {
  const M = Number.MIN_SAFE_INTEGER;
  const pairs = [[M + 2, M], [M + 3, M + 1]];
  // -1 overflows `M + (-1)`, but +1 is safe and agrees on both pairs (diffs are +2, +2 -> feasible safe interval [0, 2]).
  const expected = { interval: [0, 2], alternate: 1, witness: 0, expected: true, mutant: false };
  assert.deepEqual(marginGap(pairs, '>='), expected);
  assert.deepEqual(checkedMarginGaps([{ operator: '>=', pairs }]), [expected]);
});

test('bounded margins match exhaustive shift enumeration', () => {
  const rows = readFileSync(new URL('../verification/pict/self-tmt-margin-bounds.tsv', import.meta.url), 'utf8')
    .trim().split(/\r?\n/).slice(1);
  const expected = [];
  const requests = rows.map(row => {
    const [opName, difference, domain] = row.split('\t');
    const operator = opSymbols[opName];
    const diff = Number(difference);
    const min = domain === 'Nonnegative' ? 0 : -2;
    const max = domain === 'Nonpositive' ? 0 : 2;
    const pairs = [[10 + diff, 10]];
    const candidates = Array.from({ length: max - min + 1 }, (_, index) => min + index);
    const feasible = candidates.filter(shift => evalOp(operator, diff, shift) === evalOp(operator, diff, 0));
    const preferred = operator === '>' || operator === '<=' ? 1 : -1;
    const alternate = [preferred, -preferred].find(shift => feasible.includes(shift));
    let gap = null;
    if (candidates.includes(diff) && alternate !== undefined) {
      const witness = [-1, 0, 1].find(value => evalOp(operator, value, 0) !== evalOp(operator, value, alternate));
      gap = { interval: [feasible[0], feasible.at(-1)], alternate, witness,
        expected: evalOp(operator, witness, 0), mutant: evalOp(operator, witness, alternate) };
    }
    assert.deepEqual(marginGap(pairs, operator, min, max), gap, row);
    expected.push(gap);
    return { pairs, operator, min, max };
  });
  assert.deepEqual(checkedMarginGaps(requests), expected);
});

test('rejects malformed margin pairs and domains that exclude zero', () => {
  const valid = { pairs: [[3, 1]], min: -3, max: 3 };
  const requests = [
    { ...valid, operator: '==' },
    { ...valid, min: 1 },
    { ...valid, pairs: [[0, 3]], max: -1 },
    { ...valid, min: -3.5 },
    { ...valid, pairs: null },
    { ...valid, pairs: [[3, 1, 0]] },
    { ...valid, pairs: [{ 0: 3, 1: 1, length: 2 }] },
    { ...valid, pairs: [['3', 1]] },
    { ...valid, pairs: [[3, '1']] },
    { ...valid, pairs: [[3, 1n]] },
  ];
  for (const { pairs, operator, min, max } of requests) {
    assert.equal(marginGap(pairs, operator, min, max), null);
  }
  assert.deepEqual(checkedMarginGaps(requests), requests.map(() => null));
});

test('checked margins keep the closest differences and independent safe RHS bounds', () => {
  const min = Number.MIN_SAFE_INTEGER;
  const max = Number.MAX_SAFE_INTEGER;
  const requests = [
    { pairs: [[8, 10], [9, 10], [13, 10], [12, 10], [14, 10]] },
    { pairs: [[6, 10], [11, 10], [min + 5, min]] },
    { pairs: [[9, 10], [15, 10], [max - 5, max]], operator: '<=' },
    { pairs: [[0, -1]] },
    { pairs: [[0, 1]], operator: '<=' },
  ];
  const expected = [
    { interval: [0, 2], alternate: 1, witness: 0, expected: true, mutant: false },
    { interval: [0, 1], alternate: 1, witness: 0, expected: true, mutant: false },
    { interval: [-1, 0], alternate: -1, witness: 0, expected: true, mutant: false },
    { interval: [min + 1, 1], alternate: -1, witness: -1, expected: false, mutant: true },
    { interval: [-1, max - 1], alternate: 1, witness: 1, expected: false, mutant: true },
  ];
  assert.deepEqual(checkedMarginGaps(requests), expected);
  assert.deepEqual(requests.map(({ pairs, operator }) => marginGap(pairs, operator)), expected);
});

test('end-to-end Vitest reports comparison-margin/v1 INPUT GAP with feasibleMargins for varying-RHS comparison', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-margin-e2e-'));
  try {
    writeFileSync(join(root, 'subject.ts'), 'export const canAfford = (balance: number, price: number) => balance >= price;\n');
    writeFileSync(join(root, 'subject.test.ts'), `import { expect, it } from 'vitest';
import { canAfford } from './subject';
it('checks affordability with wide margin', () => {
  expect(canAfford(100, 50)).toBe(true);
  expect(canAfford(20, 60)).toBe(false);
});
`);
    const runResult = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--format', 'json'],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(runResult.status, 0, runResult.stderr);
    const report = JSON.parse(runResult.stdout);
    const marginMutant = report.mutants.find(m => m.rule === 'comparison-margin/v1');
    assert.equal(marginMutant?.status, 'survived');
    const marginGapDiag = report.diagnostics.find(d => d.rule === 'comparison-margin/v1');
    assert.equal(marginGapDiag?.kind, 'INPUT GAP');
    assert.deepEqual(marginGapDiag.feasibleMargins, [-39, 50]);
    assert.equal(marginGapDiag.witness.margin, -1);
    const text = renderText(report);
    assert.match(text, /comparison-margin\/v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
