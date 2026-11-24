import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { sep } from 'node:path';
import { sourceTrials, sourceTrialsAsync, verdict } from './analysis.mjs';
import { inParallel } from './in-parallel.mjs';
import { failedTests } from './vitest-reporter.mjs';
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

// The trials for one file: every change in scope that changes code, put back alone, and those together where
// one of them does not parse alone.
export function planUndo(file, old, current, patch, selected = () => true, ts = loadTypeScript()) {
  const text = current.toString();
  const now = code(ts, file, text);
  const sound = parses(ts, file, text);
  const trials = [];
  for (const change of undoEdits(patch, old, current)) {
    let inScope = false;
    for (let line = change.lines[0]; line <= change.lines[1] && !inScope; line++) inScope = selected(line);
    if (!inScope) continue;
    const undone = apply(current, change).toString();
    if (code(ts, file, undone) === now) continue;
    trials.push({ ...change, parses: !sound || parses(ts, file, undone) });
  }
  if (trials.length > 1 && trials.some(trial => !trial.parses)) {
    const all = [...trials].sort((a, b) => b.edit[0] - a.edit[0]).reduce(apply, current);
    trials.push({ edit: [0, current.length], replacement: all, line: trials[0].line, together: true, parses: !sound || parses(ts, file, all.toString()) });
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
    const singleHunks = planned.filter(trial => !trial.together);
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
    replacement: trial.replacement, since: revision, ...(trial.together ? { together: true } : {}) };
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
      ...(trial.together ? { together: true } : {}), mutations: [{ rule: undoneRule, edit: trial.edit, replacement: trial.replacement, evidence: 'reexecuted' }] }
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
    return { ...report, evaluation: 'baseline_error',
      baseline: { status: baseline.status, output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline) } };
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
    return { ...report, evaluation: 'baseline_error',
      baseline: { status: baseline.status, output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline) } };
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
