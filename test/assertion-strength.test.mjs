import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { recordingCall, strengthenAssertions, weakCalls, withoutSourceEdits } from '../src/assertion-strength.mjs';
import { renderText } from '../src/cli-output.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const head = "import { expect, it, test, describe } from 'vitest';\nimport { fee, bucket as group, type Rate } from '../src/subject';\nimport { other } from './helper';\n";
const calls = (body, names = ['t'], subject = 'src/subject.ts') =>
  weakCalls(`${head}it('t', () => {\n${body}\n});\n`, 'test/subject.test.ts', subject, names).map(call => call.text);

test('a call is taken where a test makes it with written arguments and does not pin its result down', () => {
  assert.deepEqual(calls("expect(fee(200, 3)).toBeGreaterThan(0);\nexpect(group(3)).not.toBe('none');\nfee(1, 2);\nconst kept = fee(-1, 0.5);\nexpect(fee(2, 2)).toBeTruthy();"),
    ['fee(200, 3)', 'group(3)', 'fee(1, 2)', 'fee(-1, 0.5)', 'fee(2, 2)']);
  // A pinned result needs nothing.
  assert.deepEqual(calls("expect(fee(200, 3)).toBe(600);\nexpect(fee(1, 1)).toEqual(1);\nexpect(group(0)).toBeNull();\nexpect(fee(1, 2)).toMatchInlineSnapshot();\nexpect(fee(1, 3)).toBeCloseTo(3);"), []);
  // Arguments may be written arrays and objects; a variable, a call or a spread is not written.
  assert.deepEqual(calls("const n = 2;\nfee(n, 1);\nfee(fee(1, 1), 1);\nfee(...[1, 2]);\nexpect(group([1, 'a', null], { deep: [true, undefined], 'k': -2n })).toBeDefined();\ngroup({ [n]: 1 });"),
    ["group([1, 'a', null], { deep: [true, undefined], 'k': -2n })"]);
  // Only a statement of the test itself: not in a loop, a branch, a callback, or an assertion on a promise.
  assert.deepEqual(calls("for (const i of [1]) { fee(1, 1); }\nif (true) fee(2, 1);\n[1].forEach(() => fee(3, 1));\nexpect(fee(4, 1)).resolves.toBeTruthy();\nexpect(fee(5, 1)).toBeTruthy;\nexpect(fee(6,\n  1)).toBeTruthy();"), []);
  // Only functions imported from the subject, by value.
  assert.deepEqual(calls('other(1);\nexpect(other(2)).toBeTruthy();\nRate(1);'), []);
  assert.deepEqual(calls('fee(1, 1);', ['t'], 'src/another.ts'), []);
  assert.deepEqual(weakCalls("import { fee } from '../src/subject/index.js';\nit('t', () => { fee(1, 1); });\n", 'test/a.test.ts', 'src/subject/index.ts', ['t']).length, 1);
  assert.deepEqual(weakCalls("import type { fee } from '../src/subject';\nit('t', () => { fee(1, 1); });\n", 'test/a.test.ts', 'src/subject.ts', ['t']), []);
});

test('a call is taken only from the tests a finding names, and is located in its file', () => {
  const text = `${head}describe('fees', () => {\n  it('low', () => { expect(fee(1, 1)).toBeTruthy(); });\n  test('high', () => { expect(fee(9, 9)).toBeTruthy(); });\n});\nit.skip('later', () => { fee(0, 0); });\nit(name, () => { fee(7, 7); });\n`;
  const found = names => weakCalls(text, 'test/subject.test.ts', 'src/subject.ts', names).map(call => [call.text, call.test, call.line, call.column]);
  assert.deepEqual(found(['fees > high']), [['fee(9, 9)', 'high', 6, 31]]);
  assert.deepEqual(found(['fees > low', 'fees > high']), [['fee(1, 1)', 'low', 5, 28], ['fee(9, 9)', 'high', 6, 31]]);
  // A test of the same title in another suite is another test.
  assert.deepEqual(found(['other > higher', 'later', 'refunds > high', 'high']), []);
  const suites = `${head}describe('refunds', () => { it('works', () => { fee(1, 1); }); });\ndescribe.each([1])('charges', () => { it('works', () => { fee(2, 2); }); });\n` +
    `describe(name, () => { suite('deep', () => { it('works', () => { fee(3, 3); }); }); });\n`;
  const inSuites = names => weakCalls(suites, 'test/subject.test.ts', 'src/subject.ts', names).map(call => call.text);
  // Under a suite whose title is a pattern or not written out, the test's own title has to do.
  assert.deepEqual(inSuites(['charges > works']), ['fee(2, 2)', 'fee(3, 3)']);
  assert.deepEqual(inSuites(['refunds > works']), ['fee(1, 1)', 'fee(2, 2)', 'fee(3, 3)']);
  assert.deepEqual(inSuites(['refunds > other']), []);
});

test('a wrapped call gives its value on and writes down what a comparison can be written with', () => {
  const text = "const out = [];\nfunction pick(v) { return v; }\nout.push(pick(3), pick('a\"b'));\n";
  const start = text.indexOf("pick('a");
  const rewritten = recordingCall(text, { start, end: start + "pick('a\"b')".length, text: "pick('a\"b')" }, 'k1');
  assert.equal(loadTypeScript().createSourceFile('t.mjs', rewritten, 99, false).parseDiagnostics.length, 0);
  assert.match(rewritten, /out\.push\(pick\(3\), __tmtValue_k1\(pick\('a"b'\)\)\);/);
  const written = [];
  const helper = rewritten.slice(rewritten.indexOf('function __tmtValue_k1')).replace('import.meta.url', "'file:///t/'");
  // The file system comes from Node itself, so a test that mocks 'node:fs' does not get in the way.
  assert.doesNotMatch(rewritten, /import .* from 'node:fs'/);
  const context = vm.createContext({ URL, process: { getBuiltinModule: name => ({ 'node:fs': { appendFileSync: (url, line) => written.push([String(url), line]) } })[name] } });
  const shown = value => { context.value = value; vm.runInContext(helper + '; var given = __tmtValue_k1(value);', context); return [context.given === value || Number.isNaN(value), JSON.parse(written.pop()[1])]; };
  assert.deepEqual([3, -0, NaN, 'a"b', true, null, undefined, 5n].map(shown), [[true, '3'], [true, '-0'], [true, 'NaN'], [true, '"a\\"b"'], [true, 'true'],
    [true, 'null'], [true, 'undefined'], [true, '5n']]);
  // Anything else has no literal to compare with.
  assert.deepEqual([{ a: 1 }, [1], () => 1].map(shown), [[true, null], [true, null], [true, null]]);
  shown(1);
  assert.equal(written.length, 0);
});

function project(files, action) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-assert-test-')));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const subject = `export const fee = (cents: number, rate: number) => cents * rate;
export const size = (list: number[]) => list.length > 2 ? 'big' : 'small';
`;
const suite = `import { expect, it } from 'vitest';
import { fee, size } from './subject';
it('charges', () => { expect(fee(200, 3)).toBeGreaterThan(0); });
it('sizes', () => { expect(size([1, 2, 3])).toBe('big'); expect(size([])).toBe('small'); });
`;

test('a survivor whose test makes the telling call gets the value to compare with', () => project({ 'subject.ts': subject, 'subject.test.ts': suite }, root => {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--suggest-assertions', '--format', 'json'],
    { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const gap = report.diagnostics.find(entry => entry.mutations[0].replacement === '(cents + rate)');
  assert.equal(gap.kind, 'ASSERTION GAP');
  assert.equal(gap.suggestedTest, 'expect(fee(200, 3)).toBe(600)');
  assert.deepEqual(gap.strengthens, { file: 'subject.test.ts', test: 'charges', line: 3, column: 30, call: 'fee(200, 3)', original: '600', edited: '203' });
  // The plain source edits that the runs used are not in the report, and both files are as they were.
  assert.ok(report.diagnostics.every(entry => entry.mutations.every(mutation => mutation.source === undefined)));
  assert.equal(readFileSync(join(root, 'subject.test.ts'), 'utf8'), suite);
  assert.match(renderText(report), /subject\.test\.ts > charges calls `fee\(200, 3\)` without pinning its result: it gives 600, and 203 with the edit\n {2}suggested test: expect\(fee\(200, 3\)\)\.toBe\(600\)/);
  // Without the option nothing more is run and nothing is suggested.
  const plain = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--format', 'json'], { encoding: 'utf8', timeout: 120_000 });
  const untouched = JSON.parse(plain.stdout).diagnostics;
  assert.ok(untouched.every(entry => entry.strengthens === undefined && entry.mutations.every(mutation => mutation.source === undefined)));
  const refused = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, '--suggest-assertions', '--runner', 'playwright'], { encoding: 'utf8' });
  assert.match(refused.stderr, /--suggest-assertions applies to/);
}));

test('the runs are shared and bounded: one for a call as it is, one per finding, and none where nothing can be compared', () => project({ 'subject.ts': subject, 'subject.test.ts': suite }, root => {
  const seen = [];
  const values = { original: '"600"', edited: '"203"' };
  const run = { sourceTrials: (_root, subjects, options) => settings => {
    seen.push([options.test.join(), settings.trial ? settings.trial.replacement : 'as it is', /__tmtValue_\w+\(fee\(200, 3\)\)/.test(settings.witness.rewrite.content), settings.collect.startsWith('.tmt-values-')]);
    return { status: 'passed', collected: (settings.trial ? values.edited : values.original) + '\n' };
  } };
  const gap = replacement => ({ kind: 'ASSERTION GAP', location: { file: 'subject.ts', line: 1, column: 1 }, tests: [{ file: 'subject.test.ts', name: 'charges' }],
    mutations: [{ edit: [52, 64], replacement, source: { edit: [52, 64], replacement: ` ${replacement} ` } }] });
  const report = { diagnostics: [gap('(cents + rate)'), gap('(cents / rate)'), { kind: 'INPUT GAP', location: { file: 'subject.ts' }, mutations: [{}] },
    { ...gap('x'), tests: [{ file: 'subject.test.ts', name: 'sizes' }] }] };
  strengthenAssertions(root, report, {}, run);
  assert.deepEqual(seen, [['subject.test.ts', 'as it is', true, true], ['subject.test.ts', ' (cents + rate) ', true, true], ['subject.test.ts', ' (cents / rate) ', true, true]]);
  assert.deepEqual(report.diagnostics.map(entry => entry.suggestedTest), ['expect(fee(200, 3)).toBe(600)', 'expect(fee(200, 3)).toBe(600)', undefined, undefined]);
  // The same values with the edit: the call does not tell them apart. A value without a literal: nothing to suggest.
  for (const [original, edited] of [['"600"', '"600"'], ['null', '"203"'], ['', '"203"']]) {
    Object.assign(values, { original, edited });
    const again = { diagnostics: [gap('(cents + rate)')] };
    strengthenAssertions(root, again, {}, run);
    assert.equal(again.diagnostics[0].suggestedTest, undefined, `${original} against ${edited}`);
  }
  // An edit that keeps the test from reaching the call gives no value, and an assertion there would not run either.
  Object.assign(values, { original: '"600"', edited: '' });
  const crashed = { diagnostics: [gap('(cents + rate)')] };
  strengthenAssertions(root, crashed, {}, run);
  assert.equal(crashed.diagnostics[0].suggestedTest, undefined);
  // A call made twice in a loop of tests: the first value that differs is the one compared.
  Object.assign(values, { original: '"600"\n"7"', edited: '"600"\n"8"' });
  const later = { diagnostics: [gap('(cents + rate)')] };
  strengthenAssertions(root, later, {}, run);
  assert.deepEqual([later.diagnostics[0].suggestedTest, later.diagnostics[0].strengthens.edited], ['expect(fee(200, 3)).toBe(7)', '8']);
  assert.equal(withoutSourceEdits(crashed).diagnostics[0].mutations[0].source, undefined);
}));

test('a result the test keeps is compared where it is kept, and the runs stop at four calls for a finding and 24 in all', () => project({
  'subject.ts': 'let n = 0;\nexport function nextId() { return ++n * 2; }\n',
  'a.test.ts': "import { expect, it } from 'vitest';\nimport { nextId } from './subject';\nit('ids', () => {\n  const id = nextId();\n  expect(id > 0).toBe(true);\n  nextId(); nextId(); nextId(); nextId(); nextId();\n});\n",
  'b.test.ts': "import { it } from 'vitest';\nimport { nextId } from './subject';\nit('more', () => {\n  nextId();\n});\n",
}, root => {
  let edits = 0;
  const values = { edited: '"3"' };
  const run = { sourceTrials: () => settings => { if (settings.trial) edits++; return { status: 'passed', collected: (settings.trial ? values.edited : '"2"') + '\n' }; } };
  const gap = () => ({ kind: 'ASSERTION GAP', location: { file: 'subject.ts' }, tests: [{ file: 'a.test.ts', name: 'ids' }, { file: 'b.test.ts', name: 'more' }],
    mutations: [{ edit: [0, 1], replacement: 'x' }] });
  const kept = { diagnostics: [gap()] };
  strengthenAssertions(root, kept, {}, run);
  // Calling again would give the next id.
  assert.equal(kept.diagnostics[0].suggestedTest, 'expect(id).toBe(2)');
  // No call tells the edit apart: four calls are tried for each finding, over both test files, and 24 in all.
  values.edited = '"2"';
  edits = 0;
  const many = { diagnostics: Array.from({ length: 8 }, gap) };
  strengthenAssertions(root, many, {}, run);
  assert.equal(edits, 24);
  assert.ok(many.diagnostics.every(entry => entry.suggestedTest === undefined));
  edits = 0;
  strengthenAssertions(root, { diagnostics: [gap()] }, {}, run);
  assert.equal(edits, 4);
}));

const callRows = readFileSync(new URL('../verification/pict/weak-calls.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1).map(line => line.split('\t'));
test('the call table has every required case', () => {
  const table = new Set(callRows.map(row => row.join('\t')));
  for (const seed of readFileSync(new URL('../verification/pict/weak-calls.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)) assert.ok(table.has(seed), seed);
});
for (const [use, args, origin, place, named] of callRows) {
  test(`weak call: ${use}, ${args}, from ${origin}, in ${place}, test named ${named}`, () => {
    const imports = { Subject: "import { fee } from './subject';", SubjectAlias: "import { fee as charge } from './subject';",
      OtherModule: "import { fee } from './other';", TypeImport: "import { type fee } from './subject';" }[origin];
    const name = origin === 'SubjectAlias' ? 'charge' : 'fee';
    const call = `${name}(${{ Scalars: "200, 'a'", Collection: '[1, { a: null }], -2', Variable: 'amount, 3', Spread: '...[1, 2]' }[args]})`;
    const statement = { Unused: `${call};`, Bound: `const kept = ${call};`, WeakMatcher: `expect(${call}).toBeGreaterThan(0);`,
      NegatedMatcher: `expect(${call}).not.toBe(1);`, PinningMatcher: `expect(${call}).toStrictEqual(1);`, PromiseMatcher: `expect(${call}).resolves.toBeTruthy();` }[use];
    const body = { TestBody: statement, Loop: `for (const turn of [1]) { ${statement} }`, Callback: `[1].forEach(() => { ${statement} });` }[place];
    const text = `import { expect, it } from 'vitest';\n${imports}\nconst amount = 2;\nit('charges', () => {\n  ${body}\n});\n`;
    const found = weakCalls(text, 'a.test.ts', 'subject.ts', [named === 'Yes' ? 'charges' : 'refunds']);
    const taken = ['Unused', 'Bound', 'WeakMatcher', 'NegatedMatcher'].includes(use) && ['Scalars', 'Collection'].includes(args) &&
      ['Subject', 'SubjectAlias'].includes(origin) && place === 'TestBody' && named === 'Yes';
    assert.deepEqual(found.map(entry => entry.text), taken ? [call] : []);
    if (taken) assert.equal(text.slice(found[0].start, found[0].end), call);
  });
}
