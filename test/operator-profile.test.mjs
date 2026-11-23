import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeFocused, analyzeOperators } from '../src/operator-analysis.mjs';

const location = (file, start) => ({ file, line: 1, column: start + 1, start, end: start + 2 });
const comparison = { site: 'c', location: location('a.ts', 20), rule: 'comparison-boundary/v1', operator: '>=', edit: [20, 22], replacement: '>', status: 'survived' };
const focusedReport = { schemaVersion: 1, runner: 'vitest', extraction: [{ file: 'a.ts', path: 'fast' }], mutants: [comparison],
  diagnostics: [{ kind: 'INPUT GAP', site: 'c' }], evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };
const swap = { id: 's1', mutatorName: 'equality-negation/v1', location: location('a.ts', 5), edit: [5, 8], original: '===', replacement: '!==',
  status: 'killed', evidence: 'reexecuted', tests: [{ id: 't', name: 'x', file: 'a.test.ts', project: '' }] };
const sessionReport = { schemaVersion: 1, runner: 'vitest', mutators: 'operators', extraction: [], diagnostics: [],
  mutants: [{ ...swap, id: 's2', location: location('a.ts', 40), status: 'unreached', evidence: 'coverage', tests: undefined }, swap],
  evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };

// The focused analysis is prepared while the session runs and completed with the session's verdicts.
function runners(focused, session) {
  const calls = [];
  const report = options => typeof focused === 'function' ? focused(options) : focused;
  const ended = value => value.evaluation === 'baseline_error' || value.evaluation === 'no_sites';
  return { calls,
    analyze: (project, files, options) => { calls.push(['analyze', options.mutators]); return report(options); },
    prepareAnalysis: (project, files, options) => {
      calls.push(['prepare', options.mutators]);
      const value = report(options);
      return ended(value) ? { report: value } : { report: value, trials: [] };
    },
    completeAnalysis: (prepared, settled) => { calls.push(['complete', settled]); return prepared.report; },
    analyzeConventional: async (project, files, options) => { calls.push(['session', options]); return session; } };
}
const options = { mutators: 'operators', lines: ['a.ts:1'], test: ['a.test.ts'], audit: true, spec: 'spec.json', dialect: 'ts', 'copy-exclude': ['x'] };

test('Vitest merges focused comparison results with operator swaps from one session', async () => {
  const run = runners(focusedReport, sessionReport);
  const report = await analyzeOperators('.', ['a.ts'], options, run);
  assert.deepEqual(run.calls.map(call => call[0]), ['session', 'prepare', 'complete']);
  const { signal, ...passed } = run.calls[0][1];
  assert.deepEqual(passed, { mutators: 'operators', lines: ['a.ts:1'], since: undefined, config: undefined,
    test: ['a.test.ts'], 'copy-exclude': ['x'], dialect: 'ts', 'isolated-trials': undefined, concurrency: undefined });
  assert.equal(signal.aborted, false);
  assert.deepEqual(run.calls[1], ['prepare', undefined]);
  assert.deepEqual([report.mutators, report.operatorExecution, report.evaluation], ['operators', 'session', 'evaluated']);
  assert.deepEqual(report.mutants.map(mutant => [mutant.location.start, mutant.rule, mutant.operator, mutant.replacement, mutant.status]), [
    [5, 'equality-negation/v1', '===', '!==', 'killed'],
    [20, 'comparison-boundary/v1', '>=', '>', 'survived'],
    [40, 'equality-negation/v1', '===', '!==', 'unreached'],
  ]);
  assert.deepEqual(report.mutants[0], { site: 's1', rule: 'equality-negation/v1', operator: '===', location: location('a.ts', 5), edit: [5, 8],
    replacement: '!==', status: 'killed', evidence: 'reexecuted', tests: swap.tests });
  assert.deepEqual(report.diagnostics, focusedReport.diagnostics);
  assert.deepEqual(report.extraction, focusedReport.extraction);
  assert.deepEqual(report.baseline, { status: 'passed', tests: 2 });
});

test('a file with operator swaps and no comparison is still evaluated, and an unfinished session is incomplete', async () => {
  const empty = { ...focusedReport, mutants: [], diagnostics: [], evaluation: 'no_sites', baseline: undefined };
  const report = await analyzeOperators('.', [], options, runners(empty, sessionReport));
  assert.equal(report.evaluation, 'evaluated');
  assert.deepEqual(report.baseline, sessionReport.baseline);
  assert.equal(report.mutants.length, 2);
  const partial = await analyzeOperators('.', [], options, runners(focusedReport, { ...sessionReport, evaluation: 'incomplete' }));
  assert.equal(partial.evaluation, 'incomplete');
  const none = await analyzeOperators('.', [], options, runners(focusedReport, { ...sessionReport, mutants: [], evaluation: 'no_sites' }));
  assert.deepEqual([none.evaluation, none.operatorExecution, none.mutants.length], ['evaluated', 'session', 1]);
});

test('a failed baseline or an unparsed file stops the session and is reported alone', async () => {
  for (const failed of [{ ...focusedReport, evaluation: 'baseline_error', baseline: { status: 'failed' } },
    { ...focusedReport, evaluation: 'no_sites', extraction: [{ file: 'a.ts', path: 'diagnostic' }] }]) {
    const run = runners(failed, sessionReport);
    const report = await analyzeOperators('.', [], options, run);
    assert.deepEqual(run.calls.map(call => call[0]), ['session', 'prepare']);
    assert.equal(run.calls[0][1].signal.aborted, true);
    assert.equal(report.evaluation, failed.evaluation);
    assert.equal(report.mutators, 'operators');
  }
});

test('Playwright and sessions that cannot start fall back to one source rewrite per edit', async () => {
  const rewritten = { ...focusedReport, mutators: 'operators' };
  const playwright = runners(rewritten, sessionReport);
  const report = await analyzeOperators('.', [], { ...options, runner: 'playwright' }, playwright);
  assert.deepEqual(playwright.calls, [['analyze', 'operators']]);
  assert.equal(report.operatorExecution, 'source-rewrite');
  const unsupported = runners(received => received.mutators === 'operators' ? rewritten : focusedReport,
    { ...sessionReport, evaluation: 'baseline_error', baseline: { status: 'error', output: 'The standard profile requires Vitest 4, found 3.2.4' } });
  const fallback = await analyzeOperators('.', [], options, unsupported);
  assert.deepEqual(unsupported.calls.map(call => call[0]), ['session', 'prepare', 'analyze']);
  assert.equal(unsupported.calls[2][1], 'operators');
  assert.equal(fallback.operatorExecution, 'source-rewrite');
});

test('the full profile reports built-in mutations in their own shape and keeps one result per comparison boundary', async () => {
  const builtIn = (id, mutatorName, start, end, original, replacement, extra = {}) => ({ id, mutatorName, location: { file: 'a.ts', line: 1, column: start + 1, start, end },
    edit: [start, end], original, replacement, status: 'killed', evidence: 'reexecuted', source: { edit: [start, end], replacement }, ...extra });
  const session = { ...sessionReport, mutators: 'full', mutants: [
    builtIn('b1', 'BlockStatement', 0, 60, '{ ... }', '{}'),
    builtIn('e1', 'EqualityOperator', 14, 28, 'total >= 100', 'total > 100', { operatorSwap: [20, '>'] }),
    builtIn('e2', 'EqualityOperator', 14, 28, 'total >= 100', 'total < 100', { operatorSwap: [20, '<'] }),
    builtIn('c1', 'ConditionalExpression', 14, 28, 'total >= 100', 'true'),
  ] };
  const run = runners(focusedReport, session);
  const report = await analyzeOperators('.', ['a.ts'], { ...options, mutators: 'full' }, run);
  assert.equal(run.calls[0][1].mutators, 'full');
  assert.deepEqual([report.mutators, report.operatorExecution], ['full', 'session']);
  assert.deepEqual(report.mutants.map(mutant => [mutant.id ?? mutant.site, mutant.mutatorName ?? mutant.rule, mutant.replacement]), [
    ['b1', 'BlockStatement', '{}'],
    ['e2', 'EqualityOperator', 'total < 100'],
    ['c1', 'ConditionalExpression', 'true'],
    ['c', 'comparison-boundary/v1', '>'],
  ]);
  for (const mutant of report.mutants) assert.equal(mutant.source ?? mutant.operatorSwap, undefined);
  assert.equal(report.mutants[0].original, '{ ... }');
});

test('the session answers a focused trial for the same comparison boundary and no other', async () => {
  const builtIn = (start, replacement, status, extra = {}) => ({ id: 'e' + start + replacement, mutatorName: 'EqualityOperator',
    location: { file: 'a.ts', line: 1, column: 1, start: 14, end: 28 }, edit: [14, 28], original: 'x', replacement: 'y', status,
    operatorSwap: [start, replacement], ...extra });
  const killers = [{ id: 't', name: 'x', file: 'a.test.ts', project: '' }];
  const session = { ...sessionReport, mutators: 'full', mutants: [
    builtIn(20, '>', 'killed', { tests: killers }), builtIn(50, '>', 'unreached'), builtIn(60, '>', 'survived'),
    builtIn(70, '>', 'timeout'), builtIn(80, '>', 'unstable'), builtIn(90, '>', 'unevaluated'),
  ] };
  const run = runners(focusedReport, session);
  await analyzeOperators('.', ['a.ts'], { ...options, mutators: 'full' }, run);
  const settled = run.calls.find(call => call[0] === 'complete')[1];
  const trial = (start, replacement = '>', extra = {}) => ({ rule: 'comparison-boundary/v1', edit: [start, start + 2], replacement,
    site: { rule: 'comparison-boundary/v1', location: { file: 'a.ts' } }, ...extra });
  assert.deepEqual(settled(trial(20)), { status: 'killed', tests: killers });
  // Reach is decided by the focused analysis from its recorded comparisons.
  assert.deepEqual(settled(trial(50)), { status: 'survived', tests: undefined });
  assert.equal(settled(trial(60)).status, 'survived');
  assert.equal(settled(trial(70)).status, 'timeout');
  // A run without a verdict, another replacement, another file, a threshold edit and a regrouped edit are run again.
  assert.equal(settled(trial(80)), undefined);
  assert.equal(settled(trial(90)), undefined);
  assert.equal(settled(trial(20, '<')), undefined);
  assert.equal(settled({ ...trial(20), site: { rule: 'comparison-boundary/v1', location: { file: 'b.ts' } } }), undefined);
  assert.equal(settled(trial(20, '>', { rule: 'comparison-threshold/v1' })), undefined);
  assert.equal(settled(trial(20, '>', { source: { edit: [0, 30], replacement: '(a > b)' } })), undefined);
});

test('an error in the focused preparation or in the session stops the other part', async () => {
  const broken = runners(focusedReport, sessionReport);
  broken.prepareAnalysis = () => { throw new Error('extractor missing'); };
  await assert.rejects(analyzeOperators('.', [], options, broken), /extractor missing/);
  assert.equal(broken.calls[0][1].signal.aborted, true);
  const failing = runners(focusedReport, sessionReport);
  failing.analyzeConventional = async () => { throw new Error('session failed'); };
  await assert.rejects(analyzeOperators('.', [], options, failing), /session failed/);
});

test('the default profile reports the focused analysis alone and lets a boundary session answer its trials', async () => {
  const plain = { ...options, mutators: undefined, audit: undefined, concurrency: 3 };
  const run = runners(focusedReport, { ...sessionReport, mutators: 'boundaries', mutants: [
    { ...swap, operatorSwap: [20, '>'], status: 'killed' }] });
  const report = await analyzeFocused('.', ['a.ts'], plain, run);
  assert.deepEqual(run.calls.map(call => call[0]), ['session', 'prepare', 'complete']);
  assert.deepEqual([run.calls[0][1].mutators, run.calls[0][1].concurrency], ['boundaries', 3]);
  assert.equal(report, focusedReport);
  const settled = run.calls[2][1];
  assert.equal(settled({ rule: 'comparison-boundary/v1', edit: [20, 22], replacement: '>',
    site: { rule: 'comparison-boundary/v1', location: { file: 'a.ts' } } }).status, 'killed');
});

test('the default profile keeps its own runs when the session cannot help', async () => {
  // Playwright and --audit run every edit against the rewritten source.
  for (const direct of [{ runner: 'playwright' }, { audit: true }]) {
    const run = runners(focusedReport, sessionReport);
    assert.equal(await analyzeFocused('.', [], { ...options, mutators: undefined, audit: undefined, ...direct }, run), focusedReport);
    assert.deepEqual(run.calls.map(call => call[0]), ['analyze']);
  }
  const plain = { ...options, mutators: undefined, audit: undefined };
  // A session that fails, or that could not establish its baseline, leaves every trial to the focused analysis.
  const failing = runners(focusedReport, sessionReport);
  failing.analyzeConventional = async () => { throw new Error('Vitest 3 is not supported'); };
  assert.equal(await analyzeFocused('.', [], plain, failing), focusedReport);
  assert.equal(failing.calls.at(-1)[1], undefined);
  const unusable = runners(focusedReport, { ...sessionReport, evaluation: 'baseline_error', mutants: [] });
  assert.equal(await analyzeFocused('.', [], plain, unusable), focusedReport);
  assert.equal(unusable.calls.at(-1)[1]({ rule: 'r', edit: [20, 22], replacement: '>', site: { rule: 'r', location: { file: 'a.ts' } } }), undefined);
  // An analysis that ends in its preparation stops the session whatever the reason.
  for (const ended of [{ ...focusedReport, evaluation: 'no_sites' }, { ...focusedReport, evaluation: 'baseline_error' }]) {
    const run = runners(ended, sessionReport);
    assert.equal(await analyzeFocused('.', [], plain, run), ended);
    assert.deepEqual(run.calls.map(call => call[0]), ['session', 'prepare']);
    assert.equal(run.calls[0][1].signal.aborted, true);
  }
});

for (const [fixture, files, extra] of [
  ['fixtures/eligibility', ['src/eligibility.ts'], { spec: 'spec.json' }],
  ['fixtures/shipping', ['src/shipping.ts'], { spec: 'spec.json', deterministic: true }],
  ['fixtures/eligibility', ['src/eligibility.ts'], { 'displace-thresholds': true, 'isolated-trials': true }],
]) {
  test(`the default profile's report is the one its own runs produce: ${fixture} ${Object.keys(extra)}`, async () => {
    const { analyze } = await import('../src/analysis.mjs');
    const { 'isolated-trials': isolated, ...focusedOptions } = extra;
    const own = analyze(fixture, files, focusedOptions);
    const beside = await analyzeFocused(fixture, files, extra);
    assert.equal(own.evaluation, 'evaluated');
    assert.ok(own.mutants.length > 0);
    assert.deepEqual(beside, own);
  });
}
