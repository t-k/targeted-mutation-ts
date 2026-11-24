import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { sourceTrials, verdict } from './analysis.mjs';
import { selectScope } from './scope.mjs';
import { loadTypeScript } from './typescript-compiler.mjs';
import { inside } from './vitest.mjs';

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
    const before = b ? old.subarray(at(oldStarts, a, old.length), at(oldStarts, a + b, old.length)) : Buffer.alloc(0);
    // Lines put back after a last line that has no line end must not join it.
    const joins = !d && from === current.length && current.length && current.at(-1) !== 10;
    edits.push({ edit: [from, to], replacement: joins ? Buffer.concat([Buffer.from('\n'), before]) : before,
      line: d ? c : Math.min(c + 1, Math.max(1, newStarts.length - 1)), lines: [c, d ? c + d - 1 : c + 1] });
  }
  return edits;
}

const apply = (current, { edit, replacement }) => Buffer.concat([current.subarray(0, edit[0]), replacement, current.subarray(edit[1])]);

// The tokens of a source text without comments and spacing: a change that leaves them alone changes no code.
function tokens(ts, file, text) {
  const variant = /\.[jt]sx$/.test(file) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, text);
  const seen = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) seen.push(scanner.getTokenText());
  return seen.join('\u0000');
}

const parses = (ts, file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false).parseDiagnostics.length === 0;

// The trials for one file: every change that changes code, put back alone, and all of them together where one
// of them does not parse alone.
export function planUndo(file, old, current, patch, selected = () => true, ts = loadTypeScript()) {
  const text = current.toString();
  const now = tokens(ts, file, text);
  const sound = parses(ts, file, text);
  const trials = [];
  for (const change of undoEdits(patch, old, current)) {
    let inScope = false;
    for (let line = change.lines[0]; line <= change.lines[1] && !inScope; line++) inScope = selected(line);
    if (!inScope) continue;
    const undone = apply(current, change).toString();
    if (tokens(ts, file, undone) === now) continue;
    trials.push({ ...change, parses: !sound || parses(ts, file, undone) });
  }
  if (trials.length > 1 && trials.some(trial => !trial.parses) && tokens(ts, file, old.toString()) !== now) {
    trials.push({ edit: [0, current.length], replacement: old, line: trials[0].line, whole: true, parses: !sound || parses(ts, file, old.toString()) });
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

export function analyzeUndoneChanges(project, files, options, run = { sourceTrials }) {
  const root = realpathSync(project);
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
  for (const { file, selected } of selectScope(root, files, { lines: options.lines, 'copy-exclude': options['copy-exclude'] })) {
    if (!changed.has(file)) continue;
    const pathspec = sep === '/' ? file : file.replaceAll(sep, '/');
    let old;
    try {
      old = git(root, ['show', `${revision}:./${pathspec}`]);
    } catch {
      // The file is new since the revision: there is nothing to put back.
      continue;
    }
    const input = readFileSync(inside(root, file));
    const patch = git(root, ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=0', revision, '--', pathspec]).toString('latin1');
    const planned = planUndo(file, old, input, patch, selected);
    if (!planned.length) continue;
    subjects.push({ file, input, digest: sha(input), sites: [] });
    for (const trial of planned) {
      const location = { file, ...locate(input, trial.edit[0]), start: trial.edit[0], end: trial.edit[1] };
      trials.push({ ...trial, site: { id: sha(JSON.stringify([file, undoneRule, trial.edit, sha(trial.replacement)])).slice(0, 16), location },
        replacement: trial.replacement.toString(), original: input.subarray(...trial.edit).toString() });
    }
  }
  const report = { mutants: [], diagnostics: [], evaluation: 'no_sites', since: revision };
  if (!trials.length) return report;
  const attempt = run.sourceTrials(root, subjects, options);
  const baseline = attempt();
  if (baseline.status !== 'passed') return { ...report, evaluation: 'baseline_error', baseline };
  report.evaluation = 'evaluated';
  for (const trial of trials) {
    const mutant = { site: trial.site.id, location: trial.site.location, rule: undoneRule, original: trial.original, edit: trial.edit,
      replacement: trial.replacement, since: revision, ...(trial.whole ? { wholeFile: true } : {}) };
    if (!trial.parses) {
      report.mutants.push({ ...mutant, status: 'unsupported', statusReason: 'Put back alone, this change does not parse' });
      continue;
    }
    const result = attempt({ trial });
    const status = verdict(result, baseline);
    report.mutants.push({ ...mutant, status, evidence: 'reexecuted',
      ...(status === 'killed' ? { tests: result.tests.filter(test => test.status === 'failed').map(({ id, project, file, name }) => ({ id, project, file, name })) } : {}) });
    if (status === 'error') report.evaluation = 'incomplete';
    if (status === 'survived') {
      report.diagnostics.push({ kind: 'UNTESTED CHANGE', site: trial.site.id, location: trial.site.location, rule: undoneRule, since: revision,
        ...(trial.whole ? { wholeFile: true } : {}), mutations: [{ rule: undoneRule, edit: trial.edit, replacement: trial.replacement, evidence: 'reexecuted' }] });
    }
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
