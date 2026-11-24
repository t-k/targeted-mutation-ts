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
  assert.match(gap('(count || 10)').missing, /`count` is 0, 0n, '', false or NaN and not the right side's value/);
  assert.equal(gap('(count || 10)').reachedBy, 1);
  assert.equal(verdict("user ?? { name: 'anon' }", "(user || { name: 'anon' })"), 'ignored');
  // An edit that was not tried has no evidence of a run.
  assert.equal(report.mutants.find(mutant => mutant.status === 'ignored').evidence, undefined);
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
  assert.match(text, /INPUT GAP subject\.ts:1:\d+ {2}nullish-fallback\/v1\n {2}`count \?\? 10` passes every test as `\(count \|\| 10\)` \(1 test reaches it\)\n {2}add a test in which `count` is 0, 0n/);
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
  // A test in which the recording could not tell is neither, unless another file saw it differ.
  const unsure = indexAgreement([{ observed: { m: { tests: { a: [1, 0, 1], b: [0, 0, 2], c: [3, 0, 0], '': [0, 0, 1] }, unsure: ['array of 2'] } } },
    { observed: { m: { tests: { b: [0, 1, 0], c: [0, 0, 1] } } } }], known).get('m');
  // Outside the tests, not knowing is not a difference.
  assert.deepEqual([[...unsure.agreeing], [...unsure.unsure].sort(), [...unsure.differing], unsure.outside, unsure.outsideUnsure, unsure.unknown],
    [[], ['a', 'c'], ['b'], false, true, ['array of 2']]);
  const loaded = targetedGap({ id: 'm', mutatorName: 'sequence-end/v1', location: {}, original: 'a.find(f)', replacement: 'a.findLast(f)', edit: [0, 1], status: 'survived',
    targeted: { operator: 'find', form: 'findLast', left: 'a' } }, { agreeing: 0, differing: [], unsure: [], outside: false, outsideUnsure: true, unknown: ['array of 2', 'function'] });
  assert.deepEqual([loaded.kind, loaded.uncertain, loaded.outsideTests, loaded.tests], ['INPUT GAP', true, true, []]);
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
  assert.equal(missing({ operator: '===', form: 'loose', left: 'null', subject: 'b', differsFor: 'undefined' }), 'a test in which `b` is undefined');
  assert.equal(missing({ operator: '==', form: 'strict', left: 'a', subject: 'a', differsFor: 'undefined' }), 'a test in which `a` is undefined');
  // Text is shown on one line and cut at sixty characters.
  assert.equal(missing({ operator: '&&', form: 'left', left: 'a\n\t  .b' }), 'a test in which `a .b` is falsy');
  assert.equal(missing({ operator: '&&', form: 'left', left: 'x'.repeat(60) }), `a test in which \`${'x'.repeat(60)}\` is falsy`);
  assert.equal(missing({ operator: '&&', form: 'left', left: 'x'.repeat(61) }), `a test in which \`${'x'.repeat(57)}...\` is falsy`);
  assert.equal(missing({ operator: '||', form: 'nullish', left: 'a\n  .b' + 'c'.repeat(80) }).length, 'a test in which `` is 0, 0n, \'\', false or NaN'.length + 60);
  assert.match(missing({ operator: '??', form: 'or', left: 'a', pureRight: true }), /NaN and not the right side's value$/);
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

test('arithmetic, Math and sequence ends: the tests are told which numbers and lists they lack', () => {
  const values = `export const total = (price: number, fee: number, factor: number) => (price + fee) * factor;
export const clamp = (n: number, low: number) => Math.max(n, low);
export const pages = (items: number, size: number) => Math.floor(items / size);
export const newest = (list: number[]) => list[list.length - 1];
export const firstOdd = (list: number[]) => list.find(n => n % 2 === 1);
export const where = (list: string[], name: string) => list.indexOf(name);
`;
  const suite = `import { expect, it } from 'vitest';
import { clamp, firstOdd, newest, pages, total, where } from './subject';
it('total', () => { expect(total(100, 0, 1)).toBe(100); expect(total(50, 0, 1)).toBe(50); });
it('clamp', () => { expect(clamp(3, 3)).toBe(3); });
it('pages', () => { expect(pages(10, 5)).toBe(2); expect(pages(-9, 3)).toBe(-3); });
it('newest', () => { expect(newest([7])).toBe(7); });
it('firstOdd', () => { expect(firstOdd([2, 3, 4])).toBe(3); });
it('where', () => { expect(where(['a', 'b'], 'b')).toBe(1); });
`;
  const { status, stderr, report } = analyzeProject({ 'subject.ts': values, 'subject.test.ts': suite });
  assert.equal(status, 0, stderr);
  const verdict = replacement => report.mutants.find(mutant => mutant.replacement === replacement)?.status;
  const gap = replacement => report.diagnostics.find(entry => entry.mutations.some(mutation => mutation.replacement === replacement));
  // `fee` is always 0 and `factor` always 1.
  assert.deepEqual([verdict('(price - fee)'), verdict('(price * fee)')], ['survived', 'killed']);
  assert.equal(gap('(price - fee)').missing, 'a test in which `price + fee` is not `(price - fee)`');
  assert.deepEqual(gap('(price - fee)').observed.operands, ['100', '0']);
  assert.equal(verdict('((price + fee) / factor)'), 'survived');
  assert.equal(gap('Math.min(n, low)').missing, 'a test in which the two arguments of `Math.max(n, low)` differ');
  // Every quotient in the tests is whole, so no rounding is told from another; each edit says which number would.
  assert.equal(gap('Math.ceil(items / size)').missing, 'a test in which `items / size` is not a whole number (0.5)');
  assert.equal(gap('Math.round(items / size)').missing, 'a test in which `items / size` is a number that rounds up (1.5, -1.5)');
  assert.equal(gap('Math.trunc(items / size)').missing, 'a test in which `items / size` is negative and not a whole number (-0.5)');
  assert.equal(gap('list[0]').missing, 'a test in which `list` has two or more elements and the first is not the last');
  assert.equal(gap('list.lastIndexOf(name)').missing, 'a test in which `list` holds the searched value more than once');
  // The callback of a search is not run again, so the recording cannot tell whether a list with two matches was given.
  const search = gap('list.findLast(n => n % 2 === 1)');
  assert.deepEqual([search.kind, search.uncertain, search.tests.map(entry => entry.name), search.example.operands], ['INPUT GAP', true, ['firstOdd'], ['array of 3', 'function']]);
  const text = renderText(report);
  assert.match(text, /add a test in which `list` has two or more elements, or an assertion that tells them apart: the recording cannot tell whether a test has such an input/);
});

test('the missing input of the value rules', () => {
  const mutant = { id: 'm', location: { file: 'a.ts', line: 1, column: 1, start: 0, end: 9 }, edit: [0, 9], status: 'survived', evidence: 'reexecuted' };
  const seen = { agreeing: 1, differing: [], unsure: [], outside: false };
  const missing = (mutatorName, targeted, original = 'x', replacement = 'y') => targetedGap({ ...mutant, mutatorName, original, replacement, targeted }, seen).missing;
  // Each pair of roundings is told apart by its own numbers; the examples are checked against Math itself.
  const pairs = { 'floor trunc': 'negative and not a whole number (-0.5)', 'ceil trunc': 'positive and not a whole number (0.5)',
    'floor round': 'a number that rounds up (1.5, -1.5)', 'ceil round': 'a number that rounds down (1.4, -1.6)',
    'round trunc': 'a number that rounds away from zero (1.5, -1.6)', 'ceil floor': 'not a whole number (0.5)' };
  for (const [pair, sentence] of Object.entries(pairs)) {
    const [one, other] = pair.split(' ');
    assert.equal(missing('rounding-swap/v1', { operator: one, form: other, left: 'n' }), `a test in which \`n\` is ${sentence}`);
    assert.equal(missing('rounding-swap/v1', { operator: other, form: one, left: 'n' }), `a test in which \`n\` is ${sentence}`);
    for (const example of sentence.match(/-?\d+\.\d+/g).map(Number)) assert.notEqual(Math[one](example), Math[other](example), `${pair} for ${example}`);
    assert.equal(Math[one](2), Math[other](2));
  }
  assert.equal(missing('sequence-end/v1', { operator: 'findIndex', form: 'findLastIndex', left: 'rows' }), 'a test in which `rows` has two or more elements');
  assert.equal(missing('sequence-end/v1', { operator: 'lastIndexOf', form: 'indexOf', left: 'rows' }), 'a test in which `rows` holds the searched value more than once');
  assert.equal(missing('sequence-end/v1', { operator: 'at0', form: 'at-1', left: 'rows' }), 'a test in which `rows` has two or more elements and the first is not the last');
});

test('what a surviving edit changes in the code a test runs is told per test', async () => {
  const { changedReach, indexReach } = await import('../src/standard-plan.mjs');
  const reach = indexReach([
    { modules: [['', '/w/a.test.ts']], coverage: { static: { load: 1, never: 0 }, perTest: { t1: { x: 2, y: 1 }, t2: { x: 1, zero: 0 } } } },
    { modules: [['', '/w/b.test.ts']], coverage: { static: {}, perTest: { t3: { y: 1 } } } }, {},
  ]);
  assert.deepEqual([[...reach.byTest.get('t1')], [...reach.byTest.get('t2')], [...reach.whileLoading.get('["","/w/a.test.ts"]')]], [['x', 'y'], ['x'], ['load']]);
  assert.deepEqual(changedReach(reach, [{ module: '["","/w/a.test.ts"]', reached: { t1: ['x', 'y'], t2: ['x', 'y', 'z'], '': [] } },
    { module: '["","/w/b.test.ts"]', reached: { t3: [], new: ['q'] } }]),
  // What is missing outside the tests is not told: the hooks of tests that were not chosen did not run.
  { now: [{ test: 't2', id: 'y' }, { test: 't2', id: 'z' }, { test: 'new', id: 'q' }], gone: [{ test: 't3', id: 'y' }] });
  assert.deepEqual(changedReach(reach, [{ module: '["","/w/a.test.ts"]', reached: { '': ['load', 'more'] } }]), { now: [{ test: '', id: 'more' }], gone: [] });
  assert.equal(changedReach(reach, [{ module: 'm', reached: { t: ['a', 'b', 'c'] } }], 2).now.length, 2);
  // A fresh run gives the same per test file, and a test that reached nothing is there with nothing.
  const { reachOfRecords } = await import('../src/standard-plan.mjs');
  const fresh = reachOfRecords([{ modules: [['', '/w/a.test.ts']], coverage: { static: { load: 1 }, perTest: { t1: { x: 1, y: 0 } } } }], ['t1', 't2']);
  assert.deepEqual(fresh, [{ module: '["","/w/a.test.ts"]', reached: { t1: ['x'], '': ['load'] } }, { module: null, reached: { t2: [] } }]);
  assert.deepEqual(changedReach(reach, fresh).gone, [{ test: 't1', id: 'y' }, { test: 't2', id: 'x' }]);
});

test('a test that has the input and asserts nothing: the report says what the edit lets it run', () => {
  const store = `const store = new Map<string, number>();
export function commit(batch: [string, number][]) {
  const invalid = batch.some(([, value]) => value < 0);
  if (invalid === true) return false;
  for (const [key, value] of batch) store.set(key, value + 0);
  return true;
}
export const read = (key: string) => store.get(key) ?? -1;
`;
  const suite = `import { expect, it } from 'vitest';
import { commit, read } from './subject';
it('writes', () => { expect(commit([['a', 1]])).toBe(true); expect(read('a')).toBe(1); });
it('rejects', () => { commit([['b', -5]]); });
`;
  const { status, stderr, report } = analyzeProject({ 'subject.ts': store, 'subject.test.ts': suite }, '--suggest-assertions');
  assert.equal(status, 0, stderr);
  const gap = report.diagnostics.find(entry => entry.mutations[0].replacement === '(invalid, true, false)');
  assert.deepEqual([gap.kind, gap.tests.map(entry => entry.name)], ['ASSERTION GAP', ['rejects']]);
  // With the check gone the rejected batch is written: the test that passes it now reaches the write.
  assert.deepEqual(gap.effects, { nowRuns: [{ test: 'rejects', location: { file: 'subject.ts', line: 5, column: 52 }, expression: 'value + 0' }], noLongerRuns: [] });
  assert.equal(gap.suggestedTest, "expect(commit([['b', -5]])).toBe(false)");
  assert.ok(report.mutants.every(mutant => mutant.effects === undefined));
  // A fresh Vitest run for every edit says the same.
  const isolated = analyzeProject({ 'subject.ts': store, 'subject.test.ts': suite }, '--isolated-trials');
  assert.deepEqual(isolated.report.diagnostics.find(entry => entry.mutations[0].replacement === '(invalid, true, false)').effects, gap.effects);
  // A test that reaches nothing at all with the edit is still compared.
  const constant = analyzeProject({ 'subject.ts': 'const on = 1 === 1;\nexport function work() { if (on) return 4 + 2; }\n',
    'subject.test.ts': "import { it } from 'vitest';\nimport { work } from './subject';\nit('works', () => { work(); });\n" });
  assert.deepEqual(constant.report.diagnostics.find(entry => entry.mutations[0].replacement === '(1, 1, false)').effects.noLongerRuns.map(entry => [entry.test, entry.expression]),
    [['works', '4 + 2']]);
  // The right side of a probed operator is evaluated through its own switches, so losing it is told.
  const fallback = analyzeProject({ 'subject.ts': 'export const limit = (given: number, defaults: number[]) => given || (defaults.length + 1);\n',
    'subject.test.ts': "import { expect, it } from 'vitest';\nimport { limit } from './subject';\nit('limits', () => { expect(limit(0, [1])).toBeDefined(); expect(limit(5, [])).toBe(5); });\n" });
  assert.deepEqual(fallback.report.diagnostics.find(entry => entry.mutations[0].replacement === '(given ?? (defaults.length + 1))').effects.noLongerRuns.map(entry => entry.expression),
    ['defaults.length + 1']);
  const text = renderText(report);
  assert.match(text, /with the edit, `rejects` also evaluates `value \+ 0` \(subject\.ts:5\)\n {2}subject\.test\.ts > rejects calls `commit\(\[\['b', -5\]\]\)` without pinning its result: it gives false, and true with the edit/);
  assert.match(renderText({ runner: 'vitest', evaluation: 'evaluated', mutants: [], diagnostics: [{ kind: 'ASSERTION GAP', location: gap.location,
    effects: { nowRuns: [{ location: { file: 'a.ts', line: 2, column: 1 }, expression: 'x\n+ y' }], noLongerRuns: [] } }] }), /with the edit, loading the file also evaluates `x` \(a\.ts:2\)/);
});

test('a sort, an awaited call and a copy: one names its numbers, the others say what to assert', () => {
  const code = `export const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
export const log: string[] = [];
const write = async (line: string, times: number) => { log.push(line.repeat(times)); };
export async function record(line: string) {
  await write(line, 2 - 1);
  return log.length;
}
export const options = (given: { size?: number }) => ({ ...given });
`;
  const suite = `import { expect, it } from 'vitest';
import { options, record, sorted } from './subject';
it('sorts', () => { expect(sorted([3, 1, 2])).toEqual([1, 2, 3]); });
it('records', async () => { expect(await record('a')).toBe(1); });
it('options', () => { expect(options({ size: 2 })).toEqual({ size: 2 }); });
`;
  const { status, stderr, report } = analyzeProject({ 'subject.ts': code, 'subject.test.ts': suite });
  assert.equal(status, 0, stderr);
  const gap = replacement => report.diagnostics.find(entry => entry.mutations[0].replacement === replacement);
  assert.deepEqual([gap('[...list].sort()').kind, gap('[...list].sort()').missing],
    ['INPUT GAP', 'a test in which `[...list]` holds numbers whose order as text is not their order as numbers (9 and 10)']);
  assert.deepEqual([gap('void write(line, 2 - 1);').kind, gap('void write(line, 2 - 1);').rule], ['ASSERTION GAP', 'await-dropped/v1']);
  assert.match(gap('void write(line, 2 - 1);').advice, /not waited for/);
  // What the edited statement itself evaluates is not reported as no longer evaluated.
  assert.equal(gap('void write(line, 2 - 1);').effects, undefined);
  assert.match(gap('(given)').advice, /the original itself/);
  assert.match(gap('(list)').advice, /the original itself/);
  assert.match(renderText(report), /ASSERTION GAP subject\.ts:5:3 {2}await-dropped\/v1\n {2}`await write\(line, 2 - 1\);` passes every test as `void write\(line, 2 - 1\);`\n {2}the tests pass when this call is not waited for/);
  // A test that looks at the caller's list afterwards and one with 9 and 10 close two of them.
  const closed = analyzeProject({ 'subject.ts': code, 'subject.test.ts': suite +
    "it('keeps', () => { const given = [10, 9]; expect(sorted(given)).toEqual([9, 10]); expect(given).toEqual([10, 9]); });\n" });
  const verdict = replacement => closed.report.mutants.find(mutant => mutant.replacement === replacement).status;
  assert.deepEqual([verdict('[...list].sort()'), verdict('(list)')], ['killed', 'killed']);
});
