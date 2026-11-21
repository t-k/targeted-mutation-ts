import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { tokenComparisons } from './token-comparisons.mjs';

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

// Extracted operator starts are in byte order and lie on UTF-8 code-point boundaries.
export function byteLocations(source, offsets) {
  if (!offsets.length) return [];
  if (native?.locations && source.length < 0xffffffff) return native.locations(source, Uint32Array.from(offsets));
  return offsets.flatMap(offset => {
    const lines = source.toString('utf8', 0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
    return [lines.length, lines.at(-1).length + 1];
  });
}

export function sourceDialect(file) {
  return /\.[jt]sx$/.test(file) ? 'tsx' : 'ts';
}

function optionsFor(options) {
  const dialect = options.dialect ?? sourceDialect(options.file);
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

function extractParsed(input, options = {}, allowTokens = false) {
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { dialect, mode } = optionsFor(options);
  const { parse, TokenKind } = load('yuku-parser');
  const parsed = parse(source, {
    lang: dialect, sourceType: mode, path: options.file, tokens: true, preserveParens: true, semanticErrors: true,
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

export function extractFallback(input, options = {}, allowTokens = false) {
  if (isMainThread) return extractParsed(input, options, allowTokens);

  // Native fallback parsing can exhaust a caller's deliberately small worker stack.
  const source = normalize(input);
  if (source === null) return invalidEncoding();
  const { dialect, mode } = optionsFor(options);
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=512', fileURLToPath(new URL('./fallback-process.mjs', import.meta.url)),
  ], {
    input: JSON.stringify({ source, options: { dialect, mode, logical: !!options.logical, file: options.file }, allowTokens }),
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL',
  });
  if (child.error || child.status !== 0) {
    const reason = child.error?.message ?? (child.signal ? `signal ${child.signal}` : `status ${child.status}`);
    const stderr = child.stderr?.trim();
    const cause = child.error ?? (stderr ? new Error(stderr.slice(0, 1024)) : undefined);
    throw new Error(`The isolated parser failed with ${reason}`, { cause });
  }
  try {
    return JSON.parse(child.output[3]);
  } catch (cause) {
    throw new Error('The isolated parser returned an unreadable result', { cause });
  }
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
    if (native.standalone) {
      return { path: 'diagnostic', reason, metrics, candidates: [], diagnostics: [{
        severity: 'error', message: 'Standalone Low* extraction declined the source', start: 0, end: 0,
      }] };
    }
  }
  return { ...extractFallback(fallbackInput, options, true), reason, metrics };
}
