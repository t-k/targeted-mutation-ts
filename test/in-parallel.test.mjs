import assert from 'node:assert/strict';
import test from 'node:test';
import { inParallel } from '../src/in-parallel.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('results keep the order of the items whatever order the tasks finish in', async () => {
  const results = await inParallel([30, 5, 20, 1], 4, async (ms, index) => { await pause(ms); return `${index}:${ms}`; });
  assert.deepEqual(results, ['0:30', '1:5', '2:20', '3:1']);
  assert.deepEqual(await inParallel([], 3, async () => 1), []);
});

for (const limit of [1, 2, 3, 10]) {
  test(`at most ${limit} tasks run at once and every item runs once`, async () => {
    let running = 0;
    let most = 0;
    const seen = [];
    await inParallel([1, 2, 3, 4, 5, 6, 7], limit, async item => {
      most = Math.max(most, ++running);
      await pause(3);
      seen.push(item);
      running--;
    });
    assert.equal(most, Math.min(limit, 7));
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  });
}

test('a limit below one still runs the tasks one by one', async () => {
  assert.deepEqual(await inParallel([1, 2], 0, async item => item * 2), [2, 4]);
});

test('the first failure is rethrown, started tasks settle and no further task starts', async () => {
  const started = [];
  const finished = [];
  await assert.rejects(inParallel([1, 2, 3, 4, 5], 2, async item => {
    started.push(item);
    await pause(item === 1 ? 1 : 10);
    if (item === 1) throw new Error('first');
    if (item === 2) throw new Error('second');
    finished.push(item);
  }), /first/);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(finished, []);
});
