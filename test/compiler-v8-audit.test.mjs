import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeValidation } from '../scripts/audit-compiler-v8.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-v8-audit.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const cases = [{ file: 'before.ts' }, { file: 'after.tsx' }];

for (const row of rows) {
  const [rawPhase, verdict, fixture] = row.split('\t');
  test('compiler validation audit ' + row.replaceAll('\t', ' '), () => {
    const phase = rawPhase.toLowerCase();
    const reason = verdict === 'Accept' ? 'accepted' : 'syntax';
    const prefix = 'TMT_V8_CASE\t0\n';
    const prelude = fixture === 'Initial' ? prefix : prefix + 'TMT_V8_AUDIT\tts\taccepted\t-1\nTMT_V8_CASE\t1\n';
    const report = summarizeValidation(prelude + `TMT_V8_AUDIT\t${phase}\t${reason}\t15\n`, cases);
    assert.equal(report.checks[phase][reason], phase === 'ts' && fixture === 'Subsequent' && reason === 'accepted' ? 2 : 1);
    assert.deepEqual(report.rejections, verdict === 'Accept' ? [] : [{
      file: cases[Number(fixture === 'Subsequent')].file, phase, reason, outputOffset: 15,
    }]);
  });
}

test('compiler validation audit rejects events without a case marker', () => {
  assert.throws(() => summarizeValidation('TMT_V8_AUDIT\tts\tsyntax\n', cases));
});
