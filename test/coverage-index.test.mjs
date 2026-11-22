import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agreesWithCoverage, indexCoverage } from '../src/standard-plan.mjs';

function scanCoverage(id, records, tests) {
  let staticHits = 0;
  let hits = 0;
  const perTestHits = new Map();
  for (const { coverage } of records) {
    staticHits += coverage?.static?.[id] ?? 0;
    for (const [testId, mutations] of Object.entries(coverage?.perTest ?? {})) {
      if (!mutations[id]) continue;
      hits += mutations[id];
      perTestHits.set(testId, (perTestHits.get(testId) ?? 0) + mutations[id]);
    }
  }
  const covered = new Set(perTestHits.keys());
  return { hits: hits + staticHits, staticActivation: staticHits > 0 || [...covered].some(testId => !tests.has(testId)), covered, perTestHits };
}

const rows = readFileSync(new URL('../verification/pict/coverage-index.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(row => row.trim().split('\t'));

for (const [activation, inventory, recordsShape, replay] of rows) {
  test(`coverage index: ${activation} ${inventory} ${recordsShape} ${replay}`, () => {
    const id = '19';
    const runtime = activation === 'Runtime' || activation === 'Both';
    const staticHit = activation === 'Static' || activation === 'Both';
    const testId = inventory === 'Known' ? 'first-file' : 'missing-test';
    const tests = new Map([['first-file', {}], ['another-file', {}], ['neglected', {}]]);
    const records = [{ coverage: {
      static: staticHit ? { other: 4, [id]: 2 } : { other: 4 },
      perTest: { [testId]: runtime ? { other: 1, [id]: 3 } : { other: 1 }, neglected: { [id]: 0 } },
    } }];
    if (recordsShape === 'Multiple') records.push({}, { coverage: {
      static: staticHit ? { [id]: 1 } : undefined,
      perTest: {
        'another-file': runtime ? { [id]: 2, other: 1 } : { other: 1 },
        [testId]: runtime ? { [id]: 1 } : {},
      },
    } });
    const coverageFor = indexCoverage(records, tests);
    for (const mutationId of [id, 'other', 'unused']) {
      const expected = scanCoverage(mutationId, records, tests);
      const actual = coverageFor(mutationId);
      assert.deepEqual(actual, expected);
      assert.deepEqual([...actual.covered], [...expected.covered]);
      assert.deepEqual([...actual.perTestHits], [...expected.perTestHits]);
    }
    const plan = coverageFor(id);
    let observations = [...plan.perTestHits].flatMap(([coveredId, hits]) => Array.from({ length: hits }, () => [coveredId, 2, 0]));
    if (replay === 'NoRows') observations = undefined;
    if (replay === 'WrongTest') observations[0] = ['neglected', 2, 0];
    if (replay === 'WrongCount') observations.pop();
    assert.equal(agreesWithCoverage(observations, plan), replay === 'Exact' && !staticHit && inventory === 'Known');
  });
}

test('the shipped coverage lookup retains its single-ID entry point', async () => {
  const { coveredTests } = await import('../src/standard-plan.mjs');
  const records = [{ coverage: { perTest: { b: { 20: 3 }, a: { 20: 1 } }, static: { 20: 1 } } }];
  const tests = new Map([['a', {}], ['b', {}]]);
  assert.deepEqual(coveredTests(20, records, tests), scanCoverage(20, records, tests));
  assert.deepEqual([...coveredTests('20', records, tests).covered], ['b', 'a']);
});
