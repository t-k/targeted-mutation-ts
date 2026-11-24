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

export function marginGap(pairs, operator = '>=', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (!['<', '<=', '>', '>='].includes(operator) ||
      ![min, max].every(Number.isSafeInteger) || min > 0 || max < 0 || !Array.isArray(pairs) || !pairs.length) {
    return null;
  }
  const diffs = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [lhs, rhs] = pair;
    if (!Number.isSafeInteger(lhs) || !Number.isSafeInteger(rhs)) return null;
    const diff = lhs - rhs;
    if (!Number.isSafeInteger(diff) || diff < min || diff > max) return null;
    diffs.push(diff);
  }
  const gap = thresholdGap(0, diffs, min, max, operator);
  if (!gap) return null;
  if (pairs.some(([, rhs]) => !Number.isSafeInteger(rhs + gap.alternate))) return null;
  return gap;
}

function extremalMarginPairs(pairs, min, max, operator = '>=') {
  if (!Array.isArray(pairs) || !pairs.length) return [];
  const upper = upperInclusive(operator);
  let below;
  let above;
  let minRhs;
  let maxRhs;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return [];
    const [lhs, rhs] = pair;
    if (!Number.isSafeInteger(lhs) || !Number.isSafeInteger(rhs)) return [];
    const diff = lhs - rhs;
    if (!Number.isSafeInteger(diff) || diff < min || diff > max) return [];
    if (upper ? diff <= 0 : diff < 0) {
      if (!below || diff > below[0] - below[1]) below = pair;
    } else if (!above || diff < above[0] - above[1]) {
      above = pair;
    }
    if (!minRhs || rhs < minRhs[1]) minRhs = pair;
    if (!maxRhs || rhs > maxRhs[1]) maxRhs = pair;
  }
  const seen = new Set();
  const evidence = [];
  for (const pair of [below, above, minRhs, maxRhs]) {
    if (!pair) continue;
    const key = `${pair[0]}:${pair[1]}`;
    if (!seen.has(key)) (seen.add(key), evidence.push(pair));
  }
  return evidence;
}

export function checkedMarginGaps(requests) {
  const batch = requests.map(({ pairs, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, operator = '>=' }) =>
    ({ pairs: extremalMarginPairs(pairs, min, max, operator), min, max, ...(operator === '>=' ? {} : { operator }) }));
  const answers = runDecisionBatch(batch, ['margins']);
  return answers?.every(gap => gap === null || Array.isArray(gap?.interval)) ? answers : null;
}

export function marginGaps(requests) {
  return checkedMarginGaps(requests) ?? requests.map(({ pairs, operator = '>=', min, max }) =>
    marginGap(pairs, operator, min, max));
}
