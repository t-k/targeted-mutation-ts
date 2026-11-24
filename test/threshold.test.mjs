import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkedThresholdGaps, thresholdGap } from '../src/threshold.mjs';

function evalOp(operator, x, t) {
  switch (operator) {
    case '<': return x < t;
    case '<=': return x <= t;
    case '>': return x > t;
    case '>=': return x >= t;
  }
}

function oracle(threshold, observations, min, max, operator = '>=') {
  if (!observations.length || observations.some(value => !Number.isSafeInteger(value) || value < min || value > max)) {
    return null;
  }
  const upper = operator === '>' || operator === '<=';
  const domain = Array.from({ length: max - min + 1 }, (_, index) => index + min);
  const feasible = domain.filter(candidate => observations.every(value => evalOp(operator, value, candidate) === evalOp(operator, value, threshold)));
  const alternate = feasible.filter(candidate => candidate !== threshold)
    .sort((a, b) => Math.abs(a - threshold) - Math.abs(b - threshold) || (upper ? b - a : a - b))[0];
  if (alternate === undefined) return null;
  const witness = upper
    ? (alternate > threshold ? alternate : threshold)
    : (alternate < threshold ? alternate : threshold);
  return {
    interval: [feasible[0], feasible.at(-1)],
    alternate,
    witness,
    expected: evalOp(operator, witness, threshold),
    mutant: evalOp(operator, witness, alternate),
  };
}

const rows = readFileSync(new URL('../verification/pict/m0-threshold.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  test('PICT ' + row.replaceAll('\t', ' / '), () => {
    const [observation, position, domain] = row.split('\t');
    const min = domain === 'Signed' ? -4 : 0;
    const max = 8;
    const threshold = { Lower: min, Upper: max, Interior: 4 }[position];
    const observations = {
      Both: [threshold - 1, threshold + Number(threshold < max)],
      FalseOnly: [threshold - 1],
      TrueOnly: [threshold + Number(threshold < max)],
      Empty: [],
      Invalid: [threshold, '4'],
    }[observation];
    assert.deepEqual(thresholdGap(threshold, observations, min, max), oracle(threshold, observations, min, max));
  });
}

test('feasible thresholds and the nearest witness match exhaustive enumeration', () => {
  const domain = [-3, -2, -1, 0, 1, 2, 3];
  for (const threshold of domain) {
    for (let subset = 0; subset < 2 ** domain.length; subset++) {
      const observations = domain.filter((_, index) => subset & (1 << index));
      assert.deepEqual(thresholdGap(threshold, observations, -3, 3), oracle(threshold, observations, -3, 3));
    }
  }
});

test('safe integer endpoints and a real zero are handled exactly', () => {
  const min = Number.MIN_SAFE_INTEGER;
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(thresholdGap(max, [min, max]), {
    interval: [min + 1, max], alternate: max - 1, witness: max - 1, expected: false, mutant: true,
  });
  assert.equal(thresholdGap(1, [0, 1]), null);
});

test('compiled threshold gaps match the exhaustive oracle in one batch', () => {
  const requests = [];
  const domain = [-2, -1, 0, 1, 2];
  for (const threshold of domain) {
    for (let mask = 0; mask < 2 ** domain.length; mask++) {
      requests.push({ threshold, observations: domain.filter((_, i) => mask & (1 << i)), min: -2, max: 2 });
    }
  }
  requests.push({ threshold: 2, observations: [null], min: -2, max: 2 });
  assert.deepEqual(checkedThresholdGaps(requests), requests.map(({ threshold, observations, min, max }) =>
    oracle(threshold, observations, min, max)));
});

test('compiled threshold gaps preserve safe endpoints and reject invalid domains', () => {
  const low = Number.MIN_SAFE_INTEGER;
  const high = Number.MAX_SAFE_INTEGER;
  const requests = [
    [low, [high], low, high], [high, [low], low, high], [low, [low], low, low],
    [1, [1], 2, 3], [0, [1.5], 0, 2], [0, [0], low - 1, high],
  ];
  assert.deepEqual(checkedThresholdGaps(requests.map(([threshold, observations, min, max]) =>
    ({ threshold, observations, min, max }))), requests.map(args => thresholdGap(...args)));
});

test('all four comparison operators match exhaustive enumeration in both JS and compiled Lean', () => {
  const domain = [-2, -1, 0, 1, 2];
  const requests = [];
  for (const operator of ['<', '<=', '>', '>=']) {
    for (const threshold of domain) {
      for (let mask = 0; mask < 2 ** domain.length; mask++) {
        const observations = domain.filter((_, index) => mask & (1 << index));
        assert.deepEqual(thresholdGap(threshold, observations, -2, 2, operator), oracle(threshold, observations, -2, 2, operator),
          `${operator} ${threshold} ${JSON.stringify(observations)}`);
        requests.push({ operator, threshold, observations, min: -2, max: 2 });
      }
    }
  }
  assert.deepEqual(checkedThresholdGaps(requests), requests.map(({ operator, threshold, observations, min, max }) =>
    oracle(threshold, observations, min, max, operator)));
});

const opRows = readFileSync(new URL('../verification/pict/threshold-operators.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));
const opSymbols = { Ge: '>=', Le: '<=', Gt: '>', Lt: '<' };

test('PICT threshold-operators matrix covers every required seed and matches planFocusedTrials', async () => {
  const { planFocusedTrials } = await import('../src/analysis.mjs');
  const { extract } = await import('../src/extract.mjs');
  const seeds = readFileSync(new URL('../verification/pict/threshold-operators.seed.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const table = new Set(opRows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
  const passing = { id: 'p', file: 't.ts', project: '', status: 'passed' };
  for (const [opName, obsKind, rhsKind, callableKind] of opRows) {
    const op = opSymbols[opName];
    const rhsExpr = rhsKind === 'Literal' ? '10' : rhsKind === 'NamedConst' ? 'LIMIT' : 'bound';
    const decl = {
      ArrowExpr: `export const check = (x: number) => x ${op} ${rhsExpr};`,
      ArrowBlock: `export const check = (x: number) => { return x ${op} ${rhsExpr}; };`,
      FunctionDecl: `export function check(x: number) { return x ${op} ${rhsExpr}; }`,
      Internal: `export function run(x: number, bound: number) { const LIMIT = 10; return x ${op} ${rhsExpr} ? 1 : 0; }`,
    }[callableKind];
    const input = Buffer.from(decl);
    const [site] = extract(input, { file: 'f.ts' }).candidates.map(c => ({ ...c, id: 's0' }));
    const pairs = {
      BelowOnly: [[5, 10]],
      AboveOnly: [[15, 10]],
      BothWithGap: [[5, 10], [15, 10]],
      Tight: op === '>=' || op === '<' ? [[9, 10], [10, 10]] : [[10, 10], [11, 10]],
      Empty: [],
      Invalid: [[5, '10']],
    }[obsKind];
    const trace = [{ loaded: ['s0'] }, ...(rhsKind === 'Varying'
      ? [[5, 10], [15, 12]] : pairs).map(([l, r]) => ({
      site: 's0', operator: op, identity: passing, operands: [l, r],
      result: typeof l === 'number' && typeof r === 'number' ? evalOp(op, l, r) : false,
    }))];
    const planned = planFocusedTrials([{ file: 'f.ts', input, sites: [site] }], trace, { tests: [passing] }, {}, false);
    const thresholdTrial = planned.find(t => t.rule === 'comparison-threshold/v1');
    const boundaryTrial = planned.find(t => t.rule === 'comparison-boundary/v1');
    if (obsKind === 'Empty' || obsKind === 'Invalid' || obsKind === 'Tight' || rhsKind === 'Varying') {
      assert.equal(thresholdTrial, undefined, `${opName} ${obsKind} ${rhsKind} ${callableKind}`);
    } else if (obsKind === 'BothWithGap') {
      assert.ok(thresholdTrial, `expected threshold trial for ${opName} ${obsKind} ${rhsKind} ${callableKind}`);
      assert.equal(thresholdTrial.adjustment, op === '>=' || op === '<' ? -1 : 1);
      if (rhsKind === 'Literal') assert.equal(thresholdTrial.replacement, String(10 + thresholdTrial.adjustment));
      else assert.equal(thresholdTrial.replacement, `((LIMIT) ${thresholdTrial.adjustment < 0 ? '-' : '+'} 1)`);
    }
    const expectCallable = callableKind !== 'Internal' && rhsKind === 'Literal' && obsKind !== 'Empty' && obsKind !== 'Invalid';
    assert.equal(Boolean(boundaryTrial.threshold), expectCallable, `callable ${opName} ${obsKind} ${rhsKind} ${callableKind}`);
    // Non-literal RHS must never claim literal equivalence on all safe integers.
    if (rhsKind !== 'Literal') assert.equal(boundaryTrial.equivalentOnSafeIntegers, undefined);
  }
});
