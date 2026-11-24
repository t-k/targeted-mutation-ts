import { loadTypeScript } from './typescript-compiler.mjs';

function stripParens(node, ts) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function intLiteral(node, ts) {
  node = stripParens(node, ts);
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const value = -Number(node.operand.text);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  return undefined;
}

function isNonNegativeExpr(node, ts) {
  node = stripParens(node, ts);
  if (!node) return false;
  if (ts.isPropertyAccessExpression(node) && ['length', 'size', 'byteLength'].includes(node.name.text)) {
    return true;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math' &&
      node.expression.name.text === 'abs') {
    return true;
  }
  return false;
}

// Extract a sound integer reachability constraint from the outer operator of a comparison's LHS.
export function extractReachability(lhsText, ts = loadTypeScript()) {
  if (typeof lhsText !== 'string' || !lhsText.trim()) return null;
  const wrapped = `(${lhsText});`;
  const sf = ts.createSourceFile('lhs.ts', wrapped, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length || sf.statements.length !== 1 || !ts.isExpressionStatement(sf.statements[0])) {
    return null;
  }
  const node = stripParens(sf.statements[0].expression, ts);
  if (!node) return null;

  if (isNonNegativeExpr(node, ts)) {
    return { kind: 'nonNegative', min: 0 };
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const leftLit = intLiteral(node.left, ts);
    const rightLit = intLiteral(node.right, ts);

    if (op === ts.SyntaxKind.PercentToken && rightLit !== undefined && rightLit > 0) {
      const nonNeg = isNonNegativeExpr(node.left, ts);
      return { kind: 'remainder', divisor: rightLit, min: nonNeg ? 0 : -(rightLit - 1), max: rightLit - 1 };
    }

    if (op === ts.SyntaxKind.AmpersandToken) {
      const mask = rightLit !== undefined ? rightLit : leftLit;
      if (mask !== undefined && mask >= 0 && mask <= 0x7fffffff) {
        return { kind: 'bitmask', mask };
      }
    }

    if (op === ts.SyntaxKind.LessThanLessThanToken && rightLit !== undefined && rightLit >= 1 && rightLit <= 30) {
      return { kind: 'step', step: 1 << rightLit };
    }
  }

  return null;
}

export function isReachable(value, constraint) {
  if (!Number.isSafeInteger(value)) return false;
  if (!constraint) return true;
  switch (constraint.kind) {
    case 'nonNegative':
      return value >= constraint.min;
    case 'remainder':
      return value >= constraint.min && value <= constraint.max;
    case 'bitmask':
      return value >= 0 && value <= constraint.mask && ((value & ~constraint.mask) === 0);
    case 'step':
      return value % constraint.step === 0;
    default:
      return true;
  }
}

// Find the smallest reachable integer >= start (up to limit), or null if none exists.
export function nextReachableAtOrAbove(start, limit, constraint) {
  if (start > limit) return null;
  if (!constraint) return start;
  switch (constraint.kind) {
    case 'nonNegative': {
      const v = Math.max(start, constraint.min);
      return v <= limit ? v : null;
    }
    case 'remainder': {
      const v = Math.max(start, constraint.min);
      const hi = Math.min(limit, constraint.max);
      return v <= hi ? v : null;
    }
    case 'step': {
      const s = constraint.step;
      const rem = ((start % s) + s) % s;
      const v = rem === 0 ? start : start + (s - rem);
      return Number.isSafeInteger(v) && v <= limit ? v : null;
    }
    case 'bitmask': {
      const mask = constraint.mask;
      const lo = Math.max(0, start);
      const hi = Math.min(mask, limit);
      if (lo > hi) return null;
      // Compute smallest v >= lo such that (v & ~mask) === 0 via bit trick:
      // For any bit in lo that is outside mask, clear lower bits and carry into the lowest mask bit above it.
      let v = lo;
      const bad = v & ~mask;
      if (bad !== 0) {
        const highestBadBit = 1 << (31 - Math.clz32(bad));
        // Find lowest mask bit strictly above highestBadBit that is not already set in v.
        const aboveFreeMask = (mask & ~v) & (~((highestBadBit << 1) - 1));
        if (aboveFreeMask === 0) return null;
        const carryBit = aboveFreeMask & -aboveFreeMask;
        v = (v & ~(carryBit - 1)) | carryBit;
      }
      return v <= hi ? v : null;
    }
    default:
      return start;
  }
}

// Find the largest reachable integer <= end (down to floor), or null if none exists.
export function prevReachableAtOrBelow(end, floor, constraint) {
  if (end < floor) return null;
  if (!constraint) return end;
  switch (constraint.kind) {
    case 'nonNegative': {
      const lo = Math.max(floor, constraint.min);
      return end >= lo ? end : null;
    }
    case 'remainder': {
      const lo = Math.max(floor, constraint.min);
      const v = Math.min(end, constraint.max);
      return v >= lo ? v : null;
    }
    case 'step': {
      const s = constraint.step;
      const rem = ((end % s) + s) % s;
      const v = end - rem;
      return Number.isSafeInteger(v) && v >= floor ? v : null;
    }
    case 'bitmask': {
      const mask = constraint.mask;
      const lo = Math.max(0, floor);
      const hi = Math.min(mask, end);
      if (lo > hi) return null;
      let v = hi;
      const bad = v & ~mask;
      if (bad !== 0) {
        const highestBadBit = 1 << (31 - Math.clz32(bad));
        // Keep bits above highestBadBit masked by `mask`, and set all mask bits below highestBadBit.
        v = (v & ~(highestBadBit - 1) & ~highestBadBit & mask) | (mask & (highestBadBit - 1));
      }
      return v >= lo ? v : null;
    }
    default:
      return end;
  }
}

function evaluateOp(operator, lhs, rhs) {
  switch (operator) {
    case '<': return lhs < rhs;
    case '<=': return lhs <= rhs;
    case '>': return lhs > rhs;
    case '>=': return lhs >= rhs;
  }
}

// Filter a thresholdGap result using an extracted reachability constraint.
// Returns null when no reachable integer can distinguish any feasible alternate threshold from `threshold`.
export function filterReachableThresholdGap(gap, constraint, threshold, operator, observations = []) {
  if (!gap || !constraint) return gap;
  // Soundness guard: only apply the constraint if every observed LHS value actually obeys it.
  if (observations.length > 0 && observations.some(v => !isReachable(v, constraint))) {
    return gap;
  }
  const [lo, hi] = gap.interval;
  const upper = operator === '>' || operator === '<=';

  // Check both directions from threshold inside [lo, hi] for the nearest reachable distinguishing witness.
  // For upper-inclusive (`>` / `<=`):
  //   - alt > threshold separates values v in (threshold, alt] -> need reachable v in [threshold + 1, hi].
  //   - alt < threshold separates values v in (alt, threshold] -> need reachable v in [lo + 1, threshold].
  // For lower-inclusive (`<` / `>=`):
  //   - alt < threshold separates values v in [alt, threshold) -> need reachable v in [lo, threshold - 1].
  //   - alt > threshold separates values v in [threshold, alt) -> need reachable v in [threshold, hi - 1].
  const checkAbove = () => {
    if (threshold >= hi) return null;
    if (upper) {
      const v = nextReachableAtOrAbove(threshold + 1, hi, constraint);
      if (v === null) return null;
      return { alternate: v, witness: v };
    }
    const v = nextReachableAtOrAbove(threshold, hi - 1, constraint);
    if (v === null) return null;
    return { alternate: v + 1, witness: v };
  };

  const checkBelow = () => {
    if (lo >= threshold) return null;
    if (upper) {
      const v = prevReachableAtOrBelow(threshold, lo + 1, constraint);
      if (v === null) return null;
      return { alternate: v - 1, witness: v };
    }
    const v = prevReachableAtOrBelow(threshold - 1, lo, constraint);
    if (v === null) return null;
    return { alternate: v, witness: v };
  };

  const chosen = upper ? (checkAbove() ?? checkBelow()) : (checkBelow() ?? checkAbove());
  if (!chosen) return null;
  return {
    interval: gap.interval,
    alternate: chosen.alternate,
    witness: chosen.witness,
    expected: evaluateOp(operator, chosen.witness, threshold),
    mutant: evaluateOp(operator, chosen.witness, chosen.alternate),
    constraint: constraint.kind,
  };
}

// Check whether the exact equality boundary `lhs === threshold` is reachable under the constraint.
export function isBoundaryReachable(constraint, threshold, observations = []) {
  if (!constraint) return true;
  if (observations.length > 0 && observations.some(v => !isReachable(v, constraint))) return true;
  return isReachable(threshold, constraint);
}

// Check if `lhsText` is a simple identifier initialized to >= 0 and monotonically incremented
// in an enclosing `for (let i = 0; ...; i++)` statement without downward mutation in the loop body.
export function extractLoopCounterNonNegative(sourceText, siteOffset, lhsText, ts = loadTypeScript()) {
  if (typeof lhsText !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lhsText.trim())) return null;
  const name = lhsText.trim();
  const sf = ts.createSourceFile('loop.ts', sourceText, ts.ScriptTarget.Latest, true);
  if (sf.parseDiagnostics.length) return null;

  function initNonNegative(forNode) {
    const init = forNode.initializer;
    if (!init || !ts.isVariableDeclarationList(init)) return false;
    for (const decl of init.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        const val = intLiteral(decl.initializer, ts);
        if (val !== undefined && val >= 0) return true;
      }
    }
    return false;
  }

  function incrementorNonDecreasing(forNode) {
    const inc = stripParens(forNode.incrementor, ts);
    if (!inc) return false;
    if ((ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) &&
        inc.operator === ts.SyntaxKind.PlusPlusToken &&
        ts.isIdentifier(inc.operand) && inc.operand.text === name) {
      return true;
    }
    if (ts.isBinaryExpression(inc) && inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        ts.isIdentifier(inc.left) && inc.left.text === name) {
      const step = intLiteral(inc.right, ts);
      return step !== undefined && step >= 0;
    }
    return false;
  }

  function bodyMutatesName(body) {
    let mutated = false;
    (function walk(node) {
      if (mutated) return;
      if (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          ts.isIdentifier(stripParens(node.left, ts)) && stripParens(node.left, ts).text === name) {
        mutated = true;
        return;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
          ts.isIdentifier(stripParens(node.operand, ts)) && stripParens(node.operand, ts).text === name) {
        mutated = true;
        return;
      }
      ts.forEachChild(node, walk);
    })(body);
    return mutated;
  }

  let found = false;
  (function visit(node, shadowed = false) {
    if (found) return;
    if (node.pos <= siteOffset && siteOffset <= node.end) {
      if (ts.isForStatement(node) && initNonNegative(node) && incrementorNonDecreasing(node) && !bodyMutatesName(node.statement)) {
        // Verify no inner block/declaration shadows `name` around `siteOffset`.
        let innerShadowed = false;
        (function checkShadow(inner) {
          if (innerShadowed || inner === node.initializer) return;
          if (inner.pos <= siteOffset && siteOffset <= inner.end) {
            if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.name.text === name && inner.end <= siteOffset) {
              innerShadowed = true;
              return;
            }
            if (ts.isParameter(inner) && ts.isIdentifier(inner.name) && inner.name.text === name) {
              innerShadowed = true;
              return;
            }
            ts.forEachChild(inner, checkShadow);
          }
        })(node.statement);
        if (!innerShadowed) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, child => visit(child, shadowed));
    }
  })(sf);

  return found ? { kind: 'nonNegative', min: 0 } : null;
}
