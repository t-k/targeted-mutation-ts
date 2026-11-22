import { createRequire } from 'node:module';
import { byteOffsets, invalidEncoding, normalize, optionsFor } from '../../src/source-text.mjs';
import { tokenComparisons } from './token-comparisons.mjs';

const load = createRequire(import.meta.url);
const replacements = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);
const rule = 'comparison-boundary/v1';

function operatorSpan(tokens, node) {
  const token = tokens.after(node.left.end);
  if (token < 0) return;
  const start = tokens.start(token);
  const end = tokens.end(token);
  if (start >= node.left.end && end <= node.right.start && tokens.text(token) === node.operator) return { start, end };
}

function firstOperator(tokens, kinds, logical) {
  const { LessThan, GreaterThan, LessThanEqual, GreaterThanEqual, LogicalOr } = kinds;
  for (let index = 0; index < tokens.length; index++) {
    const kind = tokens.kind(index);
    if (kind === LessThan || kind === GreaterThan || kind === LessThanEqual || kind === GreaterThanEqual ||
        logical && kind === LogicalOr) return index;
  }
  return -1;
}

export function extractYuku(input, options = {}, allowTokens = false) {
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { dialect, mode } = optionsFor(options);
  const { parse, TokenKind } = load('yuku-parser');
  const parsed = parse(source, {
    lang: options.declarationFile ? 'dts' : dialect, sourceType: mode, path: options.file, tokens: true, preserveParens: true, semanticErrors: true,
  });
  const { diagnostics } = parsed;
  const hasErrors = diagnostics.some(diagnostic => diagnostic.severity === 'error');
  const tokens = hasErrors ? undefined : parsed.tokens;
  const first = tokens ? firstOperator(tokens, TokenKind, options.logical) : -1;
  if (tokens && first === -1) return { path: 'fallback', candidates: [] };
  let offsets;
  const bytes = index => {
    if (offsets === undefined) offsets = Buffer.byteLength(source) === source.length ? null : byteOffsets(source);
    return offsets === null ? index : offsets[index];
  };
  const span = node => [bytes(node.start), bytes(node.end)];
  if (hasErrors) {
    const relocate = location => ({ ...location, start: bytes(location.start), end: bytes(location.end) });
    return {
      path: 'diagnostic', candidates: [], diagnostics: diagnostics.map(diagnostic => ({
        ...relocate(diagnostic), labels: diagnostic.labels.map(relocate),
      })),
    };
  }
  if (allowTokens && dialect === 'ts' && tokens) {
    const candidates = tokenComparisons(tokens, TokenKind, bytes, first);
    if (candidates) return { path: 'fallback', fallback: 'tokens', candidates };
  }
  const missingOperator = node => ({
    path: 'diagnostic', candidates: [], diagnostics: [{
      severity: 'error', message: 'Could not locate an expression operator', start: bytes(node.start), end: bytes(node.end),
    }],
  });

  const candidates = [];
  const pending = [parsed.program];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'BinaryExpression' && replacements.has(node.operator)) {
      const operator = operatorSpan(tokens, node);
      if (!operator) return missingOperator(node);
      candidates.push({
        rule, operator: node.operator, replacement: replacements.get(node.operator),
        edit: span(operator), left: span(node.left), right: span(node.right),
      });
    }
    if (options.logical && node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && node.name.name === 'disabled' &&
        node.value?.expression?.type === 'LogicalExpression' && node.value.expression.operator === '||') {
      const expression = node.value.expression;
      const operator = operatorSpan(tokens, expression);
      if (!operator) return missingOperator(expression);
      candidates.push({
        rule: 'jsx-disabled-drop-left/v1', operator: '||', operatorEdit: span(operator),
        replacement: '(' + source.slice(expression.right.start, expression.right.end) + ')',
        edit: span(expression), left: span(expression.left), right: span(expression.right),
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === 'string') pending.push(item);
      } else if (value && typeof value.type === 'string') pending.push(value);
    }
  }
  candidates.sort((a, b) => (a.operatorEdit ?? a.edit)[0] - (b.operatorEdit ?? b.edit)[0]);
  return { path: 'fallback', candidates };
}
