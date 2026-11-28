import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadTypeScript } from './typescript-compiler.mjs';

const BASELINE_VERSION = 2;
const TMT_IGNORE_RE = /^\s*tmt:ignore(?:\[([^\]]+)\])?(?:\s+(.*))?$/i;

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

// Parse `// tmt:ignore [reason]`, `// tmt:ignore[rule1, rule2] [reason]`, and block-comment forms
// using the TypeScript AST so occurrences inside strings, template literals, or after regex literals are handled accurately.
export function tmtIgnoreDirectives(text, ts = loadTypeScript(), file = 'source.tsx') {
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
    const rawRules = match[1];
    const rules = rawRules
      ? rawRules.split(',').map(r => r.trim().toLowerCase()).filter(Boolean)
      : null;
    if (rawRules && !rules.length) return;
    const reason = (match[2] ?? '').trim() || 'Ignored using tmt:ignore';
    const startLine = lineOfOffset(starts, range.pos);
    const endLine = lineOfOffset(starts, Math.max(range.pos, range.end - 1));
    const linePrefix = text.slice(starts[startLine], range.pos);
    const nextLineStart = endLine + 1 < starts.length ? starts[endLine + 1] : text.length;
    const lineSuffix = text.slice(range.end, nextLineStart).replace(/\r?\n$/, '');
    const standalone = linePrefix.trim().length === 0 && lineSuffix.trim().length === 0;
    const targetLine = standalone ? endLine + 1 : endLine;
    const list = ignored.get(targetLine) ?? [];
    list.push({ rules, reason });
    ignored.set(targetLine, list);
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

export function matchTmtIgnore(directives, line, ruleName) {
  const list = directives?.get?.(line);
  if (!list?.length) return undefined;
  const full = String(ruleName ?? '').toLowerCase();
  const base = full.replace(/\/v\d+$/, '');
  for (const entry of list) {
    if (entry.rules === null) return entry.reason;
    if (entry.rules.includes('all') || entry.rules.includes(full) || (base && entry.rules.includes(base))) {
      return entry.reason;
    }
  }
  return undefined;
}

export function tmtIgnoreLines(text, ts = loadTypeScript(), file = 'source.tsx') {
  const directives = tmtIgnoreDirectives(text, ts, file);
  const lines = new Map();
  for (const [line, list] of directives) {
    lines.set(line, list[list.length - 1].reason);
  }
  return lines;
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

export function serializeBaseline(diagnostics, existingReasons = new Map()) {
  const annotated = annotateFindingIds(diagnostics);
  return {
    version: BASELINE_VERSION,
    findings: annotated.map(item => ({
      id: item.findingId,
      kind: item.kind ?? 'GAP',
      file: normalizePosixPath(item.location?.file),
      rule: item.rule ?? item.mutations?.[0]?.rule ?? undefined,
      code: normalizeCodeSnippet(item),
      reason: existingReasons.get(item.findingId) ?? '',
    })),
  };
}

export function parseBaselineWithReasons(text, label = 'baseline') {
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
    return { ids: new Set(data), reasons: new Map() };
  }
  if (!data || typeof data !== 'object' || data.version !== BASELINE_VERSION || !Array.isArray(data.findings)) {
    throw new Error(`Unsupported baseline format in ${label}: expected version ${BASELINE_VERSION}`);
  }
  const ids = new Set();
  const reasons = new Map();
  for (const entry of data.findings) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || !id.length) {
      throw new Error(`Invalid baseline entry in ${label}`);
    }
    if (entry && typeof entry === 'object' && entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') {
        throw new Error(`Invalid baseline entry in ${label}: reason must be a string`);
      }
      if (entry.reason.trim().length > 0) {
        reasons.set(id, entry.reason);
      }
    }
    ids.add(id);
  }
  return { ids, reasons };
}

export function parseBaseline(text, label = 'baseline') {
  return parseBaselineWithReasons(text, label).ids;
}

export function loadBaseline(path) {
  return parseBaseline(readFileSync(path, 'utf8'), path);
}

export function loadBaselineWithReasons(path) {
  return parseBaselineWithReasons(readFileSync(path, 'utf8'), path);
}

export function writeBaseline(path, diagnostics) {
  let existingReasons = new Map();
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw.trim().length > 0) {
      existingReasons = parseBaselineWithReasons(raw, path).reasons;
    }
  }
  const payload = serializeBaseline(diagnostics, existingReasons);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function applyBaseline(report, baseline) {
  const annotated = annotateFindingIds(report.diagnostics ?? []);
  const baselineIds = baseline instanceof Set ? baseline : baseline?.ids;
  const baselineReasons = baseline instanceof Set ? null : baseline?.reasons;
  if (!baselineIds || !baselineIds.size) {
    return { ...report, diagnostics: annotated };
  }
  const kept = [];
  const suppressedIds = [];
  const suppressedReasons = {};
  for (const diagnostic of annotated) {
    if (baselineIds.has(diagnostic.findingId)) {
      suppressedIds.push(diagnostic.findingId);
      const reason = baselineReasons?.get?.(diagnostic.findingId);
      if (typeof reason === 'string' && reason.trim().length > 0) {
        suppressedReasons[diagnostic.findingId] = reason;
      }
    } else {
      kept.push(diagnostic);
    }
  }
  return {
    ...report,
    diagnostics: kept,
    suppressed: {
      baseline: suppressedIds.length,
      ids: suppressedIds,
      ...(Object.keys(suppressedReasons).length ? { reasons: suppressedReasons } : {}),
    },
  };
}
