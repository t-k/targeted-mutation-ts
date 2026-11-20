const session = Symbol.for('targeted-mutation-ts/session');

export function compareFocused(id, operator, lhs, rhs) {
  const state = globalThis[session];
  const ns = globalThis.__stryker__;
  if (state?.phase === 'baseline' && state.focusedIds.has(id)) {
    const traces = ns.focused ??= Object.create(null);
    const rows = traces[id] ??= [];
    if (rows !== false) {
      if (!ns.currentTestId || rows.length >= 16_384 || !Number.isSafeInteger(lhs) || !Number.isSafeInteger(rhs) ||
          !Number.isSafeInteger(operator === '<' ? rhs - 1 : rhs + 1)) {
        traces[id] = false;
      } else {
        rows.push([ns.currentTestId, lhs, rhs]);
        const coverage = ns.mutantCoverage ??= { static: {}, perTest: {} };
        const counts = coverage.perTest[ns.currentTestId] ??= {};
        counts[id] = (counts[id] ?? 0) + 1;
      }
    }
  } else if (ns?.activeMutant === id) {
    if (++ns.hitCount > ns.hitLimit) throw new Error('TMT mutation hit limit reached');
    rhs = operator === '<' ? rhs - 1 : rhs + 1;
  }
  return operator === '<' ? lhs < rhs : lhs > rhs;
}
