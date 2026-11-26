// What a surviving edit of the targeted rules says about the tests. The recording run noted, per test, whether
// the edit would have given the same value as the original after evaluating the same operands.
// No test in which it would not: the input that tells the two apart is missing. Otherwise the tests that had
// such an input passed all the same, so an assertion is missing.
const clip = text => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 57) + '...' : line;
};

const rules = { arithmetic: 'arithmetic-swap/v1', extreme: 'extreme-swap/v1', rounding: 'rounding-swap/v1', ends: 'sequence-end/v1',
  order: 'sort-order/v1', awaited: 'await-dropped/v1', copy: 'copy-dropped/v1',
  spreadDrop: 'spread-property-drop/v1', prefixSubstring: 'prefix-to-substring/v1', replaceMultiplicity: 'replace-multiplicity/v1',
  clampBound: 'clamp-bound/v1', literalSetPrune: 'literal-set-prune/v1', mergePrecedence: 'merge-precedence/v1',
  quantifierSwap: 'quantifier-swap/v1', regexAnchor: 'regex-anchor-slack/v1', cleanupDropped: 'cleanup-dropped/v1' };
// What to assert where no recording can say which input is missing.
const advice = {
  [rules.awaited]: 'the tests pass when this call is not waited for: assert on what it has done before what follows it goes on',
  [rules.cleanupDropped]: 'the tests pass when this finally cleanup call is skipped: assert that the resource or state is cleaned up after the try block finishes or throws',
  [rules.copy]: 'the tests pass when this copy is the original itself: assert that the original is unchanged after the copy is changed, or that the two are not the same object',
  iterableCopy: 'the tests pass when this iterable is not converted to an array: assert that the result is an array (Array.isArray(...)) or use array operations on it',
  spreadCoercion: 'the tests pass when this object spread is replaced by its source directly: assert on the resulting plain object properties, prototype, or nullish handling',
};
// For which numbers two ways of rounding differ.
const roundingDiffers = { 'floor trunc': 'negative and not a whole number (-0.5)', 'ceil trunc': 'positive and not a whole number (0.5)',
  'floor round': 'a number that rounds up (1.5, -1.5)', 'ceil round': 'a number that rounds down (1.4, -1.6)',
  'round trunc': 'a number that rounds away from zero (1.5, -1.6)', 'ceil floor': 'not a whole number (0.5)' };

function missingInput({ operator, form, boolean, left, right: rightExpr, differsFor, subject, pureRight, rightFalsy, possibleFalsy, key, boundKind, pruned, argName }, expression, rule, replacement) {
  const side = '`' + clip(left) + '`';
  if (rule === rules.spreadDrop) return `a test in which \`${clip(left)}.${key}\` is missing or differs from its updated value`;
  if (rule === rules.prefixSubstring) {
    return `a test in which ${side} contains the ${operator === 'startsWith' ? 'prefix somewhere other than the start' : 'suffix somewhere other than the end'}`;
  }
  if (rule === rules.replaceMultiplicity) return `a test in which ${side} contains the searched text more than once`;
  if (rule === rules.clampBound) return `a test in which the value exceeds the ${boundKind === 'upper' ? 'upper' : 'lower'} clamp bound of \`${clip(expression)}\``;
  if (rule === rules.literalSetPrune) return `a test in which \`${clip(argName)}\` is ${pruned}`;
  if (rule === rules.mergePrecedence) return `a test in which ${side} and \`${clip(rightExpr)}\` share a key with different values`;
  if (rule === rules.quantifierSwap) return `a test in which ${side} is empty or has elements where the predicate gives both true and false`;
  if (rule === rules.regexAnchor) return `a test in which \`${clip(argName)}\` matches without the ${form === 'dropStart' ? 'leading `^`' : 'trailing `$`'} anchor`;
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
  if (form === 'or' || form === 'nullish') {
    const allFalsy = ['0', '0n', "''", 'false', 'NaN'];
    const baseValues = Array.isArray(possibleFalsy) && possibleFalsy.length ? possibleFalsy : allFalsy;
    const formatList = values => values.length === 1
      ? values[0]
      : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
    if (rightFalsy) {
      const filtered = baseValues.filter(value => value !== rightFalsy);
      const values = filtered.length
        ? filtered
        : baseValues.length === 1 && baseValues[0] === '0' && rightFalsy === '0'
          ? ['-0']
          : allFalsy.filter(value => value !== rightFalsy);
      return `a test in which ${side} is ${formatList(values)}`;
    }
    return `a test in which ${side} is ${formatList(baseValues)}${pureRight ? ' and not the right side\'s value' : ''}`;
  }
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
    ...(mutant.targeted?.equivalenceHint ? {
      equivalenceHint: mutant.targeted.equivalenceHint,
      equivalenceReason: mutant.targeted.equivalenceReason,
    } : {}),
    mutations: [{ rule: mutant.mutatorName, edit: mutant.edit, replacement: mutant.replacement, evidence: mutant.evidence,
      ...(mutant.source ? { source: mutant.source } : {}) }],
  };
  if (mutant.mutatorName === rules.copy) {
    const note = seen && !seen.realCopy && seen.nonArray ? advice.iterableCopy
      : seen && !seen.realCopy && seen.nonPlain ? advice.spreadCoercion
        : advice[rules.copy];
    return { kind: 'ASSERTION GAP', ...common, advice: note };
  }
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
