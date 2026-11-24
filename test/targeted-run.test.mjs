import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderText } from '../src/cli-output.mjs';
import { indexAgreement } from '../src/standard-plan.mjs';
import { targetedGap } from '../src/targeted-gaps.mjs';

function analyzeProject(files, ...args) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-targeted-test-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--format', 'json', ...args],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), files['subject.ts']);
    return { ...run, report: run.stdout ? JSON.parse(run.stdout) : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const subject = `export const label = (count?: number) => count ?? 10;
export const name = (user?: { name: string }) => user ?? { name: 'anon' };
export const ready = (saving: boolean, valid: boolean) => !saving && valid;
export const kind = (status: string) => status === 'done' ? 1 : status === 'failed' ? 2 : 0;
export const missing = (value?: string | null) => value == null;
export const adult = (age: number) => age >= 18;
export const unused = (a: number, b: number) => a === b;
`;
const tests = `import { expect, it } from 'vitest';
import { adult, kind, label, missing, name, ready } from './subject';
it('labels', () => { expect(label(3)).toBe(3); expect(label()).toBe(10); });
it('names', () => { expect(name()).toEqual({ name: 'anon' }); expect(name({ name: 'a' }).name).toBe('a'); });
it('ready', () => { expect(ready(false, true)).toBe(true); ready(true, true); });
it('kind', () => { expect(kind('done')).toBe(1); expect(kind('open')).toBe(0); });
it('missing', () => { expect(missing(null)).toBe(true); expect(missing('a')).toBe(false); });
it('adult', () => { expect(adult(20)).toBe(true); expect(adult(10)).toBe(false); });
`;

test('the targeted profile names the missing input of each survivor and keeps the focused analysis', () => {
  const { status, stderr, report } = analyzeProject({ 'subject.ts': subject, 'subject.test.ts': tests });
  assert.equal(status, 0, stderr);
  assert.equal(report.evaluation, 'evaluated');
  assert.equal(report.mutators, 'targeted');
  assert.equal(report.operatorExecution, 'session');
  const verdict = (original, replacement) => report.mutants.find(mutant => mutant.original === original && mutant.replacement === replacement)?.status;
  const gap = replacement => report.diagnostics.find(entry => entry.mutations[0].replacement === replacement);

  // `??` for `||`: a number was seen and never 0, so the input is missing. For an object no input can tell them apart.
  assert.equal(verdict('count ?? 10', '(count || 10)'), 'survived');
  assert.equal(gap('(count || 10)').kind, 'INPUT GAP');
  assert.match(gap('(count || 10)').missing, /`count` is 0, '', false or NaN/);
  assert.equal(gap('(count || 10)').reachedBy, 1);
  assert.equal(verdict("user ?? { name: 'anon' }", "(user || { name: 'anon' })"), 'ignored');
  assert.equal(verdict('count ?? 10', '(count, 10)'), 'killed');

  // A test passed `saving` as true and asserted nothing: the input is there and the assertion is missing.
  assert.equal(verdict('!saving && valid', '(!saving, valid)'), 'survived');
  assert.equal(gap('(!saving, valid)').kind, 'ASSERTION GAP');
  assert.deepEqual(gap('(!saving, valid)').tests.map(entry => entry.name), ['ready']);
  assert.deepEqual(gap('(!saving, valid)').example.operands, ['false']);
  // `valid` was never false, so its value never decided.
  assert.equal(gap('(!saving && (valid, true))').kind, 'INPUT GAP');
  assert.match(gap('(!saving && (valid, true))').missing, /`!saving` is truthy and the right side is not true/);

  assert.equal(verdict("status === 'failed'", "(status, 'failed', false)"), 'survived');
  assert.match(gap("(status, 'failed', false)").missing, /`status === 'failed'` is true/);
  assert.equal(verdict("status === 'done'", "(status, 'done', false)"), 'killed');
  assert.equal(verdict('value == null', 'value === null'), 'survived');
  assert.match(gap('value === null').missing, /`value` is undefined/);
  assert.equal(verdict('value == null', 'value === undefined'), 'killed');
  assert.equal(verdict('a === b', '(a, b, true)'), 'unreached');

  // The comparison boundary and its threshold come from the focused analysis as before.
  assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-boundary/v1' && mutant.status === 'survived'));
  assert.ok(report.diagnostics.some(entry => entry.suggestedTest === 'expect(adult(18)).toBe(true)'));
  assert.ok(report.mutants.every(mutant => mutant.targeted === undefined && mutant.source === undefined));

  const text = renderText(report);
  assert.match(text, /INPUT GAP subject\.ts:1:\d+ {2}nullish-fallback\/v1\n {2}`count \?\? 10` passes every test as `\(count \|\| 10\)` \(1 test reaches it\)\n {2}add a test in which `count` is 0/);
  assert.match(text, /ASSERTION GAP subject\.ts:3:\d+ {2}ignored-operand\/v1\n.*\n {2}the edit gives another value in: subject\.test\.ts > ready \(operands false\)\n {2}add an assertion/);
});

test('a line scope, a disabling comment and a failing baseline apply to the targeted edits', () => {
  const files = { 'subject.ts': subject.replace('export const kind', '// Stryker disable next-line all: generated\nexport const kind'), 'subject.test.ts': tests };
  const scoped = analyzeProject(files, '--lines', 'subject.ts:1-1', '--lines', 'subject.ts:5-5');
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.deepEqual([...new Set(scoped.report.mutants.map(mutant => mutant.location.line))], [1, 5]);
  assert.ok(scoped.report.mutants.filter(mutant => mutant.location.line === 5).every(mutant => mutant.status === 'ignored' && mutant.statusReason === 'generated'));
  const failing = analyzeProject({ 'subject.ts': subject, 'subject.test.ts': tests.replace('toBe(3)', 'toBe(4)') });
  assert.equal(failing.status, 1);
  assert.equal(failing.report.evaluation, 'baseline_error');
});

test('observations are merged per edit over test files, and a test that differed once is not an agreeing one', () => {
  const known = new Map([['a', {}], ['b', {}], ['c', {}]]);
  const merged = indexAgreement([
    { observed: { m: { tests: { a: [2, 0], b: [1, 1] }, agree: ['1'], differ: ['0'] }, n: { tests: { '': [0, 1] } } } },
    { observed: { m: { tests: { a: [0, 1], c: [3, 0], gone: [1, 0] }, agree: ['2'], typed: true } } },
    {},
  ], known);
  assert.deepEqual([...merged.get('m').agreeing], ['c']);
  assert.deepEqual([...merged.get('m').differing].sort(), ['a', 'b']);
  assert.deepEqual([merged.get('m').outside, merged.get('m').typed, merged.get('m').agree, merged.get('m').differ], [false, true, ['1'], ['0']]);
  // Outside the passing tests only a difference counts.
  assert.equal(merged.get('n').outside, true);
  assert.equal(merged.get('n').agreeing.size, 0);
});

test('a gap is described only for a surviving targeted edit that was observed', () => {
  const mutant = { id: 'm', mutatorName: 'ignored-operand/v1', location: { file: 'a.ts', line: 1, column: 1 }, original: 'a || b', replacement: '(a, b)',
    edit: [0, 6], status: 'survived', evidence: 'reexecuted', targeted: { operator: '||', form: 'left', boolean: true, left: 'a' } };
  const seen = { agreeing: 2, differing: [], outside: false, agree: ['0', '1'] };
  assert.equal(targetedGap({ ...mutant, status: 'killed' }, seen), null);
  assert.equal(targetedGap({ ...mutant, targeted: undefined }, seen), null);
  assert.equal(targetedGap(mutant, undefined), null);
  assert.deepEqual(targetedGap(mutant, seen), { kind: 'INPUT GAP', site: 'm', location: mutant.location, rule: 'ignored-operand/v1', expression: 'a || b',
    mutations: [{ rule: 'ignored-operand/v1', edit: [0, 6], replacement: '(a, b)', evidence: 'reexecuted' }], reachedBy: 2,
    missing: 'a test in which `a` is truthy', observed: { operands: ['0', '1'] } });
  // A difference while a file loads has no test to name.
  const outside = targetedGap(mutant, { ...seen, outside: true, differ: ['1'] });
  assert.deepEqual([outside.kind, outside.tests, outside.outsideTests, outside.example], ['ASSERTION GAP', [], true, { operands: ['1'] }]);
  assert.match(renderText({ runner: 'vitest', evaluation: 'evaluated', mutants: [], diagnostics: [outside] }), /another value in: code outside the tests \(operands 1\)/);
  const missing = (targeted, original = 'x') => targetedGap({ ...mutant, original, targeted }, seen).missing;
  assert.equal(missing({ operator: '&&', form: 'left', left: 'a' }), 'a test in which `a` is falsy');
  assert.equal(missing({ operator: '??', form: 'left', left: 'a' }), 'a test in which `a` is neither null nor undefined');
  assert.equal(missing({ operator: '&&', form: 'right', boolean: true, left: 'a' }), 'a test in which `a` is truthy and the right side is falsy');
  assert.equal(missing({ operator: '||', form: 'right', boolean: true, left: 'a' }), 'a test in which `a` is falsy and the right side is truthy');
  assert.equal(missing({ operator: '||', form: 'right', boolean: false, left: 'a' }), 'a test in which `a` is falsy and the right side is not false');
  assert.equal(missing({ operator: '??', form: 'right', boolean: false, left: 'a' }), 'a test in which `a` is null or undefined and the right side is not undefined');
  assert.equal(missing({ operator: '===', form: 'true', left: 'a' }, 'a === b'), 'a test in which `a === b` is false');
  assert.equal(missing({ operator: '!=', form: 'other', left: 'a', subject: 'a', differsFor: 'null' }), 'a test in which `a` is null');
  assert.equal(missing({ operator: '||', form: 'nullish', left: 'a\n  .b' + 'c'.repeat(80) }).length, 'a test in which `` is 0, \'\', false or NaN'.length + 60);
});

test('without a session the targeted edits are plain source edits beside the comparison boundaries', async () => {
  const { collectComparisons } = await import('../src/analysis.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-targeted-test-')));
  try {
    writeFileSync(join(root, 'subject.ts'), 'export const f = (a?: number, b = 1) => (a ?? b) >= 2;\n');
    const { subjects } = collectComparisons(root, ['subject.ts'], { mutators: 'targeted' });
    assert.deepEqual(subjects[0].sites.map(site => [site.rule, (site.source?.replacement ?? site.replacement).trim(), site.unobserved === true]), [
      ['ignored-operand/v1', '(a, b)', true], ['ignored-operand/v1', '(a ?? (b, undefined))', true], ['nullish-fallback/v1', '(a || b)', true],
      ['comparison-boundary/v1', '>', false]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
