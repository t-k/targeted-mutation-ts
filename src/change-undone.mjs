import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { sep } from 'node:path';
import { sourceTrials, sourceTrialsAsync, verdict } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { failedTests } from './vitest-reporter.mjs';
import { selectScope } from './scope.mjs';
import { byteOffsets } from './source-text.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';
import { canonicalPath, inside } from './vitest.mjs';

// With `--since REV`, the code as it was is an edit too: each change is put back alone and the suite runs
// against it. When every test passes, no test tells the change from what was there before.
export const undoneRule = 'change-undone/v1';

const sha = source => createHash('sha256').update(source).digest('hex');

function git(root, args) {
  return execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function lineStarts(bytes) {
  const starts = [0];
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) starts.push(at + 1);
  // A last line without a line end still ends the file.
  if (starts.at(-1) !== bytes.length) starts.push(bytes.length);
  return starts;
}

// The changes between two versions of one file, from the headers of a patch without context. Each gives the bytes
// of the current file to replace and the bytes they replaced.
export function undoEdits(patch, old, current) {
  const oldStarts = lineStarts(old);
  const newStarts = lineStarts(current);
  const at = (starts, line, length) => starts[Math.min(line - 1, starts.length - 1)] ?? length;
  const edits = [];
  for (const [, oldStart, oldCount = '1', newStart, newCount = '1'] of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [a, b, c, d] = [oldStart, oldCount, newStart, newCount].map(Number);
    // A hunk that only removes lines names the line before them on the other side.
    const from = d ? at(newStarts, c, current.length) : at(newStarts, c + 1, current.length);
    const to = d ? at(newStarts, c + d, current.length) : from;
    const oldFrom = b ? at(oldStarts, a, old.length) : at(oldStarts, a, old.length);
    const oldTo = b ? at(oldStarts, a + b, old.length) : oldFrom;
    const before = b ? old.subarray(oldFrom, oldTo) : Buffer.alloc(0);
    // Lines put back after a last line that has no line end must not join it.
    const joins = !d && from === current.length && current.length && current.at(-1) !== 10;
    edits.push({ edit: [from, to], oldSpan: [oldFrom, oldTo], replacement: joins ? Buffer.concat([Buffer.from('\n'), before]) : before,
      line: d ? c : Math.min(c + 1, Math.max(1, newStarts.length - 1)), lines: [c, d ? c + d - 1 : c + 1] });
  }
  return edits;
}

const apply = (current, { edit, replacement }) => Buffer.concat([current.subarray(0, edit[0]), replacement, current.subarray(edit[1])]);

// The code of a source text: its syntax tree with every token as the parser read it, without comments and
// spacing. A line end that ends a statement changes the tree, a space in a regular expression or a template
// changes a token, and text between tags counts as JSX reads it, without the indentation of its lines.
function code(ts, file, text) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const parts = [];
  (function walk(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(tree);
    if (node.kind === ts.SyntaxKind.JsxText) {
      const lines = node.text.split(/\r\n|[\n\r]/);
      // Only spaces and tabs are indentation to every JSX transform; a no-break space is text.
      const read = lines.map((line, index) => (index ? line.replace(/^[ \t]+/, '') : line)).map((line, index) =>
        (index < lines.length - 1 ? line.replace(/[ \t]+$/, '') : line)).filter((line, index) => line || lines.length === 1 && !index).join(' ');
      // Only spacing with a line end in it: JSX leaves such text out, so tags on lines of their own are no change.
      if (read || lines.length === 1) parts.push(node.kind, JSON.stringify(read));
      return;
    }
    parts.push(node.kind);
    if (!children.length) parts.push(JSON.stringify(text.slice(node.getStart(tree), node.end)));
    else {
      parts.push('(');
      for (const child of children) walk(child);
      parts.push(')');
    }
  })(tree);
  return parts.join(' ');
}

const parses = (ts, file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false).parseDiagnostics.length === 0;

function nodeSignature(ts, tree, text, node) {
  const parts = [];
  (function walk(inner) {
    if (inner.kind >= ts.SyntaxKind.FirstJSDocNode && inner.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = inner.getChildren(tree);
    parts.push(inner.kind);
    if (!children.length) parts.push(JSON.stringify(text.slice(inner.getStart(tree), inner.end)));
    else {
      parts.push('(');
      for (const child of children) walk(child);
      parts.push(')');
    }
  })(node);
  return parts.join(' ');
}

function isObjectAssignmentTarget(ts, node) {
  let child = node;
  let parent = child.parent;
  while (parent && ts.isParenthesizedExpression(parent)) (child = parent, parent = parent.parent);
  if (!parent) return false;
  if (ts.isBinaryExpression(parent) && parent.left === child &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child) return true;
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) return isObjectAssignmentTarget(ts, parent);
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) {
    return isObjectAssignmentTarget(ts, parent.parent);
  }
  return false;
}

function flattenLogical(ts, node, kind, out = []) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === kind) {
    flattenLogical(ts, node.left, kind, out);
    flattenLogical(ts, node.right, kind, out);
  } else {
    out.push(node);
  }
  return out;
}

function enclosingKey(ts, node) {
  const parts = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) {
      parts.push(cur.name.text);
    } else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      parts.push(cur.name.text);
    } else if (ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) {
      parts.push(cur.name.text);
    }
  }
  return parts.join('.');
}

function oldStructuresInSpan(ts, oldTree, oldText, oldBytes, span) {
  const logicalExpressions = new Map();
  const objectLiterals = new Map();
  if (!oldTree || !span || span[0] === span[1]) return { logicalExpressions, objectLiterals };
  const [from, to] = span;
  const overlaps = node => oldBytes[node.getStart(oldTree)] < to && oldBytes[node.end] > from;
  const pushTo = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, list = []);
    list.push(value);
  };
  (function visit(node) {
    if (!overlaps(node)) return;
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const opKind = node.operatorToken.kind;
      if (!ts.isBinaryExpression(node.parent) || node.parent.operatorToken.kind !== opKind) {
        pushTo(logicalExpressions, enclosingKey(ts, node), { opKind, terms: flattenLogical(ts, node, opKind).map(t => nodeSignature(ts, oldTree, oldText, t)) });
      }
    } else if (ts.isObjectLiteralExpression(node) && !isObjectAssignmentTarget(ts, node)) {
      const keys = new Set();
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
          const name = prop.name;
          if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) keys.add(name.text);
        }
      }
      pushTo(objectLiterals, enclosingKey(ts, node), keys);
    } else {
      const parent = node.parent;
      const isValueExpr = parent && (
        (ts.isArrowFunction(parent) && parent.body === node) ||
        (ts.isReturnStatement(parent) && parent.expression === node) ||
        ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === node) ||
        (ts.isConditionalExpression(parent) && parent.condition === node) ||
        (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === node)
      );
      if (isValueExpr && ts.isExpression(node) && !ts.isFunctionLike(node) && !ts.isObjectLiteralExpression(node)) {
        pushTo(logicalExpressions, enclosingKey(ts, node), { opKind: null, terms: [nodeSignature(ts, oldTree, oldText, node)] });
      }
    }
    ts.forEachChild(node, visit);
  })(oldTree);
  return { logicalExpressions, objectLiterals };
}

function multisetAddedIndices(oldTerms, newTermSigs) {
  const remaining = new Map();
  for (const sig of oldTerms) remaining.set(sig, (remaining.get(sig) ?? 0) + 1);
  const added = [];
  for (let i = 0; i < newTermSigs.length; i++) {
    const count = remaining.get(newTermSigs[i]) ?? 0;
    if (count > 0) remaining.set(newTermSigs[i], count - 1);
    else added.push(i);
  }
  for (const count of remaining.values()) if (count > 0) return null;
  return added;
}

function commaTokensOfObject(ts, tree, objNode) {
  const syntaxList = objNode.getChildren(tree).find(child => child.kind === ts.SyntaxKind.SyntaxList);
  if (!syntaxList) return [];
  return syntaxList.getChildren(tree).filter(child => child.kind === ts.SyntaxKind.CommaToken);
}

function needsSeparatorSpace(beforeChar, afterChar) {
  if (!beforeChar || !afterChar) return false;
  if (/[\p{ID_Continue}$]/u.test(beforeChar) && /[\p{ID_Continue}$\\]/u.test(afterChar)) return true;
  if ((beforeChar === '+' && afterChar === '+') || (beforeChar === '-' && afterChar === '-')) return true;
  if (beforeChar === '/' && (afterChar === '/' || afterChar === '*')) return true;
  return false;
}

function subhunkEdits(ts, file, current, text, tree, curBytes, oldTree, oldText, oldBytes, change, now, wholeCode, selected, seenCodes) {
  const [from, to] = change.edit;
  if (from === to) return [];
  const hasOld = Boolean(change.oldSpan && change.oldSpan[0] !== change.oldSpan[1]);
  const { logicalExpressions: oldLogicals, objectLiterals: oldObjects } = oldStructuresInSpan(ts, oldTree, oldText, oldBytes, change.oldSpan);
  const overlaps = node => curBytes[node.getStart(tree)] < to && curBytes[node.end] > from;
  const results = [];
  const tryEmit = (delStartChar, delEndChar, kind, anchorNode) => {
    const startLine = tree.getLineAndCharacterOfPosition(anchorNode.getStart(tree)).line + 1;
    const endLine = tree.getLineAndCharacterOfPosition(anchorNode.end).line + 1;
    let inScope = false;
    for (let line = startLine; line <= endLine && !inScope; line++) inScope = selected(line);
    if (!inScope) return;
    const edit = [curBytes[delStartChar], curBytes[delEndChar]];
    const sepSpace = needsSeparatorSpace(text[delStartChar - 1], text[delEndChar]);
    const replacement = sepSpace ? Buffer.from(' ') : Buffer.alloc(0);
    const undone = apply(current, { edit, replacement }).toString();
    if (!parses(ts, file, undone)) return;
    const undoneCode = code(ts, file, undone);
    if (undoneCode === now || undoneCode === wholeCode || seenCodes.has(undoneCode)) return;
    seenCodes.add(undoneCode);
    results.push({ edit, replacement, line: startLine, lines: [startLine, endLine], parses: true, subhunk: kind });
  };
  (function visit(node) {
    if (!overlaps(node)) return;
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const opKind = node.operatorToken.kind;
      if (!ts.isBinaryExpression(node.parent) || node.parent.operatorToken.kind !== opKind) {
        const terms = flattenLogical(ts, node, opKind);
        if (terms.length >= 2) {
          const termSigs = terms.map(t => nodeSignature(ts, tree, text, t));
          const scopedOld = oldLogicals.get(enclosingKey(ts, node)) ?? [];
          let addedIndices = null;
          if (!hasOld) {
            addedIndices = terms.map((_, idx) => idx);
          } else if (scopedOld.length === 1) {
            const oldExpr = scopedOld[0];
            if (oldExpr.opKind === null || oldExpr.opKind === opKind) {
              const diff = multisetAddedIndices(oldExpr.terms, termSigs);
              if (diff && diff.length > 0) addedIndices = diff;
            }
          }
          if (addedIndices) {
            for (const i of addedIndices) {
              const term = terms[i];
              if (!overlaps(term)) continue;
              const delStart = i === 0 ? term.getStart(tree) : terms[i - 1].end;
              const delEnd = i === 0 ? terms[1].getStart(tree) : term.end;
              tryEmit(delStart, delEnd, 'logical-term', term);
            }
          }
        }
      }
    } else if (ts.isObjectLiteralExpression(node) && !isObjectAssignmentTarget(ts, node)) {
      const scopedOldObjs = oldObjects.get(enclosingKey(ts, node)) ?? [];
      // Only decompose added properties when we can match against at most one old object literal in the same scope
      // (avoiding cross-object shadowing) or when the hunk is a pure addition.
      if (!hasOld || scopedOldObjs.length === 1) {
        const oldKeys = hasOld ? scopedOldObjs[0] : new Set();
        const props = node.properties;
        const commas = commaTokensOfObject(ts, tree, node);
        for (let i = 0; i < props.length; i++) {
          const prop = props[i];
          if ((!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) || !overlaps(prop)) continue;
          const name = prop.name;
          if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) continue;
          if (oldKeys.has(name.text)) continue;
          const propStart = prop.getStart(tree);
          const afterLimit = i + 1 < props.length ? props[i + 1].getStart(tree) : node.end - 1;
          const trailingComma = commas.find(c => c.getStart(tree) >= prop.end && c.end <= afterLimit);
          if (trailingComma) {
            tryEmit(propStart, trailingComma.end, 'object-property', prop);
          } else if (i > 0) {
            const prevEnd = props[i - 1].end;
            const prevComma = commas.find(c => c.getStart(tree) >= prevEnd && c.end <= propStart);
            if (prevComma) tryEmit(prevComma.getStart(tree), prop.end, 'object-property', prop);
          } else {
            tryEmit(propStart, prop.end, 'object-property', prop);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  })(tree);
  return results;
}

// The trials for one file: every change in scope that changes code, put back alone, plus AST sub-hunks for
// added `&&`/`||` terms and added object properties, and all hunks together where one does not parse alone.
export function planUndo(file, old, current, patch, selected = () => true, ts = loadTypeScript()) {
  const text = current.toString();
  const now = code(ts, file, text);
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sound = tree.parseDiagnostics.length === 0;
  const oldText = old.toString();
  const oldTree = sound ? ts.createSourceFile(file, oldText, ts.ScriptTarget.Latest, true) : null;
  const oldSound = oldTree && oldTree.parseDiagnostics.length === 0;
  const curBytes = sound ? byteOffsets(text) : null;
  const oldBytes = oldSound ? byteOffsets(oldText) : null;
  const trials = [];
  const seenCodes = new Set();
  for (const change of undoEdits(patch, old, current)) {
    let inScope = false;
    for (let line = change.lines[0]; line <= change.lines[1] && !inScope; line++) inScope = selected(line);
    if (!inScope) continue;
    const undone = apply(current, change).toString();
    const wholeCode = code(ts, file, undone);
    if (wholeCode === now) continue;
    seenCodes.add(wholeCode);
    trials.push({ ...change, parses: !sound || parses(ts, file, undone) });
    if (sound) {
      trials.push(...subhunkEdits(ts, file, current, text, tree, curBytes, oldSound ? oldTree : null, oldText, oldBytes, change, now, wholeCode, selected, seenCodes));
    }
  }
  const wholeHunks = trials.filter(trial => !trial.subhunk);
  if (wholeHunks.length > 1 && wholeHunks.some(trial => !trial.parses)) {
    const all = [...wholeHunks].sort((a, b) => b.edit[0] - a.edit[0]).reduce(apply, current);
    trials.push({ edit: [0, current.length], replacement: all, line: wholeHunks[0].line, together: true, parses: !sound || parses(ts, file, all.toString()) });
  }
  return trials;
}

function locate(current, offset) {
  const before = current.subarray(0, offset);
  let line = 1;
  let start = 0;
  for (let at = before.indexOf(10); at !== -1; at = before.indexOf(10, at + 1)) (line++, start = at + 1);
  return { line, column: before.subarray(start).toString().length + 1 };
}

function prepareUndoPlan(project, files, options) {
  const root = canonicalPath(project);
  if (options.since === undefined) throw new Error('--undo-changes requires --since REV');
  let revision;
  try {
    revision = git(root, ['rev-parse', '--verify', '--end-of-options', options.since + '^{commit}']).toString().trim();
  } catch {
    throw new Error(`Cannot resolve Git revision: ${options.since}`);
  }
  const fromGit = path => sep === '/' ? path : path.replaceAll('/', sep);
  const changed = new Set(git(root, ['diff', '--name-only', '-z', '--relative', '--no-ext-diff', '--no-renames', revision, '--']).toString().split('\0').map(fromGit));
  const subjects = [];
  const trials = [];
  const fileHunks = new Map();
  for (const { file, selected } of selectScope(root, files, { lines: options.lines, 'copy-exclude': options['copy-exclude'] })) {
    if (!changed.has(file)) continue;
    const pathspec = sep === '/' ? file : file.replaceAll(sep, '/');
    let old;
    try {
      // As a checkout of the revision would write it: with the line ends the attributes of the path ask for.
      old = git(root, ['cat-file', '--filters', `${revision}:./${pathspec}`]);
    } catch {
      // The file is new since the revision: there is nothing to put back.
      continue;
    }
    const input = readFileSync(inside(root, file));
    const patch = git(root, ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', revision, '--', pathspec]).toString('latin1');
    const planned = planUndo(file, old, input, patch, selected);
    if (!planned.length) continue;
    subjects.push({ file, input, digest: sha(input), sites: [] });
    const singleHunks = planned.filter(trial => !trial.together && !trial.subhunk);
    fileHunks.set(file, { input, hunks: singleHunks, hasTogether: planned.some(trial => trial.together) });
    for (const trial of planned) {
      const location = { file, ...locate(input, trial.edit[0]), start: trial.edit[0], end: trial.edit[1] };
      trials.push({ ...trial, site: { id: sha(JSON.stringify([file, undoneRule, trial.edit, sha(trial.replacement)])).slice(0, 16), location },
        replacement: trial.replacement.toString(), original: input.subarray(...trial.edit).toString() });
    }
  }
  return { root, revision, subjects, trials, fileHunks };
}

function classifyUndoOutcome(trial, result, baseline, options, revision) {
  const mutant = { site: trial.site.id, location: trial.site.location, rule: undoneRule, original: trial.original, edit: trial.edit,
    replacement: trial.replacement, since: revision, ...(trial.together ? { together: true } : {}),
    ...(trial.subhunk ? { subhunk: trial.subhunk } : {}) };
  if (!trial.parses) {
    return { mutant: { ...mutant, status: 'unsupported', statusReason: 'Put back alone, this change does not parse' }, unloadable: false, diagnostic: null, incomplete: false };
  }
  // Only genuine module load failures (not post-load unhandled rejections or suite hook errors) count as `load_error`.
  // Rather than falsely reporting an unloadable single hunk as killed by tests, report `load_error` and fall back to
  // reverting all in-scope hunks of the file together when multiple hunks exist.
  const loadErrors = Array.isArray(result.moduleErrors)
    ? result.moduleErrors
    : (result.errors?.length > 0 && Array.isArray(result.tests) && result.tests.length < baseline.tests.length ? result.errors : []);
  const unloadable = options.runner !== 'playwright' && result.status === 'error' && loadErrors.length > 0 && Array.isArray(result.tests);
  const status = unloadable ? 'load_error' : verdict(result, baseline);
  const entry = { ...mutant, status, evidence: 'reexecuted',
    ...(unloadable ? { statusReason: 'The suite did not load: ' + String(loadErrors[0]).split('\n')[0] } : {}),
    ...(status === 'killed' ? { tests: result.tests.filter(test => test.status === 'failed').map(({ id, project, file, name }) => ({ id, project, file, name })) } : {}) };
  const diagnostic = status === 'survived'
    ? { kind: 'UNTESTED CHANGE', site: trial.site.id, location: trial.site.location, rule: undoneRule, since: revision,
      ...(trial.together ? { together: true } : {}), ...(trial.subhunk ? { subhunk: trial.subhunk } : {}),
      mutations: [{ rule: undoneRule, edit: trial.edit, replacement: trial.replacement, evidence: 'reexecuted' }] }
    : null;
  return { mutant: entry, unloadable, diagnostic, incomplete: status === 'error' };
}

function buildTogetherTrials(needsTogether, fileHunks) {
  if (!needsTogether.size) return [];
  const ts = loadTypeScript();
  const extra = [];
  for (const file of needsTogether) {
    const info = fileHunks.get(file);
    if (!info || info.hasTogether || info.hunks.length < 2) continue;
    const all = [...info.hunks].sort((a, b) => b.edit[0] - a.edit[0]).reduce(apply, info.input);
    const edit = [0, info.input.length];
    const location = { file, ...locate(info.input, info.hunks[0].edit[0]), start: edit[0], end: edit[1] };
    extra.push({
      edit, replacement: all.toString(), original: info.input.toString(), together: true,
      parses: !parses(ts, file, info.input.toString()) || parses(ts, file, all.toString()),
      site: { id: sha(JSON.stringify([file, undoneRule, edit, sha(all)])).slice(0, 16), location },
    });
  }
  return extra;
}

export function analyzeUndoneChanges(project, files, options, run = { sourceTrials }) {
  const { root, revision, subjects, trials, fileHunks } = prepareUndoPlan(project, files, options);
  const report = { mutants: [], diagnostics: [], evaluation: 'no_sites', since: revision };
  if (!trials.length) return report;
  const attempt = run.sourceTrials(root, subjects, options);
  const baseline = options.existingBaseline?.plain === true && options.existingBaseline.status === 'passed' && Array.isArray(options.existingBaseline.tests)
    ? options.existingBaseline : attempt();
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error', baseline: {
      status: baseline.status,
      ...(baseline.files?.length ? { files: baseline.files } : {}),
      ...(baseline.fileErrors?.length ? { fileErrors: baseline.fileErrors } : {}),
      output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline),
    } };
  }
  report.evaluation = 'evaluated';
  // A file the suite runs as a test is not the program: its assertions stay as they are in every trial.
  const testFiles = new Set(baseline.tests.map(entry => entry.file));
  const needsTogether = new Set();
  const recordOutcome = (trial, result) => {
    const { mutant, unloadable, diagnostic, incomplete } = classifyUndoOutcome(trial, result, baseline, options, revision);
    if (unloadable && !trial.together) needsTogether.add(trial.site.location.file);
    report.mutants.push(mutant);
    if (incomplete) report.evaluation = 'incomplete';
    if (diagnostic) report.diagnostics.push(diagnostic);
  };
  for (const trial of trials) {
    if (testFiles.has(trial.site.location.file)) continue;
    recordOutcome(trial, trial.parses ? attempt({ trial }) : null);
  }
  for (const trial of buildTogetherTrials(needsTogether, fileHunks)) {
    recordOutcome(trial, trial.parses ? attempt({ trial }) : null);
  }
  return report;
}

const defaultUndoAsyncRun = { sourceTrialsAsync };

export async function analyzeUndoneChangesAsync(project, files, options, run = defaultUndoAsyncRun) {
  // Playwright runs via synchronous `sourceTrials`; never route Playwright undo trials into Vitest's `sourceTrialsAsync`.
  if (options.runner === 'playwright' && run === defaultUndoAsyncRun) {
    return analyzeUndoneChanges(project, files, options, { sourceTrials });
  }
  const { root, revision, subjects, trials, fileHunks } = prepareUndoPlan(project, files, options);
  const report = { mutants: [], diagnostics: [], evaluation: 'no_sites', since: revision };
  if (!trials.length) return report;
  const runnerFactory = run.sourceTrialsAsync ?? run.sourceTrials;
  const attempt = runnerFactory(root, subjects, options);
  const baseline = options.existingBaseline?.plain === true && options.existingBaseline.status === 'passed' && Array.isArray(options.existingBaseline.tests)
    ? options.existingBaseline : await attempt();
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error', baseline: {
      status: baseline.status,
      ...(baseline.files?.length ? { files: baseline.files } : {}),
      ...(baseline.fileErrors?.length ? { fileErrors: baseline.fileErrors } : {}),
      output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline),
    } };
  }
  report.evaluation = 'evaluated';
  const testFiles = new Set(baseline.tests.map(entry => entry.file));
  const active = trials.filter(trial => !testFiles.has(trial.site.location.file));
  const concurrency = options.runner === 'playwright' ? 1 : (options.concurrency ?? Math.max(1, Math.min(8, availableParallelism() - 1)));
  const results = new Array(active.length);
  await inParallel(active.map((trial, index) => ({ trial, index })), concurrency, async ({ trial, index }) => {
    results[index] = trial.parses ? await attempt({ trial }) : null;
  });
  const needsTogether = new Set();
  for (let i = 0; i < active.length; i++) {
    const { mutant, unloadable, diagnostic, incomplete } = classifyUndoOutcome(active[i], results[i], baseline, options, revision);
    if (unloadable && !active[i].together) needsTogether.add(active[i].site.location.file);
    report.mutants.push(mutant);
    if (incomplete) report.evaluation = 'incomplete';
    if (diagnostic) report.diagnostics.push(diagnostic);
  }
  const togetherTrials = buildTogetherTrials(needsTogether, fileHunks);
  const togetherResults = new Array(togetherTrials.length);
  await inParallel(togetherTrials.map((trial, index) => ({ trial, index })), concurrency, async ({ trial, index }) => {
    togetherResults[index] = trial.parses ? await attempt({ trial }) : null;
  });
  for (let i = 0; i < togetherTrials.length; i++) {
    const { mutant, diagnostic, incomplete } = classifyUndoOutcome(togetherTrials[i], togetherResults[i], baseline, options, revision);
    report.mutants.push(mutant);
    if (incomplete) report.evaluation = 'incomplete';
    if (diagnostic) report.diagnostics.push(diagnostic);
  }
  return report;
}

// Adds the undone changes to the report of the profile that ran beside them.
export function withUndoneChanges(report, undone) {
  if (report.evaluation === 'baseline_error') return report;
  if (undone.evaluation === 'baseline_error') return { ...report, evaluation: 'baseline_error', baseline: undone.baseline };
  if (undone.evaluation === 'no_sites') return { ...report, changesSince: undone.since };
  return {
    ...report, changesSince: undone.since,
    evaluation: report.evaluation === 'incomplete' || undone.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: [...report.mutants, ...undone.mutants], diagnostics: [...report.diagnostics, ...undone.diagnostics],
  };
}
