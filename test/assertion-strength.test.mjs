import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import util from 'node:util';
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
  // A name that a fully written test of the file has belongs to that test alone.
  assert.deepEqual(inSuites(['refunds > works']), ['fee(1, 1)']);
  assert.deepEqual(inSuites(['refunds > other']), []);
  // Options may stand between a title and its callback.
  const options = `${head}describe('fees', { timeout: 5000 }, () => { it('works', { retry: 0 }, () => { fee(4, 4); }); });\n`;
  assert.deepEqual(weakCalls(options, 'test/subject.test.ts', 'src/subject.ts', ['fees > works']).map(call => call.text), ['fee(4, 4)']);
  assert.deepEqual(weakCalls(options, 'test/subject.test.ts', 'src/subject.ts', ['works']), []);
});

test('a wrapped call gives its value on and writes down what a comparison can be written with', () => {
  const text = "const out = [];\nfunction pick(v) { return v; }\nout.push(pick(3), pick('a\"b'));\n";
  const start = text.indexOf("pick('a");
  const rewritten = recordingCall(text, { start, end: start + "pick('a\"b')".length, text: "pick('a\"b')" }, 'k1');
  assert.equal(loadTypeScript().createSourceFile('t.mjs', rewritten, 99, false).parseDiagnostics.length, 0);
  assert.match(rewritten, /out\.push\(pick\(3\), __tmtValue_k1\(pick\('a"b'\)\)\);/);
  const written = [];
  const helper = rewritten.slice(rewritten.indexOf('function __tmtValue_k1')).replace('import.meta.url', "'file:///t/'");
  // The file system comes from Node itself when the file has loaded, so a test that mocks 'node:fs' or replaces
  // `process` afterwards does not get in the way.
  assert.doesNotMatch(rewritten, /import .* from 'node:fs'/);
  const context = vm.createContext({ URL, process: { getBuiltinModule: name => ({ 'node:fs': { appendFileSync: (url, line) => written.push([String(url), line]) }, 'node:util': util })[name] } });
  vm.runInContext(rewritten.slice(rewritten.indexOf('var __tmtFiles_k1'), rewritten.indexOf('function __tmtValue_k1')) + '; process = undefined;', context);
  // Where `process` is replaced while the file loads and back when the test runs, both `node:fs` and `node:util` are taken at the first call.
  const late = vm.createContext({ URL, process: {} });
  let lateProxyTraps = 0;
  late.proxyVal = new Proxy({ a: 1 }, new Proxy({}, { get() { lateProxyTraps++; return () => {}; } }));
  vm.runInContext(rewritten.slice(rewritten.indexOf('var __tmtFiles_k1')).replace('import.meta.url', "'file:///t/'") +
    '; process = { getBuiltinModule: name => name === "node:fs" ? { appendFileSync: (url, line) => { globalThis.wrote = (globalThis.wrote || "") + line; } } : globalThis.utilMod }; __tmtValue_k1(7); __tmtValue_k1(proxyVal);', Object.assign(late, { utilMod: util }));
  assert.equal(late.wrote, '"7"\nnull\n');
  assert.equal(lateProxyTraps, 0);
  // Without `node:util`, objects safely fall back to null so Proxy traps cannot run.
  let noUtilWrote = '';
  const noUtil = vm.createContext({ URL, process: { getBuiltinModule: name => name === 'node:fs' ? { appendFileSync: (_url, line) => { noUtilWrote += line; } } : undefined } });
  vm.runInContext(rewritten.slice(rewritten.indexOf('var __tmtFiles_k1')).replace('import.meta.url', "'file:///t/'") + '; __tmtValue_k1({ a: 1 });', noUtil);
  assert.equal(noUtilWrote, 'null\n');
  const shown = value => { context.value = value; vm.runInContext(helper + '; var given = __tmtValue_k1(value);', context); return [context.given === value || Number.isNaN(value), JSON.parse(written.pop()[1])]; };
  assert.deepEqual([3, -0, NaN, 'a"b', true, null, undefined, 5n].map(shown), [[true, '3'], [true, '-0'], [true, 'NaN'], [true, '"a\\"b"'], [true, 'true'],
    [true, 'null'], [true, 'undefined'], [true, '5n']]);
  // Plain bounded same-realm objects (canonical key order) and arrays format for `toStrictEqual`; cross-realm & exotic values stay null.
  const sameRealm = expr => vm.runInContext(`(${expr})`, context);
  assert.deepEqual(['{ a: 1, "k-2": [true] }', '{ b: 2, a: 1 }', '[1, "x"]', '{}'].map(expr => shown(sameRealm(expr))), [
    [true, '{ a: 1, "k-2": [true] }'], [true, '{ a: 1, b: 2 }'], [true, '[1, "x"]'], [true, '{}'],
  ]);
  // Construct negative test cases inside the same realm so each individual guard is genuinely exercised.
  const negatives = vm.runInContext(`(() => {
    globalThis.__getterRan = 0;
    globalThis.__proxyTraps = 0;
    const cyclic = {}; cyclic.self = cyclic;
    const withGetter = { get x() { globalThis.__getterRan++; return 1; } };
    const trap = new Proxy({}, { get() { globalThis.__proxyTraps++; return () => {}; } });
    const proxyTarget = new Proxy({ a: 1 }, trap);
    const proxyProto = Object.create(new Proxy({}, trap));
    class SubArray extends Array {}
    const trickedArray = [1, 2];
    Object.defineProperty(trickedArray, 1, { value: 2, enumerable: false });
    trickedArray.extra = 3;
    const sparse = [1, , 3];
    const protoKey = Object.defineProperty({}, '__proto__', { value: 1, enumerable: true });
    return [() => 1, new Date(0), cyclic, withGetter, Object.create(null), proxyTarget, proxyProto, new SubArray(1, 2), trickedArray, sparse, protoKey];
  })()`, context);
  const crossRealmObj = { a: 1 };
  const crossRealmArr = [1, 2];
  assert.deepEqual([...negatives, crossRealmObj, crossRealmArr].map(shown),
    Array.from({ length: 13 }, () => [true, null]));
  assert.equal(context.__getterRan, 0);
  assert.equal(context.__proxyTraps, 0);
  shown(1);
  assert.equal(written.length, 0);
});

async function project(files, action) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-assert-test-')));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    return await action(root);
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

test('the runs are shared and bounded: one for a call as it is, one per finding, and none where nothing can be compared', () => project({ 'subject.ts': subject, 'subject.test.ts': suite }, async root => {
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
  await strengthenAssertions(root, report, {}, run);
  assert.deepEqual(seen, [['subject.test.ts', 'as it is', true, true], ['subject.test.ts', ' (cents + rate) ', true, true], ['subject.test.ts', ' (cents / rate) ', true, true]]);
  assert.deepEqual(report.diagnostics.map(entry => entry.suggestedTest), ['expect(fee(200, 3)).toBe(600)', 'expect(fee(200, 3)).toBe(600)', undefined, undefined]);
  // Plain object/array return values suggest `toStrictEqual`.
  Object.assign(values, { original: '"{ total: 600 }"', edited: '"{ total: 203 }"' });
  const objReport = { diagnostics: [gap('(cents + rate)')] };
  await strengthenAssertions(root, objReport, {}, run);
  assert.equal(objReport.diagnostics[0].suggestedTest, 'expect(fee(200, 3)).toStrictEqual({ total: 600 })');
  // The same values with the edit: the call does not tell them apart. A value without a literal: nothing to suggest.
  for (const [original, edited] of [['"600"', '"600"'], ['null', '"203"'], ['', '"203"']]) {
    Object.assign(values, { original, edited });
    const again = { diagnostics: [gap('(cents + rate)')] };
    await strengthenAssertions(root, again, {}, run);
    assert.equal(again.diagnostics[0].suggestedTest, undefined, `${original} against ${edited}`);
  }
  // An edit that keeps the test from reaching the call gives no value, and an assertion there would not run either.
  Object.assign(values, { original: '"600"', edited: '' });
  const crashed = { diagnostics: [gap('(cents + rate)')] };
  await strengthenAssertions(root, crashed, {}, run);
  assert.equal(crashed.diagnostics[0].suggestedTest, undefined);
  // Made once as it is and twice or never with the edit (a retry, a case that returns early): the values cannot be matched.
  for (const [original, edited] of [['"600"', '"600"\n"601"'], ['"1"\n"2"', '"2"']]) {
    Object.assign(values, { original, edited });
    const unmatched = { diagnostics: [gap('(cents + rate)')] };
    await strengthenAssertions(root, unmatched, {}, run);
    assert.equal(unmatched.diagnostics[0].suggestedTest, undefined, `${original} against ${edited}`);
  }
  // A call made twice in a loop of tests: the first value that differs is the one compared.
  Object.assign(values, { original: '"600"\n"7"', edited: '"600"\n"8"' });
  const later = { diagnostics: [gap('(cents + rate)')] };
  await strengthenAssertions(root, later, {}, run);
  assert.deepEqual([later.diagnostics[0].suggestedTest, later.diagnostics[0].strengthens.edited], ['expect(fee(200, 3)).toBe(7)', '8']);
  assert.equal(withoutSourceEdits(crashed).diagnostics[0].mutations[0].source, undefined);
}));

test('a result the test keeps is compared where it is kept, and the runs stop at four calls for a finding and 24 in all', () => project({
  'subject.ts': 'let n = 0;\nexport function nextId() { return ++n * 2; }\n',
  'a.test.ts': "import { expect, it } from 'vitest';\nimport { nextId } from './subject';\nit('ids', () => {\n  const id = nextId();\n  expect(id > 0).toBe(true);\n  nextId(); nextId(); nextId(); nextId(); nextId();\n});\n",
  'b.test.ts': "import { it } from 'vitest';\nimport { nextId } from './subject';\nit('more', () => {\n  nextId();\n});\n",
}, async root => {
  let edits = 0;
  const values = { edited: '"3"' };
  const run = { sourceTrials: () => settings => { if (settings.trial) edits++; return { status: 'passed', collected: (settings.trial ? values.edited : '"2"') + '\n' }; } };
  const gap = () => ({ kind: 'ASSERTION GAP', location: { file: 'subject.ts' }, tests: [{ file: 'a.test.ts', name: 'ids' }, { file: 'b.test.ts', name: 'more' }],
    mutations: [{ edit: [0, 1], replacement: 'x' }] });
  const kept = { diagnostics: [gap()] };
  await strengthenAssertions(root, kept, {}, run);
  // Calling again would give the next id.
  assert.equal(kept.diagnostics[0].suggestedTest, 'expect(id).toBe(2)');
  // No call tells the edit apart: four calls are tried for each finding, over both test files, and 24 in all.
  values.edited = '"2"';
  edits = 0;
  const many = { diagnostics: Array.from({ length: 8 }, gap) };
  await strengthenAssertions(root, many, {}, run);
  assert.equal(edits, 24);
  assert.ok(many.diagnostics.every(entry => entry.suggestedTest === undefined));
  edits = 0;
  await strengthenAssertions(root, { diagnostics: [gap()] }, {}, run);
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

test('the conditions of a taken call, one at a time', () => {
  // Each written kind of argument on its own, and what is not written beside it.
  for (const argument of ["'a'", '`t`', 'true', 'false', 'null', 'undefined', '-1', '-2n', '[]', '{}', "{ 'k': [1] }"]) assert.deepEqual(calls(`fee(${argument});`), [`fee(${argument})`], argument);
  for (const argument of ['-amount', '!1', '[1, amount]', '{ a: 1, b: amount }', '{ amount }', '{ ...{} }', '`${1}`', 'fee', '1 + 1']) assert.deepEqual(calls(`const amount = 1;\nfee(${argument});`), [], argument);
  // An assertion has to be a statement that calls a matcher on `expect(call)` alone.
  assert.deepEqual(calls('expect(fee(1));\nexpect(fee(2), "why").toBeTruthy();\nconst kept = expect(fee(3)).toBeTruthy();\nexpect.soft(fee(4)).toBeTruthy();\nassert(fee(5)).toBeTruthy();'), []);
  assert.deepEqual(calls('expect(fee(1)).not.toBeNull();\nexpect((fee(2))).toHaveLength(1);'), ['fee(1)', 'fee(2)']);
  // A kept result is a declaration statement of the test: not the start of a loop.
  assert.deepEqual(calls('for (let kept = fee(1); kept < 1;) break;\nlet first = 1, second = fee(2);').sort(), ['fee(2)']);
  assert.deepEqual(weakCalls(`${head}it('t', () => {\n  const { size } = fee(1);\n  const kept = fee(2);\n});\n`, 'test/subject.test.ts', 'src/subject.ts', ['t']).map(call => call.bound), [undefined, 'kept']);
  // Only a test: `it` or `test` with a written title and its callback last.
  const outside = body => weakCalls(`${head}${body}\n`, 'test/subject.test.ts', 'src/subject.ts', ['t']).map(call => call.text);
  assert.deepEqual(outside("bench('t', () => { fee(1); });\nit(() => { fee(2); });\nit.only('t', () => { fee(4); });\nfee(5);\nconst t = () => { fee(6); };"), []);
  // A timeout may stand after the callback, and options before it.
  assert.deepEqual(outside("test('t', function () { fee(1); });\nit('t', async () => { fee(2); });\nit('t', () => { fee(3); }, 500);\nit('t', { retry: 1 }, () => { fee(4); });"),
    ['fee(1)', 'fee(2)', 'fee(3)', 'fee(4)']);
  // A test written out in full keeps its name even when its own call is pinned.
  const pinned = `${head}describe('known', () => { test('same', () => { expect(fee(1)).toBe(1); }); });\ndescribe.each(['other'])('%s', () => { test('same', () => { fee(2); }); });\n`;
  assert.deepEqual(weakCalls(pinned, 'test/subject.test.ts', 'src/subject.ts', ['known > same']), []);
  assert.deepEqual(weakCalls(pinned, 'test/subject.test.ts', 'src/subject.ts', ['other > same']).map(call => call.text), ['fee(2)']);
  // A wrapper that is no suite gives no part of the name.
  assert.deepEqual(outside("each('rows', () => { it('t', () => { fee(1); }); });\ndescribe.skip('s', () => { it('t', () => { fee(2); }); });"), ['fee(1)']);
  // Named, default and namespace imports from the edited file are supported; package imports and non-matching files are not.
  const imported = line => weakCalls(`import { it } from 'vitest';\n${line}\nit('t', () => { fee(1); s.fee(2); });\n`, 'subject.test.ts', 'subject.ts', ['t']).length;
  assert.deepEqual(["import { fee } from './subject';", "import { fee } from './subject.js';", "import fee from './subject';", "import * as s from './subject';",
    "import { fee } from 'subject';", "import './subject';", "import { fee } from './subject/index';"].map(imported), [1, 1, 1, 1, 0, 0, 0]);
  // Awaited calls are wrapped as a whole (`await fee(1)`), and shadowed locals (including hoisted `var`) are skipped.
  assert.deepEqual(calls("await fee(1, 2);\nconst res = await fee(3, 4);\nexpect(await fee(5, 6)).toBeGreaterThan(0);"),
    ['await fee(1, 2)', 'await fee(3, 4)', 'await fee(5, 6)']);
  assert.deepEqual(calls("const fee = (x: number) => x;\nfee(1);"), []);
  assert.deepEqual(calls("if (true) { var fee = (x: number) => x; }\nfee(2);"), []);
  assert.deepEqual(weakCalls(`${head}namespace Helpers { var fee = 1; export const v = fee; }\nit('t', () => {\n  fee(2);\n});\n`, 'test/subject.test.ts', 'src/subject.ts', ['t']).map(call => call.text), ['fee(2)']);
  assert.deepEqual(weakCalls("import { it } from 'vitest';\nimport * as s from './subject';\nit('t', () => {\n  const s = { fee: (x: number) => x };\n  s.fee(1);\n});\n", 'subject.test.ts', 'subject.ts', ['t']), []);
});

test('strengthenAssertions keeps deterministic budget order under reversed async timing and ignores unformattable edited values', () => project({
  'subject.ts': 'export function f(n: number) { return n; }\n',
  'a.test.ts': "import { it } from 'vitest';\nimport { f } from './subject';\nit('t', () => {\n  f(1);\n  f(2);\n  f(3);\n  f(4);\n});\n",
}, async root => {
  let originalRuns = 0;
  const seenEdits = [];
  const run = {
    sourceTrialsAsync: () => async settings => {
      if (!settings.trial) {
        originalRuns++;
        return { status: 'passed', collected: '"[undefined]"\n' };
      }
      const id = Number(settings.trial.replacement);
      // Reverse completion speed so later findings resolve faster if run out of order.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 30 - id * 3)));
      seenEdits.push(id);
      // Unformattable (`null`) edited value (e.g. sparse array or Proxy) must not produce a bogus suggestion.
      if (id === 0) return { status: 'passed', collected: 'null\n' };
      return { status: 'passed', collected: '"[undefined]"\n' };
    },
  };
  const report = {
    diagnostics: Array.from({ length: 8 }, (_, index) => ({
      kind: 'ASSERTION GAP', location: { file: 'subject.ts' }, tests: [{ file: 'a.test.ts', name: 't' }],
      mutations: [{ edit: [0, 1], replacement: String(index) }],
    })),
  };
  await strengthenAssertions(root, report, { concurrency: 4 }, run);
  assert.equal(originalRuns, 4);
  assert.equal(seenEdits.length, 24);
  // First 6 findings (indices 0..5, 4 calls each = 24) consumed the budget; findings 6 and 7 never ran.
  assert.ok(seenEdits.every(id => id < 6));
  assert.equal(report.diagnostics[0].suggestedTest, undefined);
}));

test('suggest-assertions works end-to-end for awaited calls, default/namespace imports, and object return values', () => project({
  'subject.ts': `export default async function quote(cents: number, rate: number) { return { total: cents * rate }; }
export async function namedQuote(cents: number, rate: number) { return { total: cents * rate }; }
`,
  'subject.test.ts': `import { expect, it } from 'vitest';
import quote from './subject';
import * as subject from './subject';
it('quotes', async () => { expect((await quote(200, 3))).toBeDefined(); });
it('namespace quotes', async () => { expect(await subject.namedQuote(100, 4)).toBeDefined(); });
`,
}, root => {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--suggest-assertions', '--format', 'json'],
    { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  const defaultGap = report.diagnostics.find(entry => entry.location.line === 1 && entry.mutations[0].replacement === '(cents + rate)');
  const nsGap = report.diagnostics.find(entry => entry.location.line === 2 && entry.mutations[0].replacement === '(cents + rate)');
  assert.equal(defaultGap.kind, 'ASSERTION GAP');
  assert.equal(defaultGap.suggestedTest, 'expect(await quote(200, 3)).toStrictEqual({ total: 600 })');
  assert.equal(nsGap.kind, 'ASSERTION GAP');
  assert.equal(nsGap.suggestedTest, 'expect(await subject.namedQuote(100, 4)).toStrictEqual({ total: 400 })');
}));

test('weakCalls and suggest-assertions resolve tsconfig paths, precedence, barrel overrides, and warm Vitest session cwd/exitCode/IPC', () => project({
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@/fee': ['src/other.ts'], '@/missing': ['src/does-not-exist.ts'] } } }),
  'vitest.config.ts': `import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// Noisy stdout in config must not corrupt the warm assertion session's dedicated IPC channel.
console.log(null);
export default defineConfig({ resolve: { alias: [
  { find: '@/fee', replacement: resolve(__dirname, 'src/other.ts') },
  { find: '@', replacement: resolve(__dirname, 'src') },
] } });
`,
  'fixture.json': JSON.stringify({ factor: 3 }),
  'src/other.ts': 'export const other = (n: number) => n + 1;\nexport const fee = (a: number, b: number) => a + b;\n',
  'src/pricing.ts': 'export const fee = (cents: number, rate: number) => cents * rate;\nexport default function discount(cents: number, off: number) { return cents - off; }\n',
  'src/missing.ts': 'export { fee } from "./pricing";\n',
  'src/index.ts': `export { fee, default as discount } from './pricing';
export * as pricingNs from './pricing';
export { other } from './other';
`,
  'src/star.ts': "export * from './pricing';\nexport { fee } from './other';\n",
  'src/default-named.ts': "export * from './pricing';\nexport default function fee() { return 0; }\n",
  'test/pricing.test.ts': `import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { discount, fee, other, pricingNs } from '@/index';
import { fee as exactOtherFee } from '@/fee';
import { fee as starThroughDefault } from '@/default-named';
import * as barrel from '@/index';
import * as star from '@/star';
import { fee as overriddenStarFee } from '@/star';
it('barrel calls', () => {
  const { factor } = JSON.parse(readFileSync('./fixture.json', 'utf8'));
  expect(factor).toBe(3);
  expect(fee(200, 3)).toBeGreaterThan(0);
  expect(discount(500, 50)).toBeGreaterThan(0);
  expect(pricingNs.fee(10, 4)).toBeGreaterThan(0);
  expect(barrel.fee(20, 5)).toBeGreaterThan(0);
  expect(barrel.other(1)).toBeGreaterThan(0);
  expect(star.fee(30, 2)).toBeGreaterThan(0);
  expect(overriddenStarFee(30, 2)).toBeGreaterThan(0);
  expect(starThroughDefault(40, 2)).toBeGreaterThan(0);
  expect(exactOtherFee(1, 2)).toBeGreaterThan(0);
  expect(other(1)).toBeGreaterThan(0);
});
`,
}, root => {
  const testText = readFileSync(join(root, 'test/pricing.test.ts'), 'utf8');
  const found = weakCalls(testText, 'test/pricing.test.ts', 'src/pricing.ts', ['barrel calls'], loadTypeScript(), { root });
  // Exact path `@/fee` -> `src/other.ts` beats wildcard `@/*`; explicit `export { fee } from './other'` overrides `export * from './pricing'`;
  // `export default function fee()` does NOT shadow the named `export *` re-export `fee`.
  assert.deepEqual(found.map(c => c.text), ['fee(200, 3)', 'discount(500, 50)', 'pricingNs.fee(10, 4)', 'barrel.fee(20, 5)', 'starThroughDefault(40, 2)']);
  // An exact `paths` entry whose target is missing must NOT fall through to `@/*` -> `src/missing.ts`.
  const missingImportTest = "import { it } from 'vitest';\nimport { fee } from '@/missing';\nit('t', () => { fee(1, 2); });\n";
  assert.deepEqual(weakCalls(missingImportTest, 'test/pricing.test.ts', 'src/pricing.ts', ['t'], loadTypeScript(), { root }), []);
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'src/pricing.ts', '--suggest-assertions', '--format', 'json'],
    { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  const feeGap = report.diagnostics.find(entry => entry.location.line === 1 && entry.mutations[0].replacement === '(cents + rate)');
  const discGap = report.diagnostics.find(entry => entry.location.line === 2 && entry.mutations[0].replacement === '(cents + off)');
  assert.equal(feeGap.suggestedTest, 'expect(fee(200, 3)).toBe(600)');
  assert.equal(discGap.suggestedTest, 'expect(discount(500, 50)).toBe(450)');
}));
