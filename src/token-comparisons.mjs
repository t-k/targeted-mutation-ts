const replacements = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);

function ambientTypeEnd(kind, tokens, kinds) {
  if (kind(0) !== kinds.Declare || kind(1) !== kinds.Const || kind(2) !== kinds.Identifier ||
      kind(3) !== kinds.Colon || kind(4) !== kinds.Identifier || kind(5) !== kinds.LessThan) return -1;
  const type = new Set([kinds.Identifier, kinds.String, kinds.Number, kinds.Boolean, kinds.Any,
    kinds.Unknown, kinds.Never, kinds.Object, kinds.Symbol, kinds.Bigint, kinds.Undefined, kinds.NullLiteral]);
  let end = 6;
  if (!type.has(kind(end))) return -1;
  end++;
  while (kind(end) === kinds.Comma && type.has(kind(end + 1))) end += 2;
  if (kind(end) !== kinds.GreaterThan) return -1;
  const after = end + 1;
  if (after === tokens.length || kind(after) === kinds.Semicolon) return end;
  const statement = [kinds.Const, kinds.Let, kinds.Var, kinds.Declare, kinds.Import, kinds.Export,
    kinds.Function, kinds.Class, kinds.If, kinds.For, kinds.While];
  return statement.includes(kind(after)) && tokens.newlineBefore(after) ? end : -1;
}

export function tokenComparisons(tokens, kinds, bytes, first) {
  const kind = i => i >= 0 && i < tokens.length ? tokens.kind(i) : -1;
  const identifier = k => k === kinds.Identifier || k === kinds.This;
  const atom = k => identifier(k) || k === kinds.NumericLiteral;
  const result = [];
  // The caller has validated the whole file. Every relational token must still be classified.
  for (let i = first; i < tokens.length; i++) {
    const operatorKind = kind(i);
    if (operatorKind !== kinds.LessThan && operatorKind !== kinds.LessThanEqual &&
        operatorKind !== kinds.GreaterThan && operatorKind !== kinds.GreaterThanEqual) continue;
    if (i === 5 && operatorKind === kinds.LessThan) {
      const end = ambientTypeEnd(kind, tokens, kinds);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    let left = i - 1;
    let right = i + 1;
    if (!atom(kind(left)) || !atom(kind(right))) return null;
    while (kind(left) === kinds.Identifier && kind(left - 1) === kinds.Dot && identifier(kind(left - 2))) left -= 2;
    if (identifier(kind(right))) {
      while (kind(right + 1) === kinds.Dot && kind(right + 2) === kinds.Identifier) right += 2;
    }
    const before = kind(left - 1);
    const after = kind(right + 1);
    const guard = kind(left - 2);
    const direct = before === kinds.LeftParen && (guard === kinds.If || guard === kinds.While) && after === kinds.RightParen;
    const declaration = kind(left - 5);
    const forGuard = before === kinds.Semicolon && after === kinds.Semicolon && (
      guard === kinds.LeftParen && kind(left - 3) === kinds.For ||
      (declaration === kinds.Let || declaration === kinds.Const || declaration === kinds.Var) &&
      kind(left - 6) === kinds.LeftParen && kind(left - 7) === kinds.For &&
      kind(left - 4) === kinds.Identifier && kind(left - 3) === kinds.Assign && kind(left - 2) === kinds.NumericLiteral
    );
    if (!direct && !forGuard) return null;
    const operator = tokens.text(i);
    if (!replacements.has(operator)) return null;
    const span = (start, end) => [bytes(tokens.start(start)), bytes(tokens.end(end))];
    result.push({ rule: 'comparison-boundary/v1', operator, replacement: replacements.get(operator),
      edit: span(i, i), left: span(left, i - 1), right: span(i + 1, right) });
  }
  return result.length ? result : null;
}
