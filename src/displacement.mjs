export function tightenComparison(source, site, observation, enabled) {
  if (!enabled || !observation.complete || !observation.rows.length || !['<', '>'].includes(site.operator)) return null;
  const adjustment = site.operator === '<' ? -1 : 1;
  if (observation.rows.some(({ operands }) => !Number.isSafeInteger(operands[1] + adjustment))) return null;
  const operand = source.subarray(...site.right).toString();
  const literal = /^\d+$/.test(operand) ? Number(operand) : NaN;
  const replacement = literal >= 0 && literal + adjustment >= 0 && observation.rows.every(row => row.operands[1] === literal)
    ? String(literal + adjustment)
    : `((${operand}) ${adjustment < 0 ? '-' : '+'} 1)`;
  return { site, edit: site.right, replacement, rule: 'comparison-tighten/v1', observation, adjustment };
}
