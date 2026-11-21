import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { focusedAuditStatus } from '../src/analysis.mjs';

const rows = readFileSync(new URL('../verification/pict/focused-audit.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [source, evidence, observation] = row.split('\t');
  test(`focused audit: ${source} ${evidence} ${observation}`, () => {
    const actual = source.toLowerCase();
    const probe = evidence === 'Matches' ? actual
      : evidence === 'Contradicts' ? (actual === 'killed' ? 'survived' : 'killed') : null;
    const status = source === 'Survived' && observation !== 'Observed'
      ? (observation === 'Unloaded' ? 'unevaluated' : 'unreached') : actual;
    const expected = evidence === 'Contradicts' && source !== 'Unevaluated' ? 'mismatch'
      : evidence === 'Matches' && ['killed', 'survived'].includes(status) ? 'agreed' : 'inconclusive';
    assert.equal(focusedAuditStatus(actual, probe, false, status), expected);
  });
}

test('a stable Lean prediction independently checks a source trial', () => {
  assert.equal(focusedAuditStatus('survived', null, true, 'survived'), 'agreed');
  assert.equal(focusedAuditStatus('killed', null, true, 'survived'), 'mismatch');
  assert.equal(focusedAuditStatus('survived', null, true, 'unstable'), 'inconclusive');
});

test('failed or indeterminate audit legs cannot claim agreement or contradiction', () => {
  assert.equal(focusedAuditStatus('survived', 'timeout', false, 'survived'), 'inconclusive');
  assert.equal(focusedAuditStatus('timeout', 'killed', false, 'timeout'), 'inconclusive');
  assert.equal(focusedAuditStatus('killed', 'unevaluated', false, 'killed'), 'inconclusive');
});
