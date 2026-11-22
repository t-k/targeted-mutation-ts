import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { renderOperatorSwitches } from '../src/operator-switches.mjs';

function load(source, state = {}) {
  const { output, mutants } = renderOperatorSwitches(Buffer.from(source), 'subject.js');
  const context = vm.createContext({ __stryker__: state, result: undefined });
  vm.runInContext(output, context);
  return { output, mutants, context, state, call: expression => vm.runInContext(expression, context) };
}
const byOperator = (mutants, operator, nth = 0) => mutants.filter(mutant => mutant.original === operator)[nth];

test('an inactive switch keeps the original result and records which test reached it', () => {
  const state = {};
  const { mutants, call } = load('function price(q, unit, member) { const total = q * unit; if (member === true && total >= 100) return total - 10; return total; }', state);
  assert.deepEqual(mutants.map(mutant => [mutant.mutatorName, mutant.original, mutant.replacement]), [
    ['arithmetic-operator/v1', '*', '/'], ['equality-negation/v1', '===', '!=='],
    ['logical-operator/v1', '&&', '||'], ['arithmetic-operator/v1', '-', '+'],
  ]);
  assert.equal(call('price(2, 30, false)'), 60);
  state.currentTestId = 'test-a';
  assert.equal(call('price(4, 30, true)'), 110);
  const [multiply, equal, and, minus] = mutants.map(mutant => mutant.id);
  assert.deepEqual(JSON.parse(JSON.stringify(state.mutantCoverage.static)), { [multiply]: 1, [and]: 1, [equal]: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(state.mutantCoverage.perTest)), { 'test-a': { [multiply]: 1, [and]: 1, [equal]: 1, [minus]: 1 } });
});

test('activating one edit changes exactly that operator', () => {
  const source = 'function price(q, unit, member) { const total = q * unit; if (member === true && total >= 100) return total - 10; return total; }';
  const expected = { '*': [2 / 30, 4 / 30], '===': [60, 120], '&&': [60, 110], '-': [60, 130] };
  for (const [operator, [plain, member]] of Object.entries(expected)) {
    const state = {};
    const { mutants, call } = load(source, state);
    state.activeMutant = byOperator(mutants, operator).id;
    assert.equal(call('price(2, 30, false)'), plain, operator);
    assert.equal(call('price(4, 30, true)'), member, operator);
  }
});

test('nested operators switch independently and operands are evaluated once', () => {
  const source = 'let calls = 0; const next = () => ++calls; function f(a, b, c) { return a + b * c - next() || a % c; }';
  const plain = load(source);
  assert.equal(plain.call('f(1, 2, 3)'), 6);
  assert.equal(plain.call('calls'), 1);
  assert.equal(plain.mutants.length, 5);
  const results = {};
  for (const mutant of plain.mutants) {
    const state = { activeMutant: mutant.id };
    const active = load(source, state);
    results[`${mutant.original}@${mutant.location.column}`] = active.call('f(1, 2, 3)');
    assert.equal(active.call('calls'), 1);
  }
  assert.deepEqual(Object.values(results), [-6, 1 + 2 / 3 - 1, 8, 1, 6]);
});

test('a statement that starts with an operator expression cannot attach to the previous line', () => {
  const { call, mutants, output } = load('let hits = 0\nconst ready = true\nready === true && hits++\nhits + 1\n');
  assert.equal(call('hits'), 1);
  assert.equal(mutants.length, 3);
  assert.match(output, /\n__tmtOn\("[0-9a-f]{16}"\) \? ready === true \|\| hits\+\+ : \(__tmtCover/);
});

test('the hit limit stops a loop that an edit makes endless', () => {
  const source = 'function count(n) { let i = 0; while (i - n) i++; return i; }';
  const state = {};
  const { mutants, call } = load(source, state);
  Object.assign(state, { activeMutant: mutants[0].id, hitCount: 0, hitLimit: 50 });
  assert.throws(() => call('count(3)'), /Edit hit limit reached \(51\)/);
});

test('line selection, enum members and existing helper names are respected', () => {
  const lines = renderOperatorSwitches(Buffer.from('const a = 1 + 2;\nconst b = 3 * 4;\n'), 'a.ts', line => line === 2);
  assert.deepEqual(lines.mutants.map(mutant => [mutant.original, mutant.location.line, mutant.location.column]), [['*', 2, 13]]);
  assert.ok(lines.output.startsWith('const a = 1 + 2;\nconst b = (__tmtOn('));
  const untouched = renderOperatorSwitches(Buffer.from('const a = 1 + 2;\n'), 'a.ts', () => false);
  assert.deepEqual(untouched, { output: 'const a = 1 + 2;\n', mutants: [] });
  const constant = renderOperatorSwitches(Buffer.from('const enum Size { Small = 1 + 1, Large = Small * 2 }\nexport const n = Size.Large - 1;'), 'a.ts');
  assert.deepEqual(constant.mutants.map(mutant => mutant.original), ['-']);
  const taken = renderOperatorSwitches(Buffer.from('const __tmtOn = 1, __tmtCover = 2; const c = __tmtOn + __tmtCover;'), 'a.js');
  assert.match(taken.output, /function __tmtOn_\(id\)[\s\S]*function __tmtCover_\(id\)/);
  assert.match(taken.output, /\(__tmtOn_\("/);
});

test('edit ids are stable for a file and distinct within it', () => {
  const first = renderOperatorSwitches(Buffer.from('export const f = (a, b) => a + b - a + b;'), 'f.js');
  const again = renderOperatorSwitches(Buffer.from('export const f = (a, b) => a + b - a + b;'), 'f.js');
  assert.deepEqual(first.mutants.map(mutant => mutant.id), again.mutants.map(mutant => mutant.id));
  assert.equal(new Set(first.mutants.map(mutant => mutant.id)).size, 3);
  assert.notDeepEqual(renderOperatorSwitches(Buffer.from('export const f = (a, b) => a + b - a + b;'), 'g.js').mutants[0].id, first.mutants[0].id);
});
