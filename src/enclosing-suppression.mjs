const ENCLOSING_LOGICAL_RULES = new Set([
  'ignored-operand/v1',
  'equality-constant/v1',
  'nullish-fallback/v1',
]);

function hasSpan(diagnostic) {
  return diagnostic?.location &&
    typeof diagnostic.location.file === 'string' &&
    typeof diagnostic.location.start === 'number' &&
    typeof diagnostic.location.end === 'number';
}

function strictlyEncloses(outer, inner) {
  return outer.location.file === inner.location.file &&
    outer.location.start <= inner.location.start &&
    inner.location.end <= outer.location.end &&
    (outer.location.start < inner.location.start || inner.location.end < outer.location.end);
}

// Suppress duplicate outer logical INPUT GAP diagnostics when an inner expression strictly inside
// the same span already has an INPUT GAP (e.g., `a > 0` is always true, so `a > 0 && b` should not
// emit a redundant ignored-operand INPUT GAP).
export function suppressEnclosingDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length < 2) return diagnostics;
  const innerInputGaps = diagnostics.filter(d => d?.kind === 'INPUT GAP' && hasSpan(d));
  if (!innerInputGaps.length) return diagnostics;

  return diagnostics.filter(outer => {
    if (outer?.kind !== 'INPUT GAP' || !hasSpan(outer)) return true;
    const rule = outer.rule ?? outer.mutations?.[0]?.rule;
    if (!ENCLOSING_LOGICAL_RULES.has(rule)) return true;
    return !innerInputGaps.some(inner => inner !== outer && strictlyEncloses(outer, inner));
  });
}
