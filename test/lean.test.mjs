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

const decide = (input, ...args) => spawnSync('build/tmt-decide', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
const gapRequest = { threshold: 18, min: 0, max: 100, observations: [10, 20] };
const gapAnswer = { interval: [11, 20], alternate: 17, witness: 17, expected: false, mutant: true };

test('the request reader accepts JSON as JavaScript writes it', () => {
  const spaced = decide(JSON.stringify([gapRequest, { ...gapRequest, observations: [] }], null, '\t') + '\r\n', 'thresholds');
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.deepEqual(JSON.parse(spaced.stdout), [gapAnswer, null]);
  const text = 'é "quoted" \\ / \b\f\n\r\t \u0001 😀';
  const escaped = { candidate: text, traceCandidate: text, complete: true, deterministic: true, original: '>=', replacement: '>', observations: [[20, 18]] };
  const ascii = JSON.stringify([escaped, { ...escaped, traceCandidate: text + '!' }])
    .replace(/[\u0080-\uffff]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0'));
  for (const input of [JSON.stringify([escaped, { ...escaped, traceCandidate: text + '!' }]), ascii]) {
    const run = decide(input);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [true, false]);
  }
  assert.deepEqual(JSON.parse(decide('[]').stdout), []);
  assert.deepEqual(JSON.parse(decide(' [ ] ', 'thresholds').stdout), []);
});

test('the request reader treats non-integer numbers and wrong shapes as undecidable entries', () => {
  const entries = [
    { ...gapRequest, threshold: 18.5 }, { ...gapRequest, threshold: '18' }, { ...gapRequest, min: null },
    { ...gapRequest, observations: [10, 20.25] }, { ...gapRequest, observations: { 0: 10 } }, { threshold: 18 },
    [gapRequest], 'text', 18, null, true,
    { ...gapRequest, max: Number.MAX_SAFE_INTEGER + 1 }, { ...gapRequest, max: 1e21 },
  ];
  const run = decide(JSON.stringify([gapRequest, ...entries, gapRequest]), 'thresholds');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [gapAnswer, ...entries.map(() => null), gapAnswer]);
  // JavaScript writes every safe integer as plain digits, so other spellings are not integers here.
  const spelled = decide('[{"threshold":1.8e1,"min":0,"max":100,"observations":[10,20]},{"threshold":18,"min":0,"max":1E2,"observations":[10,20]}]', 'thresholds');
  assert.deepEqual(JSON.parse(spelled.stdout), [null, null]);
});

test('an unpaired surrogate escape fails the batch instead of matching another identifier', () => {
  const request = { candidate: 'PLACEHOLDER', traceCandidate: 'x\u0000', complete: true, deterministic: true, original: '>=', replacement: '>', observations: [[20, 18]] };
  for (const escape of ['\\uD800', '\\uDC00', '\\uD800\\u0041', '\\uDBFF\\uD800']) {
    const run = decide(JSON.stringify([request]).replace('PLACEHOLDER', 'x' + escape));
    assert.equal(run.status, 1, escape);
    assert.equal(run.stdout, '');
  }
  const paired = decide(JSON.stringify([{ ...request, candidate: 'x😀', traceCandidate: 'x😀' }]).replaceAll('😀', '\\ud83d\\ude00'));
  assert.deepEqual(JSON.parse(paired.stdout), [true]);
});

test('malformed input fails the whole batch so that every trial is run', () => {
  const body = JSON.stringify(gapRequest);
  for (const input of ['', '[', '[]]', '[] x', 'null', '{"a":1}', '[1,]', `[${body},]`, '[{"a":1,}]', '[01]', '[1.]', '[1e]', '[-]', '[+1]',
    '["\\x"]', '["\\u12"]', '["open]', '["a\nb"]', '[tru]', '[nul]', '[{"a" 1}]', '[{a:1}]', `[${body} ${body}]`,
    '[{"threshold":18,"threshold":19,"min":0,"max":100,"observations":[10,20]}]']) {
    const run = decide(input, 'thresholds');
    assert.equal(run.status, 1, JSON.stringify(input));
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.trim().length > 0);
  }
});

test('a large batch is read in one pass', () => {
  const observations = Array.from({ length: 20_000 }, (_, index) => index % 2 ? 4_000 + index : -index);
  const requests = Array.from({ length: 20 }, () => ({ threshold: 4_000, min: -1_000_000, max: 1_000_000, observations }));
  const input = JSON.stringify(requests);
  assert.ok(input.length > 2_000_000);
  const started = performance.now();
  const run = decide(input, 'thresholds');
  assert.equal(run.status, 0, run.stderr);
  const answers = JSON.parse(run.stdout);
  assert.equal(answers.length, 20);
  assert.deepEqual(answers[0], { interval: [1, 4001], alternate: 3999, witness: 3999, expected: false, mutant: true });
  assert.ok(performance.now() - started < 30_000);
});

test('the decision executable links no Lean library beyond the runtime', () => {
  assert.ok(readFileSync('build/tmt-decide').length < 16 * 1024 * 1024);
  assert.doesNotMatch(readFileSync('proof/lean/Main.lean', 'utf8'), /^import /m);
});
