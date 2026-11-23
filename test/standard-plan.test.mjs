import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { indexCoverage, assessTrial, planInThread, settleInThread, sharePlans } from '../src/standard-plan.mjs';

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

const inWorkerRows = readFileSync(new URL('../verification/pict/in-worker-trials.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));
const names = new Map([['t1', { id: 't1', name: 'first', file: 'a.test.ts', project: '' }], ['t2', { id: 't2', name: 'second', file: 'b.test.ts', project: '' }]]);
const answer = (module, kind, test) => ({
  Killed: [{ module, id: 'm', expected: 1, passed: 0, failed: [test], errors: [], timeout: false, unhandled: 0, hits: 1 }],
  Survived: [{ module, id: 'm', expected: 1, passed: 1, failed: [], errors: [], timeout: false, unhandled: 0, hits: 1 }],
  Timeout: [{ module, id: 'm', expected: 1, passed: 0, failed: [test], errors: [], timeout: false, unhandled: 0, hits: 101 }],
  Stuck: [{ module, id: 'm', stuck: true }],
  Open: [{ module, id: 'm', expected: 1, passed: 1, failed: [], errors: [], timeout: false, unhandled: 1, hits: 1 }],
  Missing: [{ module, stop: 'm', reason: 'control' }],
  None: [],
}[kind]);

for (const [files, first, second] of inWorkerRows) {
  test(`in-worker verdict: ${files} ${first} ${second}`, () => {
    const entry = { id: 'm', hits: 1, hitLimit: 100, static: false, total: 1, tests: ['t'] };
    const plans = { a: [entry], ...(files === 'Two' ? { b: [entry] } : {}) };
    const settled = settleInThread(plans, [...answer('a', first, 't1'), ...answer('b', second, 't2')], names);
    const parts = [first, second].filter(part => part !== 'None');
    const expected = parts.includes('Killed') ? 'killed'
      : parts.some(part => part === 'Open' || part === 'Missing') ? undefined
        : parts.some(part => part === 'Timeout' || part === 'Stuck') ? 'timeout' : 'survived';
    assert.equal(settled.get('m')?.status, expected);
    if (expected === 'killed') {
      assert.deepEqual(settled.get('m').tests.map(killer => killer.name),
        [first === 'Killed' ? 'first' : null, second === 'Killed' ? 'second' : null].filter(Boolean));
    }
    if (parts.includes('Stuck') && expected === 'timeout') assert.equal(settled.get('m').statusReason, 'The worker stopped answering');
  });
}

test('an in-worker answer without activation, with a suite error or with a missing test is left for a fresh run', () => {
  const plans = { a: [{ id: 'm', hits: 2, hitLimit: 200, static: false, total: 2, tests: ['t1', 't2'] }] };
  const event = { module: 'a', id: 'm', expected: 2, passed: 2, failed: [], errors: [], timeout: false, unhandled: 0, hits: 2 };
  assert.equal(settleInThread(plans, [event], names).get('m').status, 'survived');
  for (const change of [{ hits: 0 }, { errors: ['afterAll failed'] }, { passed: 1 }, { hits: 0, failed: ['t1'], passed: 0 }]) {
    assert.equal(settleInThread(plans, [{ ...event, ...change }], names).has('m'), false, JSON.stringify(change));
  }
  assert.deepEqual(settleInThread(plans, [{ ...event, passed: 0, failed: ['t1'], timeout: true }], names).get('m'),
    { status: 'timeout', statusReason: 'Vitest test timeout' });
  assert.deepEqual(settleInThread(plans, [{ ...event, passed: 0, failed: ['t1'], hits: 201 }], names).get('m'),
    { status: 'timeout', statusReason: 'Mutation hit limit reached' });
});

test('the in-worker plan gives each test file its own hits, tests and activation', () => {
  const tests = new Map([
    ['a1', { id: 'a1', project: '', file: 'a.test.ts' }], ['a2', { id: 'a2', project: '', file: 'a.test.ts' }],
    ['b1', { id: 'b1', project: '', file: 'b.test.ts' }],
  ]);
  const records = [
    { modules: [['', '/w/a.test.ts']], coverage: { static: { s: 1 }, perTest: { a1: { m: 2, s: 1 }, a2: { m: 1 } } } },
    { modules: [['', '/w/b.test.ts']], coverage: { static: {}, perTest: { b1: { m: 4, s: 2 } } } },
  ];
  const pending = ['m', 's', 'n'].map(id => ({ mutant: { id }, plan: indexCoverage(records, tests)(id) }));
  const plans = planInThread(records, tests, pending, '/w');
  assert.deepEqual(plans, {
    '["","/w/a.test.ts"]': [
      { id: 'm', hits: 3, hitLimit: 700, static: false, total: 2, tests: ['a1', 'a2'] },
      { id: 's', hits: 2, hitLimit: 400, static: true, total: 2 },
    ],
    '["","/w/b.test.ts"]': [
      { id: 'm', hits: 4, hitLimit: 700, static: false, total: 1, tests: ['b1'] },
      // Reached only inside a test here, although another test file reaches it while loading.
      { id: 's', hits: 2, hitLimit: 400, static: false, total: 1, tests: ['b1'] },
    ],
  });
  // Coverage that does not come as one record per test file cannot be split.
  assert.equal(planInThread([{ modules: [['', '/w/a.test.ts'], ['', '/w/b.test.ts']], coverage: {} }], tests, pending, '/w'), null);
  assert.equal(planInThread([records[0], records[0]], tests, pending, '/w'), null);
});

test('shares keep every planned entry once and stay within one entry of each other', () => {
  const plans = { a: Array.from({ length: 7 }, (_, id) => ({ id })), b: [{ id: 7 }, { id: 8 }], c: [{ id: 9 }] };
  for (const count of [1, 2, 3, 4, 10, 40]) {
    const shares = sharePlans(plans, count);
    assert.ok(shares.length <= count);
    if (count <= 4) assert.equal(shares.length, count);
    const sizes = shares.map(share => Object.values(share).flat().length);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), 10);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= Math.ceil(10 / shares.length));
    const seen = shares.flatMap(share => Object.entries(share).flatMap(([module, list]) => list.map(plan => `${module}:${plan.id}`)));
    assert.deepEqual(seen, ['a:0', 'a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'b:7', 'b:8', 'c:9']);
  }
  assert.deepEqual(sharePlans({}, 4), []);
});
