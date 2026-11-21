import { isUtf8 } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { types } from 'node:util';

const load = createRequire(import.meta.url);
const nativePath = new URL('../build/tmt.node', import.meta.url);
const native = existsSync(nativePath) ? load('../build/tmt.node') : null;
const replacements = new Map([['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>']]);
const operators = ['', '<', '<=', '>', '>='];
const reasons = ['', 'outside-l1', 'source-limit', 'depth-limit', 'candidate-limit'];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export const rule = 'comparison-boundary/v1';

export function byteOffsets(source) {
  const offsets = new Uint32Array(source.length + 1);
  let unit = 0;
  let byte = 0;
  for (const char of source) {
    offsets[unit] = byte;
    unit += char.length;
    byte += Buffer.byteLength(char);
  }
  offsets[unit] = byte;
  return offsets;
}

function optionsFor(options) {
  const dialect = options.dialect ?? (options.file?.endsWith('.tsx') ? 'tsx' : 'ts');
  const mode = options.mode ?? 'module';
  if (!['ts', 'tsx'].includes(dialect) || !['script', 'module'].includes(mode)) {
    throw new Error('Expected ts/tsx and script/module dialect options');
  }
  return { dialect, mode };
}

function normalize(input) {
  if (typeof input === 'string') return input.isWellFormed() ? input : null;
  try {
    return decoder.decode(input);
  } catch {
    return null;
  }
}

function invalidEncoding() {
  return { path: 'diagnostic', reason: 'invalid-utf8', candidates: [], diagnostics: [
    { severity: 'error', message: 'Expected well-formed UTF-8', start: 0, end: 0 },
  ] };
}

function tokenAfter(tokens, position) {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].start < position) low = mid + 1;
    else high = mid;
  }
  while (typeof tokens[low]?.type === 'string') low++;
  return tokens[low];
}

export function extractFallback(input, options = {}) {
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { dialect, mode } = optionsFor(options);
  const { parse } = load('@babel/parser');
  const offsets = Buffer.byteLength(source) === source.length ? null : byteOffsets(source);
  const bytes = index => offsets === null ? index : offsets[index];
  const span = node => [bytes(node.start), bytes(node.end)];
  const diagnostic = (message, start, end = start) => ({
    path: 'diagnostic', candidates: [], diagnostics: [{ severity: 'error', message, start: bytes(start), end: bytes(end) }],
  });
  const plugins = [['typescript', { dts: /\.d\.[cm]?ts$/.test(options.file) }], 'decoratorAutoAccessors', 'deprecatedImportAssert'];
  if (dialect === 'tsx') plugins.push('jsx');
  const parseWith = decorators => parse(source, {
    sourceType: mode, sourceFilename: options.file, plugins: [...plugins, decorators],
    tokens: true, createParenthesizedExpressions: true, attachComment: false,
  });
  let tree;
  try {
    try {
      tree = parseWith('decorators-legacy');
    } catch (error) {
      // Modern decorators may follow export. Legacy mode still accepts parameter decorators.
      if (error.reasonCode !== 'UnexpectedToken' || source[error.pos] !== '@') throw error;
      tree = parseWith('decorators');
    }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError) return diagnostic(error.message, error.pos ?? 0);
    throw error;
  }

  const candidates = [];
  const pending = [tree.program];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'BinaryExpression' && replacements.has(node.operator)) {
      const token = tokenAfter(tree.tokens, node.left.end);
      if (!token || token.end > node.right.start || source.slice(token.start, token.end) !== node.operator) {
        return diagnostic('Could not locate a comparison operator', node.start, node.end);
      }
      candidates.push({
        rule, operator: node.operator, replacement: replacements.get(node.operator),
        edit: span(token), left: span(node.left), right: span(node.right),
      });
    }
    if (options.logical && node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && node.name.name === 'disabled' &&
        node.value?.expression?.type === 'LogicalExpression' && node.value.expression.operator === '||') {
      const expression = node.value.expression;
      const token = tokenAfter(tree.tokens, expression.left.end);
      if (!token || token.end > expression.right.start || source.slice(token.start, token.end) !== '||') {
        return diagnostic('Could not locate a JSX logical operator', expression.start, expression.end);
      }
      candidates.push({
        rule: 'jsx-disabled-drop-left/v1', operator: '||', operatorEdit: span(token),
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

export function extract(input, options = {}) {
  if (!native && options.requireNative) throw new Error('Run npm run build:native to build the extractor');
  const { dialect, mode } = optionsFor(options);
  let reason = 'native-unavailable';
  let metrics;
  let fallbackInput = input;
  if (native) {
    const inputString = typeof input === 'string';
    let source;
    if (inputString) {
      if (!input.isWellFormed()) return invalidEncoding();
      source = Buffer.from(input);
    } else {
      try {
        const view = ArrayBuffer.isView(input);
        if (!view && !types.isAnyArrayBuffer(input)) return invalidEncoding();
        const buffer = view ? input.buffer : input;
        source = Buffer.from(buffer, view ? input.byteOffset : 0, input.byteLength);
        if (types.isSharedArrayBuffer(buffer)) fallbackInput = source = Buffer.from(source);
        if (!isUtf8(source)) return invalidEncoding();
      } catch {
        return invalidEncoding();
      }
    }
    const [status, maxDepth, astNodes, candidateBytes, ...rows] = native.parse(source, dialect === 'tsx', mode === 'module');
    metrics = { maxDepth, astNodes, candidateBytes };
    if (status === 0) {
      return { path: 'fast', metrics, candidates: rows.map(([op, replacement, a, b, c, d, e, f]) => ({
        rule, operator: operators[op], replacement: operators[replacement], edit: [a, b], left: [c, d], right: [e, f],
      })) };
    }
    reason = reasons[status];
  }
  return { ...extractFallback(fallbackInput, options), reason, metrics };
}
