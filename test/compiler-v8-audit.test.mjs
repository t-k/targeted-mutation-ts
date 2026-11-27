import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectAuditCases, summarizeValidation } from '../scripts/audit-compiler-v8.mjs';

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

test('selectAuditCases skips unsupported V8 features and records skip reasons', () => {
  const encode = source => Buffer.from(source, 'utf8').toString('base64');
  const sample = [
    { file: 'plain.ts', source: encode('export const x: number = 1;\n') },
    { file: 'string-using.ts', source: encode('export const label = "using resources";\n') },
    { file: 'comment-using.ts', source: encode('// using resources\nexport const n = 1;\n') },
    { file: 'template-using.ts', source: encode('export const s = `using resources ${1}`;\n') },
    { file: 'accessor.ts', source: encode('export class C { accessor x = 1; }\n') },
    { file: 'using.ts', source: encode('using d = { [Symbol.dispose]() {} }; export {};\n') },
    { file: 'using-comment-gap.ts', source: encode('using/* gap */ d = { [Symbol.dispose]() {} }; export {};\n') },
    { file: 'using-unicode.ts', source: encode('using Ω = { [Symbol.dispose]() {} }; export {};\n') },
    { file: 'await-using.ts', source: encode('export async function f() { await using d = x; }\n') },
  ];
  const node24 = selectAuditCases(sample, { supportsUsing: true });
  assert.deepEqual(node24.cases.map(entry => entry.file), [
    'plain.ts',
    'string-using.ts',
    'comment-using.ts',
    'template-using.ts',
    'using.ts',
    'using-comment-gap.ts',
    'using-unicode.ts',
    'await-using.ts',
  ]);
  assert.deepEqual(node24.skipped, { total: 1, reasons: { 'v8-unsupported-accessor': 1 } });
  assert.equal(node24.cases.length + node24.skipped.total, sample.length);

  const node22 = selectAuditCases(sample, { supportsUsing: false });
  assert.deepEqual(node22.cases.map(entry => entry.file), [
    'plain.ts',
    'string-using.ts',
    'comment-using.ts',
    'template-using.ts',
  ]);
  assert.deepEqual(node22.skipped, {
    total: 5,
    reasons: { 'v8-unsupported-accessor': 1, 'v8-unsupported-using': 4 },
  });
  assert.equal(node22.cases.length + node22.skipped.total, sample.length);
});
