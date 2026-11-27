import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadTypeScript } from './typescript-compiler.mjs';

const BASELINE_VERSION = 2;
const TMT_IGNORE_RE = /^\s*tmt:ignore(?:\s+(.*))?$/i;

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineOfOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

// Parse `// tmt:ignore [reason]` and `/* tmt:ignore [reason] */` comments using the TypeScript AST
// so occurrences inside template literals, strings, or after regex literals are handled accurately.
export function tmtIgnoreLines(text, ts = loadTypeScript(), file = 'source.tsx') {
  const ignored = new Map();
  if (!/tmt:ignore/i.test(text)) return ignored;

  const starts = computeLineStarts(text);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const seenRanges = new Set();

  const handleRange = range => {
    const key = `${range.pos}:${range.end}`;
    if (seenRanges.has(key)) return;
    seenRanges.add(key);
    const raw = range.kind === ts.SyntaxKind.SingleLineCommentTrivia
      ? text.slice(range.pos + 2, range.end)
      : text.slice(range.pos + 2, range.end - 2);
    const match = TMT_IGNORE_RE.exec(raw.trim());
    if (!match) return;
    const reason = (match[1] ?? '').trim() || 'Ignored using tmt:ignore';
    const startLine = lineOfOffset(starts, range.pos);
    const endLine = lineOfOffset(starts, Math.max(range.pos, range.end - 1));
    const linePrefix = text.slice(starts[startLine], range.pos);
    const nextLineStart = endLine + 1 < starts.length ? starts[endLine + 1] : text.length;
    const lineSuffix = text.slice(range.end, nextLineStart).replace(/\r?\n$/, '');
    const standalone = linePrefix.trim().length === 0 && lineSuffix.trim().length === 0;
    const targetLine = standalone ? endLine + 1 : endLine;
    ignored.set(targetLine, reason);
  };

  const inspectPosition = pos => {
    for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) handleRange(range);
    for (const range of ts.getTrailingCommentRanges(text, pos) ?? []) handleRange(range);
  };

  (function walk(node) {
    inspectPosition(node.pos);
    inspectPosition(node.end);
    ts.forEachChild(node, walk);
  })(sf);

  return ignored;
}

function normalizePosixPath(file) {
  return String(file ?? '').replaceAll('\\', '/');
}

function normalizeCodeSnippet(diagnostic) {
  const raw = diagnostic.expression ??
    diagnostic.mutations?.[0]?.original ??
    (diagnostic.mutations?.length
      ? diagnostic.mutations.map(m => `${m.rule ?? ''}:${m.replacement ?? ''}`).join('|')
      : diagnostic.rule ?? '');
  return String(raw).replace(/\s+/g, ' ').trim();
}

// Stable finding key without line numbers so findings survive edits and line moves.
export function findingKeyBase(diagnostic) {
  const kind = String(diagnostic.kind ?? 'GAP');
  const file = normalizePosixPath(diagnostic.location?.file);
  const rule = String(diagnostic.rule ?? diagnostic.mutations?.[0]?.rule ?? '');
  const code = normalizeCodeSnippet(diagnostic);
  return JSON.stringify([kind, file, rule, code]);
}

export function findingId(diagnostic, occurrence = 0) {
  const payload = JSON.stringify([findingKeyBase(diagnostic), occurrence]);
  return `tmt-${createHash('sha256').update(payload).digest('hex').slice(0, 16)}`;
}

// Assign deterministic stable IDs to diagnostics, preserving any pre-assigned findingId
// (so SARIF/JSONL output after baseline filtering never re-numbers remaining findings).
export function annotateFindingIds(diagnostics) {
  const counts = new Map();
  return (diagnostics ?? []).map(diagnostic => {
    if (typeof diagnostic?.findingId === 'string' && diagnostic.findingId.length > 0) {
      return diagnostic;
    }
    const base = findingKeyBase(diagnostic);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    const id = findingId(diagnostic, occurrence);
    return { ...diagnostic, findingId: id };
  });
}

export function serializeBaseline(diagnostics) {
  const annotated = annotateFindingIds(diagnostics);
  return {
    version: BASELINE_VERSION,
    findings: annotated.map(item => ({
      id: item.findingId,
      kind: item.kind ?? 'GAP',
      file: normalizePosixPath(item.location?.file),
      rule: item.rule ?? item.mutations?.[0]?.rule ?? undefined,
      code: normalizeCodeSnippet(item),
    })),
  };
}

export function parseBaseline(text, label = 'baseline') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid baseline JSON in ${label}: ${error.message}`);
  }
  if (Array.isArray(data)) {
    if (!data.every(entry => typeof entry === 'string')) {
      throw new Error(`Invalid legacy baseline array in ${label}`);
    }
    return new Set(data);
  }
  if (!data || typeof data !== 'object' || data.version !== BASELINE_VERSION || !Array.isArray(data.findings)) {
    throw new Error(`Unsupported baseline format in ${label}: expected version ${BASELINE_VERSION}`);
  }
  const ids = new Set();
  for (const entry of data.findings) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !id.length) {
      throw new Error(`Invalid baseline entry in ${label}`);
    }
    ids.add(id);
  }
  return ids;
}

export function loadBaseline(path) {
  return parseBaseline(readFileSync(path, 'utf8'), path);
}

export function writeBaseline(path, diagnostics) {
  const payload = serializeBaseline(diagnostics);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function applyBaseline(report, baselineIds) {
  const annotated = annotateFindingIds(report.diagnostics ?? []);
  if (!baselineIds || !baselineIds.size) {
    return { ...report, diagnostics: annotated };
  }
  const kept = [];
  const suppressedIds = [];
  for (const diagnostic of annotated) {
    if (baselineIds.has(diagnostic.findingId)) suppressedIds.push(diagnostic.findingId);
    else kept.push(diagnostic);
  }
  return {
    ...report,
    diagnostics: kept,
    suppressed: {
      baseline: suppressedIds.length,
      ids: suppressedIds,
    },
  };
}
