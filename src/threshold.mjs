import { runDecisionBatch } from './lean-replay.mjs';

export function thresholdGap(threshold, observations, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (![threshold, min, max].every(Number.isSafeInteger) || threshold < min || threshold > max || !observations.length) {
    return null;
  }
  let lower = min;
  let upper = max;
  for (const input of observations) {
    if (!Number.isSafeInteger(input) || input < min || input > max) return null;
    if (input < threshold) lower = Math.max(lower, input + 1);
    else upper = Math.min(upper, input);
  }

  const alternate = lower < threshold ? threshold - 1 : upper > threshold ? threshold + 1 : null;
  if (alternate === null) return null;
  const witness = Math.min(alternate, threshold);
  return { interval: [lower, upper], alternate, witness, expected: witness >= threshold, mutant: witness >= alternate };
}

export function checkedThresholdGaps(requests) {
  const batch = requests.map(({ threshold, observations, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }) =>
    ({ threshold, observations, min, max }));
  const answers = runDecisionBatch(batch, ['thresholds']);
  return answers?.every(gap => gap === null || Array.isArray(gap?.interval)) ? answers : null;
}

export function thresholdGaps(requests) {
  return checkedThresholdGaps(requests) ?? requests.map(({ threshold, observations, min, max }) =>
    thresholdGap(threshold, observations, min, max));
}
