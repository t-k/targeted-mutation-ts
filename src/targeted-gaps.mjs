// What a surviving edit of the targeted rules says about the tests. The recording run noted, per test, whether
// the edit would have given the same value as the original after evaluating the same operands.
// No test in which it would not: the input that tells the two apart is missing. Otherwise the tests that had
// such an input passed all the same, so an assertion is missing.
const clip = text => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 57) + '...' : line;
};

function missingInput({ operator, form, boolean, left, differsFor, subject, pureRight }, expression) {
  const side = '`' + clip(left) + '`';
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
  if (!mutant.targeted || mutant.status !== 'survived' || !seen) return null;
  const common = {
    site: mutant.id, location: mutant.location, rule: mutant.mutatorName, expression: mutant.original,
    mutations: [{ rule: mutant.mutatorName, edit: mutant.edit, replacement: mutant.replacement, evidence: mutant.evidence }],
  };
  if (seen.differing.length || seen.outside) {
    return { kind: 'ASSERTION GAP', ...common, tests: seen.differing, ...(seen.outside ? { outsideTests: true } : {}),
      ...(seen.differ ? { example: { operands: seen.differ } } : {}) };
  }
  return { kind: 'INPUT GAP', ...common, reachedBy: seen.agreeing, missing: missingInput(mutant.targeted, mutant.original),
    ...(seen.agree ? { observed: { operands: seen.agree } } : {}) };
}
