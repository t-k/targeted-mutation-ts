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
  const result = spawnSync('build/tmt-decide', [], { encoding: 'utf8', input: JSON.stringify(requests) });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const decisions = JSON.parse(result.stdout);
  assert.deepEqual(decisions, [...rows.map(row => row === 'Match\tYes\tEqual\tYes'), false, false]);
});
