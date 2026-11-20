export function tighteningEdit(source, site) {
  const adjustment = site.operator === '<' ? -1 : 1;
  const operand = source.subarray(...site.right).toString();
  const literal = /^\d+$/.test(operand) ? Number(operand) : NaN;
  const replacement = Number.isSafeInteger(literal) && Number.isSafeInteger(literal + adjustment) && literal + adjustment >= 0
    ? String(literal + adjustment)
    : `((${operand}) ${adjustment < 0 ? '-' : '+'} 1)`;
  return { site, edit: site.right, replacement, rule: 'comparison-tighten/v1', adjustment };
}

export function tightenComparison(source, site, observation, enabled) {
  if (!enabled || !observation.complete || !observation.rows.length || !['<', '>'].includes(site.operator)) return null;
  const trial = tighteningEdit(source, site);
  if (observation.rows.some(({ operands }) => !Number.isSafeInteger(operands[1] + trial.adjustment))) return null;
  return { ...trial, observation };
}
