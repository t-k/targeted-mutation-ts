import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cheapestFirst, openReasons, sampleSettled, indexCoverage, assessTrial, planInThread, settleInThread, sharePlans, unanswered, withoutMutations } from '../src/standard-plan.mjs';

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
    const trial = { records: [{ hits: result === 'Timeout' ? 301 : result === 'Error' ? 0 : 1 }], snapshot: {
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
  // `foreign` counts tests the baseline did not run for this entry, and `missing` the ones no longer registered.
  for (const change of [{ hits: 0 }, { errors: ['afterAll failed'] }, { passed: 1 }, { hits: 0, failed: ['t1'], passed: 0 },
    { foreign: 1 }, { foreign: 1, failed: ['t1'], passed: 1 }, { missing: 1, failed: ['t1'], passed: 0 }]) {
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
  const timing = { tests: { a1: 5, a2: 7, b1: 40 }, collection: { '["","/w/a.test.ts"]': 100, '["","/w/b.test.ts"]': 10 } };
  const plans = planInThread(records, tests, pending, '/w', timing);
  // Without timing every entry costs nothing and keeps its place.
  assert.ok(Object.values(planInThread(records, tests, pending, '/w')).flat().every(plan => plan.cost === 0));
  assert.deepEqual(plans, {
    '["","/w/a.test.ts"]': [
      { id: 'm', hits: 3, hitLimit: 700, static: false, cost: 112, tests: ['a1', 'a2'] },
      // Active while the file loads, so all its tests run.
      { id: 's', hits: 2, hitLimit: 400, static: true, cost: 112, tests: ['a1', 'a2'] },
    ],
    '["","/w/b.test.ts"]': [
      { id: 'm', hits: 4, hitLimit: 700, static: false, cost: 50, tests: ['b1'] },
      // Reached only inside a test here, although another test file reaches it while loading.
      { id: 's', hits: 2, hitLimit: 400, static: false, cost: 50, tests: ['b1'] },
    ],
  });
  // Coverage that does not come as one record per test file cannot be split.
  assert.equal(planInThread([{ modules: [['', '/w/a.test.ts'], ['', '/w/b.test.ts']], coverage: {} }], tests, pending, '/w'), null);
  assert.equal(planInThread([records[0], records[0]], tests, pending, '/w'), null);
});

test('shares cut every test file across the lanes and keep each planned entry once', () => {
  const plans = { a: Array.from({ length: 7 }, (_, id) => ({ id })), b: [{ id: 7 }, { id: 8 }], c: [{ id: 9 }] };
  for (const count of [1, 2, 3, 4, 10, 40]) {
    const shares = sharePlans(plans, count);
    assert.equal(shares.length, Math.min(count, 7));
    const seen = shares.flatMap(share => Object.entries(share).flatMap(([module, list]) => list.map(plan => `${module}:${plan.id}`)));
    assert.deepEqual(seen.sort(), ['a:0', 'a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'b:7', 'b:8', 'c:9']);
    // The longest file is spread evenly; a file with a single entry stays in the first lane.
    const perLane = shares.map(share => share.a?.length ?? 0);
    assert.ok(Math.max(...perLane) - Math.min(...perLane) <= 1, JSON.stringify(perLane));
    assert.deepEqual(shares[0].c, [{ id: 9 }]);
  }
  assert.deepEqual(sharePlans({}, 4), []);
});

test('in-worker settling at its edges: hit limit, unknown killers, mixed timeouts and projects', () => {
  const entry = { id: 'm', hits: 1, hitLimit: 100, static: false, total: 1, tests: ['t1'] };
  const event = { module: 'a', id: 'm', expected: 1, passed: 0, failed: ['t1'], errors: [], timeout: false, unhandled: 0, hits: 100 };
  // Exactly the hit limit is still an ordinary run.
  assert.equal(settleInThread({ a: [entry] }, [event], names).get('m').status, 'killed');
  assert.equal(settleInThread({ a: [entry] }, [{ ...event, hits: 101 }], names).get('m').status, 'timeout');
  // A failing test the baseline did not list is left out of the killers.
  assert.deepEqual(settleInThread({ a: [entry] }, [{ ...event, failed: ['t1', 'unlisted'] }], names).get('m').tests.map(killer => killer.id), ['t1']);
  // One file at the hit limit and another at the test timeout: the test timeout is the reason given.
  const mixed = settleInThread({ a: [entry], b: [entry] },
    [{ ...event, hits: 101 }, { ...event, module: 'b', timeout: true, hits: 1 }], names);
  assert.deepEqual(mixed.get('m'), { status: 'timeout', statusReason: 'Vitest test timeout' });
  // Two projects run the same test file: each keeps its own tests.
  const tests = new Map([['p1', { id: 'p1', project: 'node', file: 'a.test.ts' }], ['p2', { id: 'p2', project: 'edge', file: 'a.test.ts' }]]);
  const records = [
    { modules: [['node', '/w/a.test.ts']], coverage: { static: {}, perTest: { p1: { m: 1 } } } },
    { modules: [['edge', '/w/a.test.ts']], coverage: { static: {}, perTest: { p2: { m: 1 } } } },
  ];
  const plans = planInThread(records, tests, [{ mutant: { id: 'm' }, plan: indexCoverage(records, tests)('m') }], '/w');
  assert.deepEqual(Object.values(plans).map(([plan]) => plan.tests), [['p1'], ['p2']]);
});

test('shares follow the estimated cost, and the cheapest test file takes each mutation first', () => {
  const plans = {
    slow: [{ id: 'x', cost: 90 }, { id: 'y', cost: 90 }, { id: 'only-slow', cost: 90 }],
    fast: [{ id: 'x', cost: 10 }, { id: 'y', cost: 10 }, { id: 'z', cost: 10 }],
    even: [{ id: 'z', cost: 10 }],
  };
  // Within a file the cut follows cost: one expensive entry weighs as much as the cheap ones together.
  const uneven = sharePlans({ a: [{ id: 1, cost: 300 }, { id: 2, cost: 100 }, { id: 3, cost: 100 }, { id: 4, cost: 100 }] }, 2);
  assert.deepEqual(uneven.map(share => share.a.map(plan => plan.id)), [[1], [2, 3, 4]]);
  const { first, rest } = cheapestFirst(plans);
  assert.deepEqual(first, { slow: [plans.slow[2]], fast: plans.fast });
  // On equal cost the first test file listed keeps the mutation.
  assert.deepEqual(rest, { slow: [plans.slow[0], plans.slow[1]], even: plans.even });
  assert.deepEqual(withoutMutations(rest, new Set(['x', 'z'])), { slow: [plans.slow[1]] });
  assert.deepEqual(withoutMutations(rest, new Set()), rest);
  assert.deepEqual(cheapestFirst({}), { first: {}, rest: {} });
});

test('a run hands back what it did not answer, except in test files that stopped', () => {
  const plans = { a: [{ id: 1 }, { id: 2 }, { id: 3 }], b: [{ id: 1 }, { id: 4 }], c: [{ id: 5 }] };
  const events = [
    { module: 'a', start: 1 }, { module: 'a', id: 1, failed: [], hits: 1 }, { module: 'a', start: 2 }, { module: 'a', yielded: true },
    { module: 'b', id: 1, stuckControl: true }, { module: 'c', stop: 5, reason: 'control' },
  ];
  assert.deepEqual(unanswered(plans, events), { a: [{ id: 2 }, { id: 3 }], b: [{ id: 4 }] });
  // With restarts allowed a stopped test file comes back without the mutation it stopped at, a limited number of times.
  const twice = { c: [{ id: 5 }, { id: 6 }, { id: 7 }] };
  assert.deepEqual(unanswered(twice, [{ module: 'c', stop: 5 }], 1), { c: [{ id: 6 }, { id: 7 }] });
  assert.deepEqual(unanswered(twice, [{ module: 'c', stop: 5 }, { module: 'c', stop: 6 }], 1), {});
  assert.deepEqual(unanswered(twice, [{ module: 'c', stop: 5 }, { module: 'c', stop: 6 }], 2), { c: [{ id: 7 }] });
  assert.deepEqual(unanswered(plans, []), plans);
  assert.deepEqual(unanswered({ a: [{ id: 1 }] }, [{ module: 'a', id: 1, stuck: true }]), {});
  // A control run that hung leaves its mutation for a fresh run, and no other answer replaces it.
  const entry = { id: 'm', hits: 1, hitLimit: 100, static: false, tests: ['t1'] };
  assert.equal(settleInThread({ a: [entry] }, [{ module: 'a', id: 'm', stuckControl: true }], names).has('m'), false);
});

test('each mutation left for a fresh run carries the reason, and a sample of settled ones is evenly spaced', () => {
  const entry = id => ({ id, hits: 1, hitLimit: 100, static: false, tests: ['t1'] });
  const ok = { expected: 1, passed: 1, failed: [], errors: [], timeout: false, unhandled: 0, hits: 1 };
  const plans = { a: ['ok', 'late', 'outside', 'changed', 'silent', 'hung', 'stuck', 'differs', 'after'].map(entry), b: [entry('lost')] };
  const events = [
    { module: 'a', id: 'ok', ...ok }, { module: 'a', id: 'late', ...ok, unhandled: 1 }, { module: 'a', id: 'outside', ...ok, errors: ['afterAll'] },
    { module: 'a', id: 'changed', ...ok, missing: 1 }, { module: 'a', id: 'silent', ...ok, hits: 0 }, { module: 'a', id: 'hung', stuckControl: true },
    { module: 'a', id: 'stuck', stuck: true }, { module: 'a', stop: 'differs', reason: 'control' },
  ];
  assert.deepEqual(Object.fromEntries(openReasons(plans, events)), { late: 'unhandled-error', outside: 'error-outside-tests', changed: 'tests-changed',
    silent: 'inconclusive', hung: 'control-hung', differs: 'control-differs', after: 'worker-stopped', lost: 'not-answered' });
  assert.deepEqual(sampleSettled(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3), ['a', 'c', 'e']);
  assert.deepEqual(sampleSettled(['a', 'b'], 5), ['a', 'b']);
  assert.deepEqual(sampleSettled(['a', 'b'], 0), []);
  assert.deepEqual(sampleSettled([], 3), []);
});
