import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOperators, shiftTrials } from '../src/operator-analysis.mjs';

const location = (file, start) => ({ file, line: 1, column: start + 1, start, end: start + 2 });
const comparison = { site: 'c', location: location('a.ts', 20), rule: 'comparison-boundary/v1', operator: '>=', edit: [20, 22], replacement: '>', status: 'survived' };
const focusedReport = { schemaVersion: 1, runner: 'vitest', extraction: [{ file: 'a.ts', path: 'fast' }], mutants: [comparison],
  diagnostics: [{ kind: 'INPUT GAP', site: 'c' }], evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };
const targetedEdit = { id: 's1', mutatorName: 'equality-constant/v1', location: location('a.ts', 5), edit: [5, 8], original: 'a === b', replacement: '(a, b, true)',
  status: 'killed', evidence: 'reexecuted', tests: [{ id: 't', name: 'x', file: 'a.test.ts', project: '' }] };
const sessionReport = { schemaVersion: 1, runner: 'vitest', mutators: 'targeted', extraction: [], diagnostics: [],
  mutants: [{ ...targetedEdit, id: 's2', location: location('a.ts', 40), status: 'unreached', evidence: 'coverage', tests: undefined }, targetedEdit],
  evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };

// The focused analysis is prepared while the session runs and completed with the session's verdicts.
function runners(focused, session) {
  const calls = [];
  const report = options => typeof focused === 'function' ? focused(options) : focused;
  const ended = value => value.evaluation === 'baseline_error' || value.evaluation === 'no_sites';
  return { calls,
    analyze: (project, files, options) => { calls.push(['analyze', options.mutators]); return report(options); },
    prepareAnalysis: (project, files, options) => {
      calls.push(['prepare', options.mutators, options.traceIsBaseline]);
      const value = report(options);
      return ended(value) ? { report: value } : { report: value, trials: value.trials ?? [], skips: value.skips };
    },
    completeAnalysis: (prepared, settled) => { calls.push(['complete', settled]); return prepared.report; },
    analyzeConventional: async (project, files, options) => { calls.push(['session', options]); return session; } };
}
const options = { mutators: 'targeted', lines: ['a.ts:1'], test: ['a.test.ts'], spec: 'spec.json', dialect: 'ts', 'copy-exclude': ['x'] };

test('Vitest merges comparison results with targeted edits from one session', async () => {
  const run = runners(focusedReport, sessionReport);
  const report = await analyzeOperators('.', ['a.ts'], options, run);
  assert.deepEqual(run.calls.map(call => call[0]), ['session', 'prepare', 'complete']);
  const { signal, extras, ...passed } = run.calls[0][1];
  assert.deepEqual(await extras, []);
  assert.deepEqual(passed, { mutators: 'targeted', lines: ['a.ts:1'], since: undefined, config: undefined,
    test: ['a.test.ts'], 'copy-exclude': ['x'], dialect: 'ts', 'isolated-trials': undefined, concurrency: undefined, 'verify-trials': undefined, timeout: undefined });
  assert.equal(signal.aborted, false);
  assert.deepEqual(run.calls[1], ['prepare', undefined, true]);
  assert.deepEqual([report.mutators, report.operatorExecution, report.evaluation], ['targeted', 'session', 'evaluated']);
  assert.deepEqual(report.mutants.map(mutant => [mutant.location.start, mutant.rule, mutant.replacement, mutant.status]), [
    [5, 'equality-constant/v1', '(a, b, true)', 'killed'],
    [20, 'comparison-boundary/v1', '>', 'survived'],
    [40, 'equality-constant/v1', '(a, b, true)', 'unreached'],
  ]);
  assert.deepEqual(report.diagnostics, focusedReport.diagnostics);
  assert.deepEqual(report.extraction, focusedReport.extraction);
  assert.deepEqual(report.baseline, { status: 'passed', tests: 2 });
});

test('a file with targeted edits and no comparison is still evaluated, and an unfinished session is incomplete', async () => {
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
    assert.equal(report.mutators, 'targeted');
  }
});

test('--audit and sessions that cannot start fall back to one source rewrite per edit', async () => {
  const rewritten = { ...focusedReport, mutators: 'targeted' };
  const auditRun = runners(rewritten, sessionReport);
  const auditReport = await analyzeOperators('.', [], { ...options, audit: true }, auditRun);
  assert.deepEqual(auditRun.calls, [['analyze', 'targeted']]);
  assert.equal(auditReport.operatorExecution, 'source-rewrite');

  // A Playwright session that reports `unsupported_session` falls back cleanly to `source-rewrite`.
  const pwFallbackCalls = [];
  const pwReport = await analyzeOperators('.', [], { ...options, runner: 'playwright' }, {
    analyze: (_p, _f, received) => { pwFallbackCalls.push(['analyze', received.mutators]); return rewritten; },
    analyzePlaywrightSession: async () => { pwFallbackCalls.push(['pw-session']); return { evaluation: 'unsupported_session' }; },
    prepareAnalysis: () => ({ report: focusedReport }),
    completeAnalysis: () => focusedReport,
    analyzeConventional: async () => sessionReport,
  });
  assert.deepEqual(pwFallbackCalls, [['pw-session'], ['analyze', 'targeted']]);
  assert.equal(pwReport.operatorExecution, 'source-rewrite');

  // When Playwright falls back due to `no-runtime-switch-observations` and no source-rewrite edit kills a test,
  // survivors are downgraded to `unevaluated` with `sourceApplication: 'unconfirmed'` and gap recommendations are suppressed.
  const allSurvivedRewrite = {
    schemaVersion: 1,
    runner: 'playwright',
    mutators: 'targeted',
    extraction: [],
    baseline: { status: 'passed', tests: 1 },
    evaluation: 'evaluated',
    mutants: [
      { site: 's1', location: { file: 'src/Overview.tsx', line: 10, column: 1, start: 0, end: 5 }, rule: 'comparison-boundary/v1', edit: [0, 5], replacement: '>', status: 'survived', evidence: 'reexecuted' },
    ],
    diagnostics: [
      { kind: 'SURVIVED', site: 's1', location: { file: 'src/Overview.tsx', line: 10, column: 1 }, rule: 'comparison-boundary/v1', mutations: [{ rule: 'comparison-boundary/v1', replacement: '>' }] },
    ],
  };
  const unconfirmedReport = await analyzeOperators('.', [], { ...options, runner: 'playwright' }, {
    analyze: () => allSurvivedRewrite,
    analyzePlaywrightSession: async () => ({ evaluation: 'unsupported_session', unsupportedReason: 'no-runtime-switch-observations' }),
    prepareAnalysis: () => ({ report: focusedReport }),
    completeAnalysis: () => focusedReport,
    analyzeConventional: async () => sessionReport,
  });
  assert.equal(unconfirmedReport.operatorExecution, 'source-rewrite');
  assert.equal(unconfirmedReport.sessionFallbackReason, 'no-runtime-switch-observations');
  assert.equal(unconfirmedReport.sourceApplication, 'unconfirmed');
  assert.equal(unconfirmedReport.evaluation, 'incomplete');
  assert.equal(unconfirmedReport.mutants[0].status, 'unevaluated');
  assert.equal(unconfirmedReport.mutants[0].sourceVerdict, 'survived');
  assert.match(unconfirmedReport.mutants[0].statusReason, /may not have reached the running app/);
  assert.equal(unconfirmedReport.diagnostics.length, 0);

  // When source-rewrite establishes application via at least one kill, ordinary survivor and gap verdicts are preserved.
  const mixedRewrite = {
    ...allSurvivedRewrite,
    mutants: [
      ...allSurvivedRewrite.mutants,
      { site: 's2', location: { file: 'src/Overview.tsx', line: 12, column: 1, start: 10, end: 15 }, rule: 'comparison-boundary/v1', edit: [10, 15], replacement: '<', status: 'killed', evidence: 'reexecuted' },
    ],
  };
  const confirmedFallback = await analyzeOperators('.', [], { ...options, runner: 'playwright' }, {
    analyze: () => mixedRewrite,
    analyzePlaywrightSession: async () => ({ evaluation: 'unsupported_session', unsupportedReason: 'no-runtime-switch-observations' }),
    prepareAnalysis: () => ({ report: focusedReport }),
    completeAnalysis: () => focusedReport,
    analyzeConventional: async () => sessionReport,
  });
  assert.equal(confirmedFallback.operatorExecution, 'source-rewrite');
  assert.equal(confirmedFallback.sessionFallbackReason, 'no-runtime-switch-observations');
  assert.equal(confirmedFallback.sourceApplication, undefined);
  assert.equal(confirmedFallback.evaluation, 'evaluated');
  assert.equal(confirmedFallback.mutants[0].status, 'survived');
  assert.equal(confirmedFallback.diagnostics.length, 1);

  const unsupported = runners(received => received.mutators === 'targeted' ? rewritten : focusedReport,
    { ...sessionReport, evaluation: 'baseline_error', baseline: { status: 'error', output: 'The Vitest session requires Vitest 4, found 3.2.4' } });
  const fallback = await analyzeOperators('.', [], options, unsupported);
  assert.deepEqual(unsupported.calls.map(call => call[0]), ['session', 'prepare', 'analyze']);
  assert.equal(unsupported.calls[2][1], 'targeted');
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
  assert.deepEqual(settled(trial(50)), { status: 'survived', tests: undefined });
  assert.equal(settled(trial(60)).status, 'survived');
  assert.equal(settled(trial(70)).status, 'timeout');
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

test('threshold and tightening trials go to the session as shifts of their comparison, and its extra results answer them', async () => {
  const site = { rule: 'comparison-boundary/v1', location: { file: 'a.ts' }, edit: [20, 22], right: [23, 26] };
  const boundary = { site, rule: 'comparison-boundary/v1', edit: [20, 22], replacement: '>' };
  const threshold = { site, rule: 'comparison-threshold/v1', edit: [23, 26], replacement: '103', adjustment: 3, threshold: { meta: { threshold: 100 } } };
  const tighter = { site: { ...site, edit: [40, 41] }, rule: 'comparison-tighten/v1', edit: [43, 44], replacement: '((n) + 1)', adjustment: 1 };
  const predicted = { ...threshold, replacement: '110', adjustment: 10 };
  const rewritten = { ...tighter, source: { edit: [0, 50], replacement: 'x' } };
  const unmoved = { ...threshold, replacement: '100', adjustment: 0 };
  const prepared = { trials: [boundary, threshold, tighter, predicted, rewritten, unmoved, threshold], skips: new Set([3]) };
  assert.deepEqual(shiftTrials(prepared), [{ file: 'a.ts', at: 20, shift: 3 }, { file: 'a.ts', at: 40, shift: 1 }]);
  assert.deepEqual(shiftTrials({ report: {} }), []);

  const killers = [{ id: 't', name: 'x', file: 'a.test.ts', project: '' }];
  const session = { ...sessionReport, mutators: 'targeted', mutants: [],
    extras: [{ extra: 1, status: 'unreached' }, { extra: 0, status: 'killed', tests: killers }] };
  const run = runners({ ...focusedReport, trials: prepared.trials, skips: prepared.skips }, session);
  await analyzeOperators('.', ['a.ts'], { ...options, mutators: undefined }, run);
  assert.deepEqual(await run.calls[0][1].extras, [{ file: 'a.ts', at: 20, shift: 3 }, { file: 'a.ts', at: 40, shift: 1 }]);
  const settled = run.calls.find(call => call[0] === 'complete')[1];
  assert.deepEqual(settled(threshold), { status: 'killed', tests: killers });
  assert.deepEqual(settled(tighter), { status: 'survived', tests: undefined });
  assert.equal(settled(predicted), undefined);
  assert.equal(settled(rewritten), undefined);
  const unusable = runners({ ...focusedReport, trials: [threshold] }, { ...session, extras: [{ extra: 0, status: 'unsupported' }] });
  await analyzeOperators('.', ['a.ts'], { ...options, mutators: undefined }, unusable);
  assert.equal(unusable.calls.find(call => call[0] === 'complete')[1](threshold), undefined);
});
