import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { thresholdGap } from '../src/threshold.mjs';

function oracle(threshold, observations, min, max) {
  if (!observations.length || observations.some(value => !Number.isSafeInteger(value) || value < min || value > max)) {
    return null;
  }
  const domain = Array.from({ length: max - min + 1 }, (_, index) => index + min);
  const feasible = domain.filter(candidate => observations.every(value => (value >= candidate) === (value >= threshold)));
  const alternate = feasible.filter(candidate => candidate !== threshold)
    .sort((a, b) => Math.abs(a - threshold) - Math.abs(b - threshold) || a - b)[0];
  if (alternate === undefined) return null;
  const witness = Math.min(alternate, threshold);
  return { interval: [feasible[0], feasible.at(-1)], alternate, witness, expected: witness >= threshold, mutant: witness >= alternate };
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
