import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { indexCoverage, assessTrial } from '../src/standard-plan.mjs';

const rows = readFileSync(new URL('../verification/pict/session-plan.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));

for (const [activation, coverage, result] of rows) {
  test(`session plan: ${activation} ${coverage} ${result}`, () => {
    const tests = new Map([['baseline', { id: 'baseline' }]]);
    const id = 'mutant';
    const testId = coverage === 'Unknown' ? 'unmapped' : 'baseline';
    const records = [{ coverage: {
      static: activation === 'Static' ? { [id]: 2 } : {},
      perTest: activation === 'Runtime' ? { [testId]: { [id]: 3 } } : {},
    } }];
    const plan = indexCoverage(records, tests)(id);
    assert.equal(plan.staticActivation, activation === 'Static' || activation === 'Runtime' && coverage === 'Unknown');
    assert.equal(plan.hits, { Static: 2, Runtime: 3, Missing: 0 }[activation]);
    if (activation === 'Missing') return;
    const trial = { records: [{ hits: result === 'Timeout' ? 301 : 1 }], snapshot: {
      reason: result === 'Passed' ? 'passed' : 'failed',
      errors: result === 'Error' ? ['bad environment'] : [],
      tests: [{ id: 'baseline', status: result === 'Failed' ? 'failed' : 'passed' }],
    } };
    const assessed = assessTrial(trial, tests, plan.hits * 100);
    assert.equal(assessed.status, { Passed: 'survived', Failed: 'killed', Timeout: 'timeout', Error: 'error' }[result]);
  });
}

test('a replay with missing expected tests or missing activation is unstable', () => {
  const snapshot = { reason: 'passed', errors: [], tests: [{ id: 'test', status: 'passed' }] };
  assert.equal(assessTrial({ snapshot, records: [{ hits: 1 }] }, new Map([['another', {}]]), 100).status, 'unstable');
  assert.equal(assessTrial({ snapshot, records: [] }, new Map([['test', {}]]), 100).status, 'unstable');
});
