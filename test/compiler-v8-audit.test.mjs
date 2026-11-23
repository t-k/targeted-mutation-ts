import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeValidation } from '../scripts/audit-compiler-v8.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-v8-audit.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const cases = [{ file: 'before.ts' }, { file: 'after.tsx' }];

for (const row of rows) {
  const [rawPhase, verdict, fixture, certification, guard] = row.split('\t');
  test('compiler validation audit ' + row.replaceAll('\t', ' '), () => {
    const phase = rawPhase.toLowerCase();
    const reason = verdict === 'Accept' ? 'accepted' : 'syntax';
    const prefix = 'TMT_V8_CASE\t0\n';
    const prelude = fixture === 'Initial' ? prefix : prefix + 'TMT_V8_AUDIT\tts\taccepted\t-1\nTMT_V8_CASE\t1\n';
    const scan = guard === 'Unreported' ? '' : `TMT_V8_GUARD\t${phase}\t${Number(guard === 'Accepts')}\n`;
    const decision = certification === 'Unreported' ? '' :
      scan + `TMT_V8_CERTIFIED\t${phase}\t${Number(certification === 'Certified')}\n`;
    const report = summarizeValidation(prelude + decision + `TMT_V8_AUDIT\t${phase}\t${reason}\t15\n`, cases,
      { decisions: true });
    assert.equal(report.checks[phase][reason], phase === 'ts' && fixture === 'Subsequent' && reason === 'accepted' ? 2 : 1);
    const file = cases[Number(fixture === 'Subsequent')].file;
    const rejection = { file, phase, reason, outputOffset: 15 };
    assert.deepEqual(report.rejections, verdict === 'Accept' ? [] : [rejection]);
    const certified = certification === 'Certified';
    assert.deepEqual(report.certified, certified ? { [phase]: 1 } : {});
    assert.deepEqual(report.certifiedRejections, certified && verdict === 'Reject' ? [rejection] : []);
    assert.deepEqual(report.decisions.at(-1), { file, phase, certified, reason });
    // The retired guard only objects. A published projection it objects to needs a reference comparison.
    assert.deepEqual(report.guardObjections, guard === 'Objects' && certified ? [{ file, phase }] : []);
  });
}

test('compiler validation audit rejects events without a case marker', () => {
  assert.throws(() => summarizeValidation('TMT_V8_AUDIT\tts\tsyntax\n', cases));
});

test('a certification decision applies only to the next verdict of the same phase', () => {
  const trace = 'TMT_V8_CASE\t0\nTMT_V8_CERTIFIED\tts\t1\nTMT_V8_AUDIT\tts\taccepted\t-1\n' +
    'TMT_V8_AUDIT\tts\tsyntax\t3\n';
  const report = summarizeValidation(trace, cases);
  assert.deepEqual(report.certified, { ts: 1 });
  assert.deepEqual(report.certifiedRejections, []);
  assert.throws(() => summarizeValidation('TMT_V8_CASE\t0\nTMT_V8_CERTIFIED\tts\t1\nTMT_V8_AUDIT\ttsx\taccepted\t-1\n', cases));
  assert.throws(() => summarizeValidation('TMT_V8_CASE\t0\nTMT_V8_CERTIFIED\tts\t2\nTMT_V8_AUDIT\tts\taccepted\t-1\n', cases));
  assert.throws(() => summarizeValidation('TMT_V8_CASE\t0\nTMT_V8_CERTIFIED\tts\t1\nTMT_V8_CASE\t1\n', cases));
});
