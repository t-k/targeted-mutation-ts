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
export function collectOperatorSites(input, file, ts = loadTypeScript()) {
  const text = input.toString('utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const concatenates = node => ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);
  const found = [];
  (function visit(node) {
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const start = token.getStart(tree);
      const operator = text.slice(start, token.end);
      const entry = operatorRules.get(operator);
      // Subtracting from a string is a type error, so the edit would fail to compile instead of testing the suite.
      if (entry && !(operator === '+' && (concatenates(node.left) || concatenates(node.right)))) {
        found.push({ rule: entry[0], operator, replacement: entry[1],
          spans: [start, token.end, node.left.getStart(tree), node.left.end, node.right.getStart(tree), node.right.end] });
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  if (!found.length) return [];
  const bytes = byteOffsets(text);
  return found.sort((a, b) => a.spans[0] - b.spans[0]).map(({ spans, ...site }) => {
    const [start, end, left, leftEnd, right, rightEnd] = spans.map(unit => bytes[unit]);
    return { ...site, edit: [start, end], left: [left, leftEnd], right: [right, rightEnd], unobserved: true };
  });
}
