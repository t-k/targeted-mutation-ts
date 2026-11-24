import { byteOffsets } from './source-text.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';

// Fixed replacements for binary operators. Comparison boundaries come from the native extractor.
export const operatorRules = new Map([
  ['===', ['equality-negation/v1', '!==']],
  ['!==', ['equality-negation/v1', '===']],
  ['==', ['equality-negation/v1', '!=']],
  ['!=', ['equality-negation/v1', '==']],
  ['&&', ['logical-operator/v1', '||']],
  ['||', ['logical-operator/v1', '&&']],
  ['??', ['logical-operator/v1', '&&']],
  ['+', ['arithmetic-operator/v1', '-']],
  ['-', ['arithmetic-operator/v1', '+']],
  ['*', ['arithmetic-operator/v1', '/']],
  ['/', ['arithmetic-operator/v1', '*']],
  ['%', ['arithmetic-operator/v1', '*']],
]);

// Sites are in source order. Offsets are UTF-8 bytes, matching the native extractor's candidates.
export function collectOperatorSites(input, file, { dialect, ts = loadTypeScript() } = {}) {
  const text = input.toString('utf8');
  // An explicit dialect overrides the file name, as it does for the comparison extractor.
  const kind = dialect === 'tsx' ? ts.ScriptKind.TSX : dialect === 'ts' ? ts.ScriptKind.TS : undefined;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const concatenates = node => ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);
  const nullish = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
  // An operator character next to the token would merge with the replacement (`a*/* c */b` -> `a//* c */b`).
  const merges = unit => '+-*/=&|?!<>%'.includes(text[unit] ?? ' ');
  const found = [];
  (function visit(node, parent, statementStart) {
    // An enum member initializer must stay a constant expression for const and ambient enums.
    if (ts.isEnumDeclaration(node)) return;
    if (ts.isExpressionStatement(node)) statementStart = node.expression.getStart(tree);
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const start = token.getStart(tree);
      const operator = text.slice(start, token.end);
      const entry = operatorRules.get(operator);
      // Subtracting from a string is a type error, so the edit would fail to compile instead of testing the suite.
      const concatenation = operator === '+' && (concatenates(node.left) || concatenates(node.right));
      // `a && b ?? c` needs parentheses around an operand, which this edit does not add.
      const chained = operator === '??' && (nullish(parent) || nullish(node.left) || nullish(node.right));
      if (entry && !concatenation && !chained) {
        const first = node.left.getStart(tree);
        const statement = parent !== undefined && ts.isExpressionStatement(parent);
        // A parenthesis at the start of a statement could continue the previous line as a call.
        const leading = !statement && first === statementStart;
        const replacement = (merges(start - 1) ? ' ' : '') + entry[1] + (merges(token.end) ? ' ' : '');
        // Inside another binary expression a logical swap would regroup its neighbours: `a && b && c` -> `a || (b && c)`.
        const regroups = entry[0] === 'logical-operator/v1' && parent !== undefined && ts.isBinaryExpression(parent);
        found.push({ rule: entry[0], operator, replacement, statement, leading, regroups,
          spans: [start, token.end, first, node.left.end, node.right.getStart(tree), node.right.end] });
      }
    }
    ts.forEachChild(node, child => visit(child, node, statementStart));
  })(tree, undefined, undefined);
  if (!found.length) return [];
  const bytes = byteOffsets(text);
  return found.sort((a, b) => a.spans[0] - b.spans[0]).map(({ spans, statement, leading, regroups, ...site }) => {
    const [start, end, left, leftEnd, right, rightEnd] = spans.map(unit => bytes[unit]);
    const result = { ...site, edit: [start, end], left: [left, leftEnd], right: [right, rightEnd], unobserved: true };
    if (statement) result.statement = true;
    if (leading) result.leading = true;
    if (regroups) {
      const group = '(' + text.slice(spans[2], spans[0]) + site.replacement + text.slice(spans[1], spans[5]) + ')';
      result.source = { edit: [left, rightEnd], replacement: (leading ? 'void 0, ' : '') + group };
    }
    return result;
  });
}
