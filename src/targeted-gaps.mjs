// What a surviving edit of the targeted rules says about the tests. The recording run noted, per test, whether
// the edit would have given the same value as the original after evaluating the same operands.
// No test in which it would not: the input that tells the two apart is missing. Otherwise the tests that had
// such an input passed all the same, so an assertion is missing.
const clip = text => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 57) + '...' : line;
};

const rules = { arithmetic: 'arithmetic-swap/v1', extreme: 'extreme-swap/v1', rounding: 'rounding-swap/v1', ends: 'sequence-end/v1',
  order: 'sort-order/v1', awaited: 'await-dropped/v1', copy: 'copy-dropped/v1' };
// What to assert where no recording can say which input is missing.
const advice = {
  [rules.awaited]: 'the tests pass when this call is not waited for: assert on what it has done by the time the function ends',
  [rules.copy]: 'the tests pass when this copy is the original itself: assert that the original is unchanged after the copy is changed, or that the two are not the same object',
};
// For which numbers two ways of rounding differ.
const roundingDiffers = { 'floor trunc': 'negative and not a whole number (-0.5)', 'ceil trunc': 'positive and not a whole number (0.5)',
  'floor round': 'a number that rounds up (1.5, -1.5)', 'ceil round': 'a number that rounds down (1.4, -1.6)',
  'round trunc': 'a number that rounds away from zero (1.5, -1.6)', 'ceil floor': 'not a whole number (0.5)' };

function missingInput({ operator, form, boolean, left, differsFor, subject, pureRight }, expression, rule, replacement) {
  const side = '`' + clip(left) + '`';
  if (rule === rules.arithmetic) return `a test in which \`${clip(expression)}\` is not \`${clip(replacement)}\``;
  if (rule === rules.order) return `a test in which ${side} holds numbers whose order as text is not their order as numbers (9 and 10)`;
  if (rule === rules.extreme) return `a test in which the two arguments of \`${clip(expression)}\` differ`;
  if (rule === rules.rounding) return `a test in which ${side} is ${roundingDiffers[[operator, form].sort().join(' ')]}`;
  if (rule === rules.ends) {
    return operator.startsWith('find') ? `a test in which ${side} has two or more elements`
      : operator.endsWith('ndexOf') ? `a test in which ${side} holds the searched value more than once`
        : `a test in which ${side} has two or more elements and the first is not the last`;
  }
  if (form === 'true' || form === 'false') return `a test in which \`${clip(expression)}\` is ${form === 'true' ? 'false' : 'true'}`;
  if (form === 'loose' || form === 'strict' || form === 'other') return `a test in which \`${clip(subject)}\` is ${differsFor}`;
  if (form === 'or' || form === 'nullish') return `a test in which ${side} is 0, 0n, '', false or NaN${pureRight ? ' and not the right side\'s value' : ''}`;
  const takesRight = { '&&': 'truthy', '||': 'falsy', '??': 'null or undefined' }[operator];
  if (form === 'left') return `a test in which ${side} is ${{ '&&': 'falsy', '||': 'truthy', '??': 'neither null nor undefined' }[operator]}`;
  const kept = { '&&': 'true', '||': 'false', '??': 'undefined' }[operator];
  const right = boolean ? (operator === '&&' ? 'falsy' : 'truthy') : `not ${kept}`;
  return `a test in which ${side} is ${takesRight} and the right side is ${right}`;
}

export function targetedGap(mutant, seen) {
  if (!mutant.targeted || mutant.status !== 'survived' || (!seen && !advice[mutant.mutatorName])) return null;
  const common = {
    site: mutant.id, location: mutant.location, rule: mutant.mutatorName, expression: mutant.original,
    mutations: [{ rule: mutant.mutatorName, edit: mutant.edit, replacement: mutant.replacement, evidence: mutant.evidence,
      ...(mutant.source ? { source: mutant.source } : {}) }],
  };
  if (!seen) return { kind: 'ASSERTION GAP', ...common, advice: advice[mutant.mutatorName] };
  if (seen.differing.length || seen.outside) {
    return { kind: 'ASSERTION GAP', ...common, tests: seen.differing, ...(seen.outside ? { outsideTests: true } : {}),
      ...(seen.differ ? { example: { operands: seen.differ } } : {}) };
  }
  const missing = missingInput(mutant.targeted, mutant.original, mutant.mutatorName, mutant.replacement);
  // Where the recording could not work the edit out (a search callback, an object among the operands), the
  // tests may have the input already and only lack the assertion.
  if (seen.unsure?.length || seen.outsideUnsure) {
    return { kind: 'INPUT GAP', ...common, missing, uncertain: true, tests: seen.unsure ?? [], ...(seen.outsideUnsure ? { outsideTests: true } : {}),
      ...(seen.unknown ? { example: { operands: seen.unknown } } : {}) };
  }
  return { kind: 'INPUT GAP', ...common, reachedBy: seen.agreeing, missing, ...(seen.agree ? { observed: { operands: seen.agree } } : {}) };
}
