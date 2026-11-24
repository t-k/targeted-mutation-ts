import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderText } from '../src/cli-output.mjs';
import { analyzeUndoneChanges, planUndo, undoEdits, withUndoneChanges } from '../src/change-undone.mjs';

function repository(action) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-undo-test-')));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    return action(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The patch Git gives for one file between a commit and the working tree.
function patchOf(old, current) {
  return repository((root, git) => {
    writeFileSync(join(root, 'f.js'), old);
    git('add', '.');
    git('commit', '-qm', 'old');
    writeFileSync(join(root, 'f.js'), current);
    return git('diff', '--no-color', '--unified=0', 'HEAD', '--', 'f.js');
  });
}
const applied = (current, edits) => [...edits].sort((a, b) => b.edit[0] - a.edit[0])
  .reduce((text, { edit, replacement }) => Buffer.concat([text.subarray(0, edit[0]), replacement, text.subarray(edit[1])]), current);

const rows = readFileSync(new URL('../verification/pict/change-undone.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1).map(line => line.split('\t'));

test('the change table has every required case', () => {
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of readFileSync(new URL('../verification/pict/change-undone.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)) {
    assert.ok(table.has(seed), seed);
  }
});

const pieces = {
  Tokens: ['let changed = 1', 'let changed = 2', 'call(changed)'],
  CommentOnly: ['// a note', '// another note', '/* more */'],
  SpacingOnly: ['let spaced = 1', 'let  spaced  =  1', ''],
};
for (const [change, code, position, finalLineEnd, otherChange] of rows) {
  test(`undo: ${change} of ${code} at ${position}, final line end ${finalLineEnd}, other change ${otherChange}`, () => {
    const [before, after, added] = pieces[code];
    const fixed = ['const first = 1', 'const second = 2', 'const third = 3', 'const fourth = 4'];
    // The change under test goes at the named place of the old lines; another change sits lines away.
    const at = position === 'FileStart' ? 0 : position === 'Middle' ? 2 : 4;
    const oldLines = [...fixed];
    const newLines = [...fixed];
    if (change === 'Replace') (oldLines.splice(at, 0, before), newLines.splice(at, 0, after));
    else if (change === 'AddLines') newLines.splice(at, 0, added, added);
    else oldLines.splice(at, 0, added, added);
    const far = fixed[position === 'FileStart' ? fixed.length - 1 : 0];
    const replaceFixed = (lines, text) => { lines[lines.indexOf(far)] = text; };
    if (otherChange === 'Code') replaceFixed(newLines, 'const other = 9');
    else if (otherChange === 'Comment') (replaceFixed(oldLines, far + ' // was'), replaceFixed(newLines, far + ' // is'));
    const end = finalLineEnd === 'Present' ? '\n' : '';
    const old = Buffer.from(oldLines.join('\n') + end);
    const current = Buffer.from(newLines.join('\n') + end);
    const patch = patchOf(old, current);
    const edits = undoEdits(patch, old, current);
    // All changes put back give the old file, byte for byte.
    assert.equal(applied(current, edits).toString(), old.toString());
    assert.equal(edits.length, otherChange === 'None' ? 1 : 2);
    // Each change put back alone leaves the other one as it is: putting that one back too gives the old file.
    for (const edit of edits) {
      const moved = edit.replacement.length - (edit.edit[1] - edit.edit[0]);
      const rest = edits.filter(other => other !== edit).map(other => ({ ...other, edit: other.edit.map(offset => offset + (other.edit[0] > edit.edit[0] ? moved : 0)) }));
      assert.equal(applied(applied(current, [edit]), rest).toString(), old.toString());
    }
    // Only a change of code is tried.
    const planned = planUndo('f.js', old, current, patch);
    assert.equal(planned.length, (code === 'Tokens' ? 1 : 0) + (otherChange === 'Code' ? 1 : 0));
    assert.ok(planned.every(trial => trial.parses));
  });
}

test('a change that does not parse alone is not run, and the file is then also tried with all its changes put back', () => {
  // The braces around two unchanged lines were removed: neither brace parses when it comes back alone.
  const old = Buffer.from('export function f(a) {\n  if (a) {\n    note(a);\n    note(1);\n  }\n  return 2;\n}\nexport const g = 1;\n');
  const current = Buffer.from('export function f(a) {\n  if (a)\n    note(a);\n    note(1);\n  return 2;\n}\nexport const g = 2;\n');
  const patch = patchOf(old, current);
  const planned = planUndo('f.js', old, current, patch);
  assert.deepEqual(planned.map(trial => [trial.parses, trial.together === true]), [[false, false], [false, false], [true, false], [true, true]]);
  assert.equal(planned.at(-1).replacement.toString(), old.toString());
  // Together means the changes in scope: with the braces selected, the constant after them stays as it is.
  const braces = planUndo('f.js', old, current, patch, line => line <= 5);
  assert.deepEqual(braces.map(trial => trial.together === true), [false, false, true]);
  assert.equal(braces.at(-1).replacement.toString(), old.toString().replace('g = 1', 'g = 2'));
  // A line scope keeps the changes that touch it; a removal belongs to the lines around it.
  assert.deepEqual(planUndo('f.js', old, current, patch, line => line === 7).map(trial => trial.replacement.toString()), ['export const g = 1;\n']);
  const removed = Buffer.from('const a = 1\nconst c = 3\nconst d = 4\n');
  const withB = Buffer.from('const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n');
  const removal = patchOf(withB, removed);
  assert.equal(planUndo('f.js', withB, removed, removal, line => line === 2).length, 1);
  assert.equal(planUndo('f.js', withB, removed, removal, line => line === 3).length, 0);
});

const subject = `export const fee = (cents: number) => cents > 1000 ? 0 : 50;
export const label = (name: string) => name.trim();
export const total = (a: number, b: number) => a + b;
`;
const tests = `import { expect, it } from 'vitest';
import { fee, label, total } from './subject';
it('fee', () => { expect(fee(2000)).toBe(0); expect(fee(100)).toBe(50); });
it('label', () => { expect(label('a')).toBe('a'); });
it('total', () => { expect(total(1, 2)).toBe(3); });
`;

test('each change since a revision is put back alone, and a change the tests pass without is reported', () => repository((root, git) => {
  writeFileSync(join(root, 'subject.ts'), subject);
  writeFileSync(join(root, 'subject.test.ts'), tests);
  git('add', '.');
  git('commit', '-qm', 'first');
  const changed = subject.replace('cents > 1000 ? 0 : 50', 'cents > 1000 ? 0 : 60').replace('name.trim()', 'name.trim().toLowerCase()')
    .replace('export const total', '// sums\nexport const total');
  writeFileSync(join(root, 'subject.ts'), changed);
  writeFileSync(join(root, 'subject.test.ts'), tests.replace('toBe(50)', 'toBe(60)'));
  writeFileSync(join(root, 'added.ts'), 'export const fresh = (n: number) => n === 1;\n');
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, '--since', 'HEAD', '--undo-changes', '--format', 'json'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), changed);
  const undone = report.mutants.filter(mutant => mutant.rule === 'change-undone/v1');
  // The two changed lines are one change next to each other. The comment and the new file are not tried.
  assert.deepEqual(undone.map(mutant => [mutant.location.line, mutant.status, mutant.replacement]), [
    [1, 'killed', subject.split('\n').slice(0, 2).join('\n') + '\n']]);
  assert.deepEqual(undone[0].tests.map(entry => entry.name), ['fee']);
  assert.equal(report.changesSince.length, 40);
  // The focused analysis of the changed lines is still there.
  assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-boundary/v1'));

  // With the tested change committed, the remaining one is passed by every test.
  writeFileSync(join(root, 'subject.ts'), subject.replace('cents > 1000 ? 0 : 50', 'cents > 1000 ? 0 : 60'));
  git('add', '.');
  git('commit', '-qm', 'second');
  writeFileSync(join(root, 'subject.ts'), changed);
  const second = analyzeUndoneChanges(root, [], { since: 'HEAD' });
  assert.deepEqual(second.mutants.map(mutant => [mutant.location.line, mutant.location.column, mutant.status]), [[2, 1, 'survived']]);
  assert.deepEqual(second.diagnostics.map(entry => [entry.kind, entry.location.file, entry.location.line]), [['UNTESTED CHANGE', 'subject.ts', 2]]);
  const text = renderText({ runner: 'vitest', ...withUndoneChanges({ evaluation: 'no_sites', mutants: [], diagnostics: [] }, second) });
  assert.match(text, /subject\.ts:2:1 {2}survived {2}change-undone\/v1: export const label = .* as it was at [0-9a-f]{12}/);
  assert.match(text, /UNTESTED CHANGE subject\.ts:2:1 {2}change-undone\/v1\n {2}the tests pass with this change put back as it was at [0-9a-f]{12}\n {2}add a test that fails without the change/);
  // A line scope leaves the change out.
  assert.equal(analyzeUndoneChanges(root, [], { since: 'HEAD', lines: ['subject.ts:1-1'] }).evaluation, 'no_sites');
}));

test('without changes of code nothing runs, a failing suite is a baseline error, and the flag needs a revision', () => repository((root, git) => {
  writeFileSync(join(root, 'subject.ts'), subject);
  writeFileSync(join(root, 'subject.test.ts'), tests);
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(root, 'subject.ts'), subject.replace('export const total', '// sums\nexport const total'));
  let runs = 0;
  const counting = { sourceTrials: () => () => { runs++; return { status: 'failed', tests: [{ file: 'subject.test.ts', name: 'total', status: 'failed', failures: ['expected 3'] }] }; } };
  assert.equal(analyzeUndoneChanges(root, [], { since: 'HEAD' }, counting).evaluation, 'no_sites');
  assert.equal(runs, 0);
  writeFileSync(join(root, 'subject.ts'), subject.replace('a + b', 'a - b'));
  const failed = analyzeUndoneChanges(root, [], { since: 'HEAD' }, counting);
  assert.deepEqual([failed.evaluation, runs], ['baseline_error', 1]);
  assert.match(renderText({ runner: 'vitest', ...withUndoneChanges({ evaluation: 'evaluated', mutants: [], diagnostics: [] }, failed) }), /FAILED subject\.test\.ts > total\n {4}expected 3/);
  assert.throws(() => analyzeUndoneChanges(root, [], {}), /requires --since/);
  assert.throws(() => analyzeUndoneChanges(root, [], { since: 'nowhere' }), /Cannot resolve Git revision: nowhere/);
  const flag = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, '--undo-changes'], { encoding: 'utf8' });
  assert.match(flag.stderr, /--undo-changes requires --since REV/);
}));

test('undone changes join the report of the profile beside them', () => {
  const report = { evaluation: 'no_sites', mutants: [], diagnostics: [] };
  const undone = { evaluation: 'evaluated', since: 'abc', mutants: [{ rule: 'change-undone/v1' }], diagnostics: [{ kind: 'UNTESTED CHANGE' }] };
  assert.deepEqual(withUndoneChanges(report, undone), { evaluation: 'evaluated', changesSince: 'abc', mutants: undone.mutants, diagnostics: undone.diagnostics });
  assert.equal(withUndoneChanges({ ...report, evaluation: 'incomplete' }, undone).evaluation, 'incomplete');
  assert.equal(withUndoneChanges({ ...report, evaluation: 'evaluated' }, { ...undone, evaluation: 'incomplete' }).evaluation, 'incomplete');
  assert.deepEqual(withUndoneChanges(report, { evaluation: 'no_sites', since: 'abc', mutants: [], diagnostics: [] }), { ...report, changesSince: 'abc' });
  assert.equal(withUndoneChanges(report, { evaluation: 'baseline_error', baseline: { status: 'failed' } }).baseline.status, 'failed');
  const failed = { evaluation: 'baseline_error', mutants: [], diagnostics: [] };
  assert.equal(withUndoneChanges(failed, undone), failed);
});

test('a change that does not parse alone is listed as unsupported without a run, and the whole file is run instead', () => repository((root, git) => {
  const old = 'export function f(a) {\n  if (a) {\n    note(a);\n    note(1);\n  }\n  return 2;\n}\n';
  writeFileSync(join(root, 'subject.js'), old);
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(root, 'subject.js'), 'export function f(a) {\n  if (a)\n    note(a);\n    note(1);\n  return 2;\n}\n');
  const edits = [];
  const passing = { sourceTrials: () => settings => { if (settings) edits.push(settings.trial.replacement); return { status: 'passed', tests: [] }; } };
  const report = analyzeUndoneChanges(root, ['subject.js'], { since: 'HEAD' }, passing);
  assert.deepEqual(report.mutants.map(mutant => [mutant.status, mutant.together === true]), [['unsupported', false], ['unsupported', false], ['survived', true]]);
  assert.deepEqual(edits, [old]);
  assert.match(report.mutants[0].statusReason, /does not parse/);
  assert.match(renderText({ runner: 'vitest', evaluation: 'evaluated', ...report }), /the tests pass with these changes of the file put back together as they were at/);
}));

test('a change of spacing that changes the program is tried, and one that does not is left out', () => {
  const tried = (file, old, current) => planUndo(file, Buffer.from(old), Buffer.from(current), patchOf(Buffer.from(old), Buffer.from(current))).length;
  // A line end after `return` ends the statement.
  assert.equal(tried('f.js', 'function f() {\n  return\n  1\n}\n', 'function f() {\n  return 1\n}\n'), 1);
  assert.equal(tried('f.js', 'const f = (a, b) => a +\n  b\n', 'const f = (a, b) => a + b\n'), 0);
  // Text between tags is code; the indentation of its lines is not.
  assert.equal(tried('f.jsx', 'const a = <b>Hello world</b>\n', 'const a = <b>Hello  world</b>\n'), 1);
  assert.equal(tried('f.jsx', 'const a = <b>\n  Hello\n</b>\n', 'const a = <b>\n      Hello\n</b>\n'), 0);
  // Tags put on lines of their own have the same children.
  assert.equal(tried('f.jsx', 'const a = <div><span>Hello</span></div>\n', 'const a = <div>\n  <span>Hello</span>\n</div>\n'), 0);
  assert.equal(tried('f.jsx', 'const a = <div><span>Hello</span> <i/></div>\n', 'const a = <div><span>Hello</span><i/></div>\n'), 1);
  // A no-break space on a line of its own is text.
  assert.equal(tried('f.jsx', 'const a = <div>\n  <b/>\n  <i/>\n</div>\n', 'const a = <div>\n  <b/>\n  \u00a0\n  <i/>\n</div>\n'), 1);
  assert.equal(tried('f.ts', 'let n = 1\n', 'const n = 1\n'), 1);
  // A space in a regular expression or a template is code; a comment after a template is not.
  assert.equal(tried('f.js', 'const r = /a +b/\n', 'const r = /a+b/\n'), 1);
  assert.equal(tried('f.js', 'const t = `a  ${1} b`\n', 'const t = `a ${1} b`\n'), 1);
  assert.equal(tried('f.js', 'const greet = name => `Hi ${name}!`;\n// old\n', 'const greet = name => `Hi ${name}!`;\n// new\n'), 0);
  assert.equal(tried('f.js', '/** old */\nfunction f() {}\n', '/** new\n * @returns nothing */\nfunction f() {}\n'), 0);
  assert.equal(tried('f.js', 'const n = -a\n', 'const n = +a\n'), 1);
});

test('the old lines come back with the line ends of the checkout, a test file is not put back, and code that cannot load is noticed', () => repository((root, git) => {
  writeFileSync(join(root, '.gitattributes'), '*.js text eol=crlf\n');
  writeFileSync(join(root, 'subject.js'), 'export const a = 1;\r\nexport const b = 2;\r\n');
  writeFileSync(join(root, 'checks.js'), 'export const expected = 1;\r\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(root, 'subject.js'), 'export const a = 5;\r\nexport const b = 2;\r\n');
  writeFileSync(join(root, 'checks.js'), 'export const expected = 5;\r\n');
  const edits = [];
  const loaded = [{ file: 'checks.js', name: 'checks', status: 'passed' }];
  const run = { sourceTrials: () => settings => {
    if (!settings) return { status: 'passed', tests: loaded };
    edits.push([settings.trial.site.location.file, settings.trial.replacement]);
    return { status: 'error', tests: [], errors: ['ReferenceError: defaults is not defined\n    at subject.js:1'] };
  } };
  const report = analyzeUndoneChanges(root, [], { since: 'HEAD' }, run);
  assert.deepEqual(edits, [['subject.js', 'export const a = 1;\r\n']]);
  assert.deepEqual(report.mutants.map(mutant => [mutant.location.file, mutant.status, mutant.statusReason]),
    [['subject.js', 'load_error', 'The suite did not load: ReferenceError: defaults is not defined']]);
  assert.equal(report.evaluation, 'evaluated');
  // Only an explicitly uninstrumented (`plain: true`) passing baseline is reused; an instrumented baseline triggers a fresh run.
  let baselineRuns = 0;
  const reused = analyzeUndoneChanges(root, [], { since: 'HEAD', existingBaseline: { status: 'passed', tests: loaded, plain: true } },
    { sourceTrials: () => settings => {
      if (!settings) { baselineRuns++; return { status: 'passed', tests: loaded }; }
      return { status: 'passed', tests: loaded };
    } });
  assert.equal(baselineRuns, 0);
  assert.equal(reused.mutants[0].status, 'survived');
  const unplain = analyzeUndoneChanges(root, [], { since: 'HEAD', existingBaseline: { status: 'passed', tests: loaded } },
    { sourceTrials: () => settings => {
      if (!settings) { baselineRuns++; return { status: 'failed', tests: [{ ...loaded[0], status: 'failed' }] }; }
      return { status: 'passed', tests: loaded };
    } });
  assert.equal(baselineRuns, 1);
  assert.equal(unplain.evaluation, 'baseline_error');
  // A post-load unhandled error (no `moduleErrors`) is reported as `error` / `incomplete`, not `load_error`.
  const postLoad = analyzeUndoneChanges(root, ['subject.js'], { since: 'HEAD' },
    { sourceTrials: () => settings => (settings
      ? { status: 'error', tests: loaded, errors: ['Unhandled Rejection: boom'], moduleErrors: [] }
      : { status: 'passed', tests: loaded }) });
  assert.deepEqual([postLoad.mutants[0].status, postLoad.evaluation], ['error', 'incomplete']);
  // A runner that broke down names no error of the suite.
  const broken = analyzeUndoneChanges(root, ['subject.js'], { since: 'HEAD' },
    { sourceTrials: () => settings => (settings ? { status: 'error', output: 'spawn failed' } : { status: 'passed', tests: loaded }) });
  assert.deepEqual([broken.mutants[0].status, broken.evaluation], ['error', 'incomplete']);
  // Playwright reports a server that could not start the same way, and then the old code never ran.
  const browser = analyzeUndoneChanges(root, ['subject.js'], { since: 'HEAD', runner: 'playwright' },
    { sourceTrials: () => settings => (settings ? { status: 'error', tests: [], errors: ['port is already used'], moduleErrors: ['port is already used'] } : { status: 'passed', tests: loaded }) });
  assert.deepEqual([browser.mutants[0].status, browser.evaluation], ['error', 'incomplete']);
}));

test('a multi-hunk file where one hunk fails to load alone falls back to reverting all in-scope hunks together', () => repository((root, git) => {
  const old = 'export const base = 1;\nexport const keep = 2;\nexport const other = 3;\nexport function run() { return base; }\n';
  writeFileSync(join(root, 'subject.js'), old);
  git('add', '.');
  git('commit', '-qm', 'first');
  const current = 'const helper = () => 1;\nexport const base = 1;\nexport const keep = 2;\nexport const other = 3;\nexport function run() { return helper(); }\n';
  writeFileSync(join(root, 'subject.js'), current);
  const loaded = [{ file: 'subject.test.js', name: 'runs', status: 'passed' }];
  const seen = [];
  const run = { sourceTrials: () => settings => {
    if (!settings) return { status: 'passed', tests: loaded };
    seen.push([settings.trial.together === true, settings.trial.replacement]);
    if (!settings.trial.together && settings.trial.replacement === '') {
      return { status: 'error', tests: [], errors: ['ReferenceError: helper is not defined'], moduleErrors: ['ReferenceError: helper is not defined'] };
    }
    return { status: 'passed', tests: loaded };
  } };
  const report = analyzeUndoneChanges(root, ['subject.js'], { since: 'HEAD' }, run);
  assert.equal(report.evaluation, 'evaluated');
  assert.deepEqual(report.mutants.map(m => [m.status, m.together === true]), [['load_error', false], ['survived', false], ['survived', true]]);
  assert.equal(seen.at(-1)[0], true);
  assert.equal(seen.at(-1)[1], old);
  assert.ok(report.diagnostics.some(d => d.kind === 'UNTESTED CHANGE' && d.together === true));
}));
