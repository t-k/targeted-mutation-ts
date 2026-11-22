import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chooseFormat, renderText, usage } from '../src/cli-output.mjs';

const scenarios = readFileSync(new URL('../verification/pict/report-format.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

const location = { file: 'src/cart.ts', line: 4, column: 13, start: 119, end: 121 };
const survivor = { site: 'a', location, rule: 'comparison-boundary/v1', operator: '>=', edit: [119, 121],
  replacement: '>', status: 'survived', evidence: 'reexecuted' };
const killed = { ...survivor, location: { ...location, line: 9 }, replacement: '>', status: 'killed' };
const reports = {
  Gaps: { schemaVersion: 1, runner: 'vitest', extraction: [{ file: 'src/cart.ts', path: 'fast' }],
    mutants: [survivor, killed], evaluation: 'evaluated', baseline: { status: 'passed', tests: 5 },
    diagnostics: [{ kind: 'INPUT GAP', site: 'a', location,
      witness: { input: 5000, operands: [5000, 5000], original: true, mutant: false, expectation: 'original' },
      suggestedTest: 'expect(shippingFee(5000)).toBe(0)' }] },
  Clean: { schemaVersion: 1, runner: 'vitest', extraction: [], mutants: [killed], diagnostics: [],
    evaluation: 'evaluated', baseline: { status: 'passed', tests: 5 } },
  BaselineFailed: { schemaVersion: 1, runner: 'vitest', extraction: [], mutants: [], diagnostics: [],
    evaluation: 'baseline_error', baseline: { status: 'failed', output: '', errors: [],
      failedTests: [{ file: 'test/bad.test.ts', name: 'fails', failures: ['expected 1 to be 2\n    at stack'] }] } },
  NoSites: { schemaVersion: 1, runner: 'vitest', extraction: [], mutants: [], diagnostics: [], evaluation: 'no_sites' },
};

for (const [format, terminal, outcome] of scenarios) {
  test(`report format: ${format} ${terminal} ${outcome}`, () => {
    const requested = { Unset: undefined, Text: 'text', Json: 'json' }[format];
    const chosen = chooseFormat(requested, terminal === 'Tty');
    assert.equal(chosen, format === 'Json' || (format === 'Unset' && terminal === 'Pipe') ? 'json' : 'text');
    const text = renderText(reports[outcome]);
    if (outcome === 'Gaps') {
      assert.match(text, /^src\/cart\.ts:4:13 {2}survived {2}comparison-boundary\/v1: >= -> >$/m);
      assert.match(text, /^INPUT GAP src\/cart\.ts:4:13$/m);
      assert.match(text, /^ {2}operands \(5000, 5000\): original true, edited false$/m);
      assert.match(text, /^ {2}suggested test: expect\(shippingFee\(5000\)\)\.toBe\(0\)$/m);
      assert.match(text, /^vitest, 5 baseline tests: 2 edits \(1 survived, 1 killed\), 1 test gaps$/m);
    } else if (outcome === 'Clean') {
      assert.match(text, /^vitest, 5 baseline tests: 1 edits \(1 killed\), 0 test gaps$/m);
      assert.doesNotMatch(text, /Test gaps:/);
    } else if (outcome === 'BaselineFailed') {
      assert.match(text, /baseline failed/);
      assert.match(text, /^ {2}FAILED test\/bad\.test\.ts > fails$/m);
      assert.match(text, /^ {4}expected 1 to be 2$/m);
      assert.doesNotMatch(text, /at stack|edits/);
    } else {
      assert.equal(text, 'No edit sites in the selected scope.');
    }
  });
}

test('an unknown format is rejected', () => {
  assert.throws(() => chooseFormat('yaml', true), /Expected --format text\|json/);
});

test('text output neutralizes control sequences from the analyzed project', () => {
  const text = renderText({ ...reports.BaselineFailed, baseline: { status: 'failed',
    failedTests: [{ file: 'a.test.ts', name: 'x\u001b[2Jy\u0000', failures: ['\u009b31m boom'] }] } });
  assert.doesNotMatch(text, /[\u0000\u001b\u009b]/);
  assert.match(text, /x\?\[2Jy\?/);
});

test('text output covers source rewrites, witnesses, parse failures and a silent baseline error', () => {
  const text = renderText({ runner: 'vitest', evaluation: 'incomplete', baseline: { status: 'passed', tests: [1, 2] },
    extraction: [{ file: 'src/bad.ts', path: 'diagnostic', reason: 'outside-l1', diagnostics: [{ message: 'Expression expected.' }] }],
    mutants: [
      { location, mutatorName: 'ArrowFunction', original: '(a) =>\n a', replacement: '() => undefined', status: 'killed' },
      { location, rule: 'comparison-threshold/v1', operator: '>=', replacement: '17', status: 'unreached' },
    ],
    diagnostics: [{ kind: 'INPUT GAP', rule: 'substitute-number/v1', location,
      witness: { arguments: [90, 100], original: true, mutant: false },
      seed: { file: 'test/q.test.ts', test: 'accepts' }, verification: { status: 'confirmed' } }, {}] });
  assert.match(text, /^SKIPPED src\/bad\.ts: outside-l1\n {2}Expression expected\.$/m);
  assert.match(text, /killed {2}ArrowFunction: \(a\) => -> \(\) => undefined$/m);
  assert.match(text, /unreached {2}comparison-threshold\/v1: replace with 17$/m);
  assert.match(text, /^INPUT GAP src\/cart\.ts:4:13 {2}substitute-number\/v1$/m);
  assert.match(text, /^ {2}arguments \(90, 100\): original true, edited false$/m);
  assert.match(text, /^ {2}based on: test\/q\.test\.ts > accepts$/m);
  assert.match(text, /^ {2}verification: confirmed$/m);
  assert.match(text, /^GAP \(unknown location\)$/m);
  assert.match(text, /^vitest, 2 baseline tests: 2 edits \(1 killed, 1 unreached\), 2 test gaps, evaluation incomplete$/m);
  const silent = renderText({ evaluation: 'baseline_error', baseline: { status: 'error', output: 'line 1\nconfig broke\n' } });
  assert.match(silent, /baseline error/);
  assert.match(silent, /^ {2}config broke$/m);
  assert.match(renderText({ evaluation: 'baseline_error', baseline: { status: 'error', errors: ['Unhandled\nmore'] } }), /^ {2}ERROR Unhandled$/m);
});

test('help starts with usage and names every option the CLI parses', () => {
  assert.match(usage, /^Usage: targeted-mutation /);
  const cli = readFileSync(new URL('../bin/tmt.mjs', import.meta.url), 'utf8');
  const options = [...cli.matchAll(/^\s+'?([a-z-]+)'?: \{ type: '(?:string|boolean)'/gm)].map(match => match[1]);
  assert.ok(options.length >= 17, `parsed ${options.length} options`);
  for (const option of options) assert.ok(usage.includes(`--${option}`), `--${option} is undocumented`);
});

test('the text report has an exact layout', () => {
  assert.equal(renderText(reports.Gaps), [
    'src/cart.ts:4:13  survived  comparison-boundary/v1: >= -> >',
    'src/cart.ts:9:13  killed  comparison-boundary/v1: >= -> >',
    '',
    'Test gaps:',
    'INPUT GAP src/cart.ts:4:13',
    '  operands (5000, 5000): original true, edited false',
    '  suggested test: expect(shippingFee(5000)).toBe(0)',
    '',
    'vitest, 5 baseline tests: 2 edits (1 survived, 1 killed), 1 test gaps',
  ].join('\n'));
  assert.equal(renderText(reports.Clean), [
    'src/cart.ts:9:13  killed  comparison-boundary/v1: >= -> >', '',
    'vitest, 5 baseline tests: 1 edits (1 killed), 0 test gaps',
  ].join('\n'));
  assert.equal(renderText(reports.BaselineFailed), [
    'The test suite did not pass before any edit (baseline failed). Fix it and run again.',
    '  FAILED test/bad.test.ts > fails',
    '    expected 1 to be 2',
  ].join('\n'));
});

test('sparse reports render without invented entries', () => {
  assert.equal(renderText({ runner: 'playwright', evaluation: 'evaluated' }), 'playwright: 0 edits (none), 0 test gaps');
  assert.equal(renderText({ runner: 'vitest', evaluation: 'evaluated', extraction: [{ file: 'a.ts', path: 'fast' }],
    mutants: [{ location, replacement: '>', status: 'killed' }, { location, operator: '>', replacement: '>x', status: 'killed' },
      { location, operator: '>', replacement: 'x>=', status: 'killed' }],
    diagnostics: [{ kind: 'INPUT GAP', location }] }), [
    'src/cart.ts:4:13  killed  edit: replace with >',
    'src/cart.ts:4:13  killed  edit: replace with >x',
    'src/cart.ts:4:13  killed  edit: replace with x>=',
    '', 'Test gaps:', 'INPUT GAP src/cart.ts:4:13', '',
    'vitest: 3 edits (3 killed), 1 test gaps',
  ].join('\n'));
  assert.equal(renderText({ evaluation: 'no_sites', extraction: [{ file: 'b.ts', path: 'diagnostic' }, { file: 'c.ts', path: 'diagnostic', reason: 'source-limit' }] }),
    'SKIPPED b.ts: not analyzed\nSKIPPED c.ts: source-limit\n\nNo edit sites in the selected scope.');
  assert.equal(renderText({ evaluation: 'baseline_error' }),
    'The test suite did not pass before any edit (baseline unknown). Fix it and run again.');
  assert.equal(renderText({ evaluation: 'baseline_error', baseline: { status: 'failed', failedTests: [{ file: 'a', name: 'b' }] } }),
    'The test suite did not pass before any edit (baseline failed). Fix it and run again.\n  FAILED a > b');
});

test('runner output is shown only when nothing more specific explains a baseline error', () => {
  const output = '\n' + Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n') + '\n\n';
  const shown = renderText({ evaluation: 'baseline_error', baseline: { status: 'error', output } }).split('\n');
  assert.equal(shown.length, 21);
  assert.deepEqual([shown[1], shown.at(-1)], ['  line 6', '  line 25']);
  const header = 'The test suite did not pass before any edit (baseline error). Fix it and run again.';
  assert.equal(renderText({ evaluation: 'baseline_error', baseline: { status: 'error', output: '  \n' } }), header);
  assert.equal(renderText({ evaluation: 'baseline_error', baseline: { status: 'error', output, errors: ['\n  Unhandled rejection  \nstack'] } }),
    `${header}\n  ERROR Unhandled rejection`);
  assert.equal(renderText({ evaluation: 'baseline_error', baseline: { status: 'error', output, errors: [' \n '],
    failedTests: [{ file: 'a', name: 'b', failures: [] }] } }), `${header}\n  FAILED a > b\n  ERROR `);
});
