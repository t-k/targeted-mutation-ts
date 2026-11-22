import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Lean only skips matching, complete, deterministic safe-integer observations with equal outcomes', () => {
  const rows = readFileSync(new URL('../verification/pict/m2-lean.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const requests = rows.map(row => {
    const [identity, complete, effect, deterministic] = row.split('\t');
    return {
      candidate: 'site-a', traceCandidate: identity === 'Match' ? 'site-a' : 'site-b',
      complete: complete === 'Yes', deterministic: deterministic === 'Yes',
      original: '>=', replacement: '>', observations: {
        Equal: [[20, 18]], Different: [[18, 18]], Unsafe: [[9007199254740992, 18]], Empty: [],
      }[effect],
    };
  });
  requests.push({ ...requests[0], original: 'invalid' }, { ...requests[0], complete: 'yes' });
  const thresholds = requests.map(request => ({ ...request, replacement: { geLiteral: 19 } }));
  const valid = thresholds[0];
  const invalid = [1.5, 9007199254740992, '19', null].map(geLiteral => ({ ...valid, replacement: { geLiteral } }));
  requests.push(...thresholds, ...invalid, { ...valid, original: '<' });
  const result = spawnSync('build/tmt-decide', [], { encoding: 'utf8', input: JSON.stringify(requests) });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const decisions = JSON.parse(result.stdout);
  const expected = [...rows.map(row => row === 'Match\tYes\tEqual\tYes'), false, false];
  assert.deepEqual(decisions, [...expected, ...expected, ...invalid.map(() => false), false]);
});

test('Lean accepts a true condition only for safe uniformly true observations', () => {
  const candidate = { candidate: 'strict', traceCandidate: 'strict', complete: true, deterministic: true, original: '<', replacement: 'true' };
  const requests = [
    { ...candidate, observations: [[0, 1], [1, 2]] },
    { ...candidate, observations: [[0, 1], [1, 1]] },
    { ...candidate, observations: [[0, 1]], complete: false },
  ];
  const result = spawnSync('build/tmt-decide', [], { encoding: 'utf8', input: JSON.stringify(requests) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, false, false]);
});

test('Lean boundary summaries agree exactly with full replay observations', async () => {
  const { checkReplay, runDecisionBatch } = await import('../src/lean-replay.mjs');
  const rows = readFileSync(new URL('../verification/pict/lean-replay-summary.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const requests = [];
  const summaries = [];
  const expected = [];
  for (const row of rows) {
    const [flip, pair, trace] = row.split('\t');
    const [original, replacement] = { LT: ['<', '<='], LE: ['<=', '<'], GT: ['>', '>='], GE: ['>=', '>'] }[flip];
    const observations = {
      Unequal: [[Number.MIN_SAFE_INTEGER, 1], [Number.MAX_SAFE_INTEGER, -1], [Number.MAX_SAFE_INTEGER, -1]],
      Equal: [[1, 2], [-0, 0]],
      Unsafe: [[1, 2], [Number.MAX_SAFE_INTEGER + 1, 0]],
      Empty: [],
    }[pair];
    const header = {
      candidate: 'site', traceCandidate: trace === 'Mismatched' ? 'other' : 'site',
      complete: trace !== 'Partial', deterministic: trace !== 'Nondeterministic', original, replacement,
    };
    requests.push({ ...header, observations });
    summaries.push({ ...header, boundarySummary: { count: observations.length, safeAndUnequal: pair === 'Unequal' } });
    expected.push(pair === 'Unequal' && trace === 'Ready');
  }
  const positive = summaries[0];
  assert.deepEqual(runDecisionBatch(requests), expected);
  assert.deepEqual(runDecisionBatch(summaries), expected);
  assert.deepEqual(checkReplay(requests), expected);
  assert.deepEqual(checkReplay([positive, { ...positive, observations: [[0, 1]] }]), [false, false]);
  assert.deepEqual(checkReplay([{ ...requests[0], observations: Array(1) }]), [false]);
  assert.deepEqual(runDecisionBatch([
    { ...positive, observations: [[0, 0]] },
    { ...positive, replacement: 'true' },
    { ...positive, boundarySummary: { count: -1, safeAndUnequal: true } },
    { ...positive, boundarySummary: { count: 1, safeAndUnequal: 'true' } },
  ]), [false, false, false, false]);
});
