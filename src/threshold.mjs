import { runDecisionBatch } from './lean-replay.mjs';

function evaluate(operator, lhs, rhs) {
  switch (operator) {
    case '<': return lhs < rhs;
    case '<=': return lhs <= rhs;
    case '>': return lhs > rhs;
    case '>=': return lhs >= rhs;
  }
}

const upperInclusive = operator => operator === '>' || operator === '<=';

export function thresholdGap(threshold, observations, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, operator = '>=') {
  if (!['<', '<=', '>', '>='].includes(operator) ||
      ![threshold, min, max].every(Number.isSafeInteger) || threshold < min || threshold > max || !observations.length) {
    return null;
  }
  const upper = upperInclusive(operator);
  let lowerBound = min;
  let upperBound = max;
  for (const input of observations) {
    if (!Number.isSafeInteger(input) || input < min || input > max) return null;
    if (upper) {
      if (input <= threshold) lowerBound = Math.max(lowerBound, input);
      else upperBound = Math.min(upperBound, input - 1);
    } else {
      if (input < threshold) lowerBound = Math.max(lowerBound, input + 1);
      else upperBound = Math.min(upperBound, input);
    }
  }

  let alternate = null;
  let witness = null;
  if (upper) {
    if (threshold < upperBound) {
      alternate = threshold + 1;
      witness = threshold + 1;
    } else if (lowerBound < threshold) {
      alternate = threshold - 1;
      witness = threshold;
    }
  } else {
    if (lowerBound < threshold) {
      alternate = threshold - 1;
      witness = threshold - 1;
    } else if (threshold < upperBound) {
      alternate = threshold + 1;
      witness = threshold;
    }
  }
  if (alternate === null) return null;
  return {
    interval: [lowerBound, upperBound],
    alternate,
    witness,
    expected: evaluate(operator, witness, threshold),
    mutant: evaluate(operator, witness, alternate),
  };
}

function extremalObservations(threshold, observations, min, max, operator = '>=') {
  if (!Array.isArray(observations)) return observations;
  const upper = upperInclusive(operator);
  let below;
  let above;
  for (const value of observations) {
    if (!Number.isSafeInteger(value) || value < min || value > max) return [];
    if (upper ? value <= threshold : value < threshold) below = Math.max(below ?? value, value);
    else above = Math.min(above ?? value, value);
  }
  const evidence = [];
  if (below !== undefined) evidence.push(below);
  if (above !== undefined) evidence.push(above);
  return evidence;
}

export function checkedThresholdGaps(requests) {
  const batch = requests.map(({ threshold, observations, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, operator = '>=' }) =>
    ({ threshold, observations: extremalObservations(threshold, observations, min, max, operator), min, max, ...(operator === '>=' ? {} : { operator }) }));
  const answers = runDecisionBatch(batch, ['thresholds']);
  return answers?.every(gap => gap === null || Array.isArray(gap?.interval)) ? answers : null;
}

export function thresholdGaps(requests) {
  return checkedThresholdGaps(requests) ?? requests.map(({ threshold, observations, min, max, operator = '>=' }) =>
    thresholdGap(threshold, observations, min, max, operator));
}
