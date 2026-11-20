import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yuku-parser';

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
  return { lang: dialect, sourceType: mode, path: options.file, tokens: true, preserveParens: true, semanticErrors: true };
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

export function extractYuku(input, options = {}) {
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { program, tokens, diagnostics } = parse(source, optionsFor(options));
  const bytes = byteOffsets(source);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return { path: 'diagnostic', candidates: [], diagnostics: diagnostics.map(diagnostic => ({
      ...diagnostic, start: bytes[diagnostic.start], end: bytes[diagnostic.end],
      labels: diagnostic.labels.map(label => ({ ...label, start: bytes[label.start], end: bytes[label.end] })),
    })) };
  }

  const candidates = [];
  const pending = [program];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'BinaryExpression' && replacements.has(node.operator)) {
      const token = tokens.after(node.left.end);
      const start = tokens.start(token);
      const end = tokens.end(token);
      if (tokens.text(token) !== node.operator || start < node.left.end || end > node.right.start) {
        return { path: 'diagnostic', candidates: [], diagnostics: [{
          severity: 'error', message: 'Yuku could not locate a comparison operator', start: bytes[node.start], end: bytes[node.end],
        }] };
      }
      candidates.push({
        rule, operator: node.operator, replacement: replacements.get(node.operator),
        edit: [bytes[start], bytes[end]],
        left: [bytes[node.left.start], bytes[node.left.end]], right: [bytes[node.right.start], bytes[node.right.end]],
      });
    }
    if (options.logical && node.type === 'JSXAttribute' && node.name.name === 'disabled' &&
        node.value?.expression?.type === 'LogicalExpression' && node.value.expression.operator === '||') {
      const expression = node.value.expression;
      const operator = tokens.after(expression.left.end);
      const operatorEdit = [bytes[tokens.start(operator)], bytes[tokens.end(operator)]];
      candidates.push({
        rule: 'jsx-disabled-drop-left/v1', operator: '||', operatorEdit,
        replacement: '(' + source.slice(expression.right.start, expression.right.end) + ')',
        edit: [bytes[expression.start], bytes[expression.end]],
        left: [bytes[expression.left.start], bytes[expression.left.end]],
        right: [bytes[expression.right.start], bytes[expression.right.end]],
      });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === 'string') pending.push(item);
      } else if (value && typeof value.type === 'string') {
        pending.push(value);
      }
    }
  }
  candidates.sort((a, b) => (a.operatorEdit ?? a.edit)[0] - (b.operatorEdit ?? b.edit)[0]);
  return { path: 'yuku', candidates };
}

export function extract(input, options = {}) {
  if (!native && options.requireNative) throw new Error('Run npm run build:native to build the extractor');
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { lang, sourceType } = optionsFor(options);
  let reason = 'native-unavailable';
  let metrics;
  if (native) {
    const [status, maxDepth, astNodes, candidateBytes, ...rows] = native.parse(
      typeof input === 'string' ? Buffer.from(source)
        : ArrayBuffer.isView(input) ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : Buffer.from(input),
      lang === 'tsx', sourceType === 'module',
    );
    metrics = { maxDepth, astNodes, candidateBytes };
    if (status === 0) {
      return { path: 'fast', metrics, candidates: rows.map(([op, replacement, a, b, c, d, e, f]) => ({
        rule, operator: operators[op], replacement: operators[replacement], edit: [a, b], left: [c, d], right: [e, f],
      })) };
    }
    reason = reasons[status];
  }
  const result = extractYuku(source, options);
  return { ...result, path: result.path === 'yuku' ? 'fallback' : 'diagnostic', reason, metrics };
}
