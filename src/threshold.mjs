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
