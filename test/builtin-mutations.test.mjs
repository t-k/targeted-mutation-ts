import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderBuiltinSwitches } from '../src/builtin-switches.mjs';
import { prepareConventional } from '../src/conventional.mjs';

// The StrykerJS instrumenter (a development dependency) is the reference for the mutation set.
const normalize = text => text.replace(/\s+/g, '').replace(/[()]/g, '').replace(/['`]/g, '"').replace(/[;,]+(?=[\]}]|$)/g, '');
const key = mutant => [mutant.mutatorName, mutant.location.start, mutant.location.end,
  mutant.location.end - mutant.location.start > 40 && !['true', 'false'].includes(mutant.replacement) ? '' : normalize(mutant.replacement)].join('|');
function tally(mutants) {
  const counts = new Map();
  for (const mutant of mutants) counts.set(key(mutant), (counts.get(key(mutant)) ?? 0) + 1);
  return counts;
}
async function compare(file) {
  const input = readFileSync(file);
  const reference = (await prepareConventional([{ file, input, selected: () => true }])).mutants.filter(mutant => mutant.status === undefined);
  const builtIn = renderBuiltinSwitches(input, file).mutants;
  const [expected, actual] = [tally(reference), tally(builtIn)];
  return { reference: reference.length,
    missing: [...expected].filter(([entry, count]) => (actual.get(entry) ?? 0) < count).map(([entry]) => entry),
    extra: [...actual].filter(([entry, count]) => (expected.get(entry) ?? 0) < count).map(([entry]) => entry) };
}

const corpus = [
  ...readdirSync('fixtures/mutations').filter(name => /\.(?:ts|tsx|js)$/.test(name)).map(name => `fixtures/mutations/${name}`),
  ...readdirSync('src').filter(name => name.endsWith('.mjs')).map(name => `src/${name}`),
  'fixtures/shipping/src/shipping.ts', 'fixtures/eligibility/src/eligibility.ts', 'fixtures/playwright/src/save.tsx',
];

test('the built-in mutation set equals the StrykerJS set on TypeScript, TSX and JavaScript sources', async () => {
  let total = 0;
  for (const file of corpus) {
    const { reference, missing, extra } = await compare(file);
    total += reference;
    assert.deepEqual({ file, missing, extra }, { file, missing: [], extra: [] });
  }
  assert.ok(total > 12_000, `compared ${total} mutations`);
});

test('every StrykerJS mutator is represented in the fixtures', () => {
  const names = new Set(['sample.ts', 'component.tsx', 'runtime.js'].flatMap(name =>
    collectMutations(readFileSync(`fixtures/mutations/${name}`, 'utf8'), name).map(mutation => mutation.name)));
  assert.deepEqual([...names].sort(), ['ArithmeticOperator', 'ArrayDeclaration', 'ArrowFunction', 'AssignmentOperator', 'BlockStatement',
    'BooleanLiteral', 'CallExpression', 'ConditionalExpression', 'EqualityOperator', 'LogicalOperator', 'MethodExpression',
    'ObjectLiteral', 'OptionalChaining', 'Regex', 'StringLiteral', 'UnaryOperator', 'UpdateOperator']);
});

test('types, imports, enums, declarations, directives and property names are never mutated', () => {
  const source = readFileSync('fixtures/mutations/sample.ts', 'utf8');
  const mutations = collectMutations(source, 'sample.ts');
  const touched = snippet => {
    const at = source.indexOf(snippet);
    assert.ok(at >= 0, snippet);
    return mutations.filter(mutation => mutation.start < at + snippet.length && mutation.end > at && mutation.start >= at - 1).length;
  };
  for (const untouched of ["'./helper'", "declare const ambient: string;", "'circle' | 'square'", 'enum Level { Low = 1 + 1, High = Low * 2 }',
    "'quoted key'", '(limits as { extra?: number }).extra', '[head, ...rest]', '[swapA, swapB] =', '{ min: swapA } =']) {
    assert.equal(touched(untouched), 0, untouched);
  }
  assert.equal(mutations.filter(mutation => mutation.start === 0).length, 0);
  assert.equal(source.slice(...mutations.find(mutation => mutation.name === 'StringLiteral' && mutation.replacement === '"Stryker was here!"').placement), "''");
});

test('a line selection keeps only mutations that lie completely inside it', () => {
  const source = 'export function f(a, b) {\n  if (a > b) {\n    return a - b;\n  }\n  return a + b;\n}\n';
  const all = collectMutations(source, 'f.js');
  const lineThree = collectMutations(source, 'f.js', { selected: line => line === 3 });
  assert.deepEqual(lineThree.map(mutation => [mutation.name, source.slice(mutation.start, mutation.end)]), [['ArithmeticOperator', 'a - b']]);
  const inner = collectMutations(source, 'f.js', { selected: line => line >= 2 && line <= 4 });
  assert.deepEqual(inner.map(mutation => mutation.name).sort(), ['ArithmeticOperator', 'BlockStatement', 'ConditionalExpression',
    'ConditionalExpression', 'EqualityOperator', 'EqualityOperator']);
  assert.ok(all.length > inner.length);
});
