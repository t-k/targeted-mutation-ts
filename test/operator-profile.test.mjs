import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOperators } from '../src/operator-analysis.mjs';

const location = (file, start) => ({ file, line: 1, column: start + 1, start, end: start + 2 });
const comparison = { site: 'c', location: location('a.ts', 20), rule: 'comparison-boundary/v1', operator: '>=', replacement: '>', status: 'survived' };
const focusedReport = { schemaVersion: 1, runner: 'vitest', extraction: [{ file: 'a.ts', path: 'fast' }], mutants: [comparison],
  diagnostics: [{ kind: 'INPUT GAP', site: 'c' }], evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };
const swap = { id: 's1', mutatorName: 'equality-negation/v1', location: location('a.ts', 5), edit: [5, 8], original: '===', replacement: '!==',
  status: 'killed', evidence: 'reexecuted', tests: [{ id: 't', name: 'x', file: 'a.test.ts', project: '' }] };
const sessionReport = { schemaVersion: 1, runner: 'vitest', mutators: 'operators', extraction: [], diagnostics: [],
  mutants: [{ ...swap, id: 's2', location: location('a.ts', 40), status: 'unreached', evidence: 'coverage', tests: undefined }, swap],
  evaluation: 'evaluated', baseline: { status: 'passed', tests: 2 } };

function runners(focused, session) {
  const calls = [];
  return { calls,
    analyze: (project, files, options) => { calls.push(['analyze', options.mutators]); return typeof focused === 'function' ? focused(options) : focused; },
    analyzeConventional: async (project, files, options) => { calls.push(['session', options]); return session; } };
}
const options = { mutators: 'operators', lines: ['a.ts:1'], test: ['a.test.ts'], audit: true, spec: 'spec.json', dialect: 'ts', 'copy-exclude': ['x'] };

test('Vitest merges focused comparison results with operator swaps from one session', async () => {
  const run = runners(focusedReport, sessionReport);
  const report = await analyzeOperators('.', ['a.ts'], options, run);
  assert.deepEqual(run.calls[0], ['analyze', undefined]);
  assert.deepEqual(run.calls[1], ['session', { mutators: 'operators', lines: ['a.ts:1'], since: undefined, config: undefined,
    test: ['a.test.ts'], 'copy-exclude': ['x'], dialect: 'ts' }]);
  assert.equal(run.calls.length, 2);
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

test('a failed baseline or an unparsed file is reported without starting the session', async () => {
  for (const failed of [{ ...focusedReport, evaluation: 'baseline_error', baseline: { status: 'failed' } },
    { ...focusedReport, evaluation: 'no_sites', extraction: [{ file: 'a.ts', path: 'diagnostic' }] }]) {
    const run = runners(failed, sessionReport);
    const report = await analyzeOperators('.', [], options, run);
    assert.deepEqual(run.calls.map(call => call[0]), ['analyze']);
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
  assert.deepEqual(unsupported.calls.map(call => call[0] === 'analyze' ? call[1] : 'session'), [undefined, 'session', 'operators']);
  assert.equal(fallback.operatorExecution, 'source-rewrite');
});
