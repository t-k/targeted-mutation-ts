import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sameObservations } from '../src/trace-buffer.mjs';

const rows = readFileSync(new URL('../verification/pict/replay-observation-order.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const sample = { site: 'first', operator: '>=', operands: [0, 1], result: false };
const next = { ...sample, site: 'second', operands: [2, 1], result: true };
const loaded = { loaded: [sample.site, next.site] };
const hit = { hit: sample.site, identity: { project: 'test', file: 'entry.test.ts', id: 'case' } };
for (const row of rows) {
  const [layout, placement, difference] = row.split('\t');
  test(`Replay observation order: ${layout} ${placement} ${difference}`, () => {
    const reference = { Empty: [], Numeric: [sample, next], WithLoad: [loaded, sample, next] }[layout];
    const variants = {
      Same: reference, Changed: [...reference.slice(0, -1), { ...next, result: false }],
      Reordered: reference.toReversed(), Missing: reference.slice(1), Extra: [...reference, next],
    };
    const replay = variants[difference];
    const withCoverage = {
      None: replay, Start: [hit, ...replay], Between: [...replay.slice(0, 1), hit, ...replay.slice(1)], End: [...replay, hit],
    }[placement];
    assert.equal(sameObservations(reference, structuredClone(withCoverage)), difference === 'Same');
  });
}

test('compare exact JSON row spellings, including nulls, repetitions and property order', () => {
  assert.equal(sameObservations(null, []), false);
  assert.equal(sameObservations([], null), false);
  assert.equal(sameObservations(null, null), true);
  assert.equal(sameObservations([null, sample, sample], [null, sample, hit, sample]), true);
  assert.equal(sameObservations([null, sample, sample], [null, sample]), false);
  assert.equal(sameObservations([{ x: 'a\nb', y: 1 }], [{ y: 1, x: 'a\nb' }]), false);
  assert.equal(sameObservations([sample], [{ hit: null }, sample]), true);
  assert.equal(sameObservations([hit, sample], [sample]), true);
});
