const operators = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);

export function tokenComparisons(tokens, kinds, bytes) {
  const kind = i => i >= 0 && i < tokens.length ? tokens.kind(i) : -1;
  const atom = i => {
    const first = i;
    if (kind(i) !== kinds.Identifier && kind(i) !== kinds.NumericLiteral) return null;
    const identifier = kind(i) === kinds.Identifier;
    i++;
    while (identifier && kind(i) === kinds.Dot && kind(i + 1) === kinds.Identifier) i += 2;
    return { next: i, span: [bytes(tokens.start(first)), bytes(tokens.end(i - 1))] };
  };
  const result = [];
  const accepted = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const k = kind(i);
    if (k !== kinds.If && k !== kinds.While && k !== kinds.For) continue;
    if (kind(i + 1) !== kinds.LeftParen) continue;
    let start = i + 2;
    if (k === kinds.For) {
      if (![kinds.Let, kinds.Const, kinds.Var].includes(kind(start)) || kind(start + 1) !== kinds.Identifier ||
          kind(start + 2) !== kinds.Assign || kind(start + 3) !== kinds.NumericLiteral ||
          kind(start + 4) !== kinds.Semicolon) continue;
      start += 5;
    }
    const left = atom(start);
    if (!left) continue;
    const opIndex = left.next;
    const op = opIndex < tokens.length ? tokens.text(opIndex) : '';
    if (!operators.has(op)) continue;
    const right = atom(opIndex + 1);
    if (!right || kind(right.next) !== (k === kinds.For ? kinds.Semicolon : kinds.RightParen)) continue;
    accepted.add(opIndex);
    result.push({ rule: 'comparison-boundary/v1', operator: op, replacement: operators.get(op),
      edit: [bytes(tokens.start(opIndex)), bytes(tokens.end(opIndex))], left: left.span, right: right.span });
  }
  for (let i = 0; i < tokens.length; i++) {
    if ([kinds.LessThan, kinds.LessThanEqual, kinds.GreaterThan, kinds.GreaterThanEqual].includes(kind(i)) && !accepted.has(i)) return null;
  }
  return result.length ? result : null;
}
