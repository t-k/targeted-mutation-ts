import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSource, discoverWitnessRules } from '../src/witness-rules.mjs';
import { fixtureCalls, witnessProposals } from '../src/witness-fixtures.mjs';
import { confirmsContract } from '../src/witness-contracts.mjs';
import { isExpectedFailure } from '../src/witness-analysis.mjs';

const matrix = name => readFileSync(new URL(`../verification/pict/${name}.tsv`, import.meta.url), 'utf8')
  .trim().split('\n').slice(1).map(row => row.trim().split('\t'));

const model = {
  Compare: {
    Argument: ['(a: number, b: number, limit: number) => a < limit', ['1, 1, 4', '4, 4, 4', '8, 8, 4'], [true, false, false]],
    Field: ['(x: { a: number; b: number; limit: number }) => x.a < x.limit',
      ['{a:1,b:1,limit:4}', '{a:4,b:4,limit:4}', '{a:8,b:8,limit:4}'], [true, false, false]],
  },
  Position: { Array: ['(xs: number[], key: number) => xs.indexOf(key)', ['[5,6],5', '[5,],5', '[6,7],5'], [0, 0, -1]] },
  Bitset: { Argument: ['(flags: number, mask: number) => (flags & mask) !== 0', ['1,1', '3,3', '0,1'], [true, true, false]] },
  Sum: { Array: ['(xs: number[], n: number) => xs.slice(0,n).reduce((sum,x) => sum + x,0)',
    ['[1,2,0],2', '[0],0', '[1,2],2'], [3, 0, 3]] },
};

for (const [rule, seed, shape] of matrix('witness-search')) {
  test(`witness search matrix: ${rule} ${seed} ${shape}`, () => {
    const [body, inputs, assertions] = model[rule][shape];
    const index = ['Inside', 'Boundary', 'Outside'].indexOf(seed);
    const functionTree = parseSource('source.ts', 'export const target = ' + body);
    const testTree = parseSource('input.test.ts', `
import { expect, it } from 'vitest';
import { target as alias } from './source';
it('checked example', () => expect(alias(${inputs[index]})).toBe(${assertions[index]}));
`);
    const [candidate] = discoverWitnessRules(functionTree);
    assert.ok(candidate);
    const seeds = fixtureCalls(testTree, 'input.test.ts', candidate, 'source.ts');
    assert.equal(seeds[0].bindingName, 'alias');
    const [proposal] = witnessProposals(candidate, seeds);
    if (seed === 'Outside' && rule !== 'Compare') assert.equal(proposal, undefined);
    else {
      assert.ok(proposal);
      assert.notEqual(proposal.mutant, proposal.original);
      assert.equal(proposal.original, assertions[index]);
      assert.equal(proposal.rewrite === null, rule === 'Position' && seed === 'Boundary');
    }
  });
}

for (const [edits, full, witness] of matrix('witness-contract')) {
  test(`contract witness matrix: ${edits} ${full} ${witness}`, () => {
    const isConfirmed = witness === 'Confirmed';
    const status = full === 'Survived' ? 'survived' : 'unstable';
    const singletons = edits === 'Pair' ? [{ status: 'killed', seedFailed: true }, { status: 'killed', seedFailed: true }] : [];
    assert.equal(confirmsContract(status, true, singletons, isConfirmed), full === 'Survived' && isConfirmed);
    if (edits === 'Pair') assert.equal(confirmsContract(status, true, [{ status: 'killed', seedFailed: false }, singletons[1]], true), false);
  });
}

test('requires one failure from the tagged distinguishing assertion', () => {
  const target = { project: '', file: 'test.ts', id: '1', name: 'seed', status: 'passed' };
  const baseline = { status: 'passed', tests: [target] };
  const fail = assertions => ({ status: 'failed', tests: [{ ...target, status: 'failed', assertions, failures: assertions.map(error => error.message) }] });
  const marker = { actual: '1', expected: '0', message: 'marker: expected 1 to be 0' };
  assert.equal(isExpectedFailure(fail([marker]), baseline, target, 0, 1, 'marker'), true);
  assert.equal(isExpectedFailure(fail([{ ...marker, message: 'expected 1 to be 0' }]), baseline, target, 0, 1, 'marker'), false);
  assert.equal(isExpectedFailure(fail([marker, marker]), baseline, target, 0, 1, 'marker'), false);
});

test('one literal change crosses the threshold in a bounded integer grid', () => {
  const [candidate] = discoverWitnessRules(parseSource('source.ts',
    'export const target = (a: number, b: number, limit: number) => a < limit'));
  for (let a = -8; a <= 8; a++) {
    for (let limit = -8; limit <= 8; limit++) {
      const proposals = candidate.propose([a, a, limit]);
      assert.ok(proposals.length > 0);
      for (const { path, next, original, mutant } of proposals) {
        assert.deepEqual(path, [1]);
        assert.equal(original, a < limit);
        assert.equal(mutant, next < limit);
        assert.notEqual(original, mutant);
      }
    }
  }
});
