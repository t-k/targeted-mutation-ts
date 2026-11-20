import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tightenComparison } from '../src/displacement.mjs';

const matrix = readFileSync(new URL('../verification/pict/strict-comparison.tsv', import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(line => line.trim().split('\t'));

for (const [kind, scenario, flag] of matrix) {
  test(`strict threshold matrix: ${kind} ${scenario} ${flag}`, () => {
    const operator = { Less: '<', Greater: '>', Inclusive: '>=' }[kind];
    const source = Buffer.from(`left() ${operator} right()`);
    const site = { operator, right: [source.indexOf('right'), source.length] };
    const boundary = operator === '<' ? 3 : 5;
    const row = { operands: [scenario === 'Boundary' ? boundary : 2, 4] };
    const observation = {
      rows: scenario === 'Opaque' ? [row, { operands: null }] : [row],
      complete: scenario !== 'Opaque',
    };
    const candidate = tightenComparison(source, site, observation, flag === 'Extended');
    if (flag === 'Default' || scenario === 'Opaque' || operator === '>=') {
      assert.equal(candidate, null);
      return;
    }
    assert.deepEqual(candidate.edit, site.right);
    assert.equal(candidate.adjustment, operator === '<' ? -1 : 1);
    let sequence = [];
    const mutated = Function('left', 'right', `return left() ${operator} ${candidate.replacement}`);
    assert.equal(mutated(() => { sequence.push('left'); return boundary; }, () => { sequence.push('right'); return 4; }), false);
    assert.deepEqual(sequence, ['left', 'right']);
  });
}

test('declines a shift that would leave the safe-integer range', () => {
  for (const [operator, rhs] of [['<', Number.MIN_SAFE_INTEGER], ['>', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(tightenComparison(Buffer.from('rhs'), { operator, right: [0, 3] },
      { complete: true, rows: [{ operands: [0, rhs] }] }, true), null);
  }
});
