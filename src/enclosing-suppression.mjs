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

function isConstantInnerGap(diagnostic) {
  if (diagnostic?.kind !== 'INPUT GAP') return false;
  const rule = diagnostic.rule ?? diagnostic.mutations?.[0]?.rule;
  return rule === 'equality-constant/v1';
}

function isRedundantOuterGap(diagnostic) {
  if (diagnostic?.kind !== 'INPUT GAP') return false;
  const rule = diagnostic.rule ?? diagnostic.mutations?.[0]?.rule;
  if (rule !== 'ignored-operand/v1') return false;
  // Only suppress left-operand drop `(a, b)` when the inner left comparison is already reported as always-constant.
  // Never suppress right-operand drop `a && (b, true)` since that represents an independent test obligation.
  const replacement = String(diagnostic.mutations?.[0]?.replacement ?? '');
  return !replacement.includes('&&') && !replacement.includes('||') && !replacement.includes('??');
}

// Suppress duplicate outer `ignored-operand/v1` (left-drop) INPUT GAP when an inner expression
// strictly inside its span is already reported as an `equality-constant/v1` INPUT GAP.
export function suppressEnclosingDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length < 2) return diagnostics;
  const innerConstantGaps = diagnostics.filter(d => isConstantInnerGap(d) && hasSpan(d));
  if (!innerConstantGaps.length) return diagnostics;

  return diagnostics.filter(outer => {
    if (!isRedundantOuterGap(outer) || !hasSpan(outer)) return true;
    return !innerConstantGaps.some(inner => inner !== outer && strictlyEncloses(outer, inner));
  });
}
