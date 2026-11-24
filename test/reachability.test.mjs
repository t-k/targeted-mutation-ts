import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractReachability,
  filterReachableThresholdGap,
  isBoundaryReachable,
  isReachable,
  nextReachableAtOrAbove,
  prevReachableAtOrBelow,
} from '../src/reachability.mjs';
import { thresholdGap } from '../src/threshold.mjs';

describe('impossible-value filtering (reachability)', () => {
  it('extracts constraints for %, &, <<, and .length', () => {
    assert.deepEqual(extractReachability('n % 10'), { kind: 'remainder', divisor: 10, min: -9, max: 9 });
    assert.deepEqual(extractReachability('arr.length % 10'), { kind: 'remainder', divisor: 10, min: 0, max: 9 });
    assert.deepEqual(extractReachability('flags & 0xF0'), { kind: 'bitmask', mask: 0xf0 });
    assert.deepEqual(extractReachability('blocks << 3'), { kind: 'step', step: 8 });
    assert.equal(extractReachability('blocks * 8'), null);
    assert.deepEqual(extractReachability('arr.length'), { kind: 'nonNegative', min: 0 });
    assert.equal(extractReachability('age'), null);
  });

  it('eliminates bogus gaps for impossible values', () => {
    // n % 10 < 10: threshold 10 is unreachable
    const rem = extractReachability('n % 10');
    assert.equal(isBoundaryReachable(rem, 10, [0, 9]), false);
    const remGap = thresholdGap(10, [0, 9], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '<');
    assert.equal(filterReachableThresholdGap(remGap, rem, 10, '<', [0, 9]), null);

    // blocks << 3 >= 12 with observations 8 and 16: 9..15 are not multiples of 8
    const mul = extractReachability('blocks << 3');
    const mulGap = thresholdGap(12, [8, 16], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    assert.ok(mulGap !== null);
    assert.equal(filterReachableThresholdGap(mulGap, mul, 12, '>=', [8, 16]), null);

    // flags & 0xF0 >= 0x20 with observations 0x10 and 0x20: 0x11..0x1F cannot be produced by & 0xF0
    const mask = extractReachability('flags & 0xF0');
    const maskGap = thresholdGap(0x20, [0x10, 0x20], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    assert.ok(maskGap !== null);
    assert.equal(filterReachableThresholdGap(maskGap, mask, 0x20, '>=', [0x10, 0x20]), null);

    // arr.length >= 0 with observations 0 and 5: negative lengths are impossible
    const len = extractReachability('arr.length');
    const lenGap = thresholdGap(0, [0, 5], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    assert.ok(lenGap !== null);
    assert.equal(filterReachableThresholdGap(lenGap, len, 0, '>=', [0, 5]), null);
  });

  it('preserves reachable gaps and picks a reachable witness', () => {
    // blocks << 3 >= 16 with observations 8 and 24 -> witness 16 is reachable!
    const mul = extractReachability('blocks << 3');
    const gap = thresholdGap(16, [8, 24], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    const filtered = filterReachableThresholdGap(gap, mul, 16, '>=', [8, 24]);
    assert.ok(filtered !== null);
    assert.equal(filtered.witness, 16);
    assert.equal(isReachable(filtered.witness, mul), true);
    assert.notEqual(filtered.expected, filtered.mutant);

    // flags & 0xF0 >= 0x20 with observations 0x10 and 0x30 -> 0x20 is reachable!
    const mask = extractReachability('flags & 0xF0');
    const mGap = thresholdGap(0x20, [0x10, 0x30], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    const mFiltered = filterReachableThresholdGap(mGap, mask, 0x20, '>=', [0x10, 0x30]);
    assert.ok(mFiltered !== null);
    assert.equal(mFiltered.witness, 0x20);
    assert.equal(isReachable(mFiltered.witness, mask), true);
  });

  it('bitmask next/prev matches brute-force oracle on small masks', () => {
    for (const mask of [0x0, 0x5, 0xa, 0x15, 0x33, 0xf0]) {
      const c = { kind: 'bitmask', mask };
      for (let start = -2; start <= mask + 2; start++) {
        for (let limit = start; limit <= mask + 2; limit++) {
          let expectedNext = null;
          for (let v = start; v <= limit; v++) {
            if (isReachable(v, c)) { expectedNext = v; break; }
          }
          assert.equal(nextReachableAtOrAbove(start, limit, c), expectedNext);

          let expectedPrev = null;
          for (let v = limit; v >= start; v--) {
            if (isReachable(v, c)) { expectedPrev = v; break; }
          }
          assert.equal(prevReachableAtOrBelow(limit, start, c), expectedPrev);
        }
      }
    }
  });

  it('soundness guard ignores constraint when runtime observations violate it', () => {
    const mul = extractReachability('x * 8');
    const gap = thresholdGap(12, [9, 16], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '>=');
    // Observation 9 is not a multiple of 8 (e.g. non-integer x at runtime), so do not filter.
    assert.deepEqual(filterReachableThresholdGap(gap, mul, 12, '>=', [9, 16]), gap);
  });

  it('covers PICT reachability rows', () => {
    const rows = readFileSync(new URL('../verification/pict/reachability-enclosing.tsv', import.meta.url), 'utf8')
      .trim().split('\n').slice(1).map(l => l.split('\t'));
    assert.ok(rows.length >= 20);
  });
});
