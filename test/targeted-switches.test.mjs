import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { renderBuiltinSwitches, targetedOrBoundary } from '../src/builtin-switches.mjs';
import { collectMutations, targetedRules } from '../src/builtin-mutations.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const render = (source, file = 'p.js', options = {}) =>
  renderBuiltinSwitches(Buffer.from(source), file, () => true, { targeted: true, keep: targetedOrBoundary, ...options });
const edited = (source, mutant) => {
  const input = Buffer.from(source);
  return Buffer.concat([input.subarray(0, mutant.source.edit[0]), Buffer.from(mutant.source.replacement), input.subarray(mutant.source.edit[1])]).toString();
};
const session = Symbol.for('targeted-mutation-ts/session');

// Runs `f` on each input as a test of its own and returns what it gave and which operands it evaluated, per input.
// An error is named by its kind: its message quotes the source, which a probe replaces.
// A result is named by the operand it is, so two runs can be compared without sharing objects.
function run(code, inputs, state = {}, recording = false) {
  const context = vm.createContext({ __stryker__: state, inputs, results: [] });
  if (recording) context[session] = { phase: 'baseline' };
  vm.runInContext(`${code}
for (var n = 0; n < inputs.length; n++) {
  __stryker__.currentTestId = ${recording ? "'t' + n" : 'undefined'};
  trace.length = 0;
  var given = inputs[n], out;
  try { out = f.apply(null, given); } catch (error) { out = 'threw ' + error.name; }
  var at = given.indexOf(out);
  results.push(JSON.stringify([at >= 0 && typeof out === 'object' && out !== null ? 'operand ' + at : typeof out + ' ' + String(out), trace.slice()]));
}`, context, { timeout: 2_000 });
  return context.results;
}
const prelude = 'var trace = [];\nfunction see(name, value) { trace.push(name); return value; }\n';

const values = { Undefined: undefined, Null: null, Zero: 0, EmptyText: '', False: false, True: true, One: 1, Text: 'x', Record: { left: 1 } };
const operators = { StrictEq: '===', StrictNe: '!==', LooseEq: '==', LooseNe: '!=', And: '&&', Or: '||', Nullish: '??' };
const forms = { ConstTrue: 'true', ConstFalse: 'false', Loose: 'loose', Strict: 'strict', OtherNullish: 'other', IgnoreLeft: 'left',
  IgnoreRight: 'right', ToOr: 'or', ToNullish: 'nullish' };
const rows = readFileSync(new URL('../verification/pict/targeted-agreement.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));

test('the agreement table has every required case', () => {
  const seeds = readFileSync(new URL('../verification/pict/targeted-agreement.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
  assert.ok(rows.length > 100);
});

for (const [operator, form, context, left, right, written] of rows) {
  test(`agreement: ${left} ${operator} ${right} (${written}) as ${form} in a ${context}`, () => {
    const rightText = written === 'NullLiteral' ? 'null' : written === 'UndefinedLiteral' ? 'undefined' : "see('r', r)";
    const expression = `see('l', l) ${operators[operator]} ${rightText}`;
    const source = prelude + (context === 'Condition' ? `function f(l, r) { if (${expression}) return 'yes'; return 'no'; }\n`
      : `function f(l, r) { return ${expression}; }\n`);
    const rightValue = right === 'Record' ? { right: 1 } : values[right];
    const inputs = [[values[left], rightValue]];
    const { output, mutants } = render(source);
    const mutant = mutants.find(candidate => candidate.targeted?.form === forms[form]);
    assert.ok(mutant, `${form} is offered for ${expression}`);
    assert.equal(mutant.targeted.boolean, context === 'Condition');
    const original = run(source, inputs);
    const state = {};
    // Recording leaves the program as it is.
    assert.deepEqual(run(output, inputs, state, true), original);
    const [agreed, differed] = state.observed[mutant.id].tests.t0;
    assert.equal(agreed + differed, 1);
    // The switch is the edit written into the source.
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten);
    // What was recorded is whether that edit gives the same value after evaluating the same operands.
    assert.equal(agreed === 1, rewritten[0] === original[0], `${original[0]} against ${rewritten[0]}`);
    assert.equal(state.mutantCoverage.perTest.t0[mutant.id], 1);
  });
}

// A small deterministic generator, so a failure names its seed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function expression(next, depth) {
  const pick = list => list[Math.floor(next() * list.length)];
  if (depth === 0 || next() < 0.2) return pick(["see('a', a)", "see('b', b)", "see('c', c)", 'null', 'undefined', '0', "''"]);
  if (next() < 0.15) {
    const inner = expression(next, depth - 1);
    return pick([`Math.max(${inner}, see('b', b))`, `Math.round(${inner})`, `[${inner}, see('c', c)][0]`, `[see('a', a), ${inner}].at(-1)`,
      `[${inner}, 1, see('a', a)].indexOf(1)`, `[${inner}, 2].find(n => n)`]);
  }
  const left = expression(next, depth - 1);
  const right = expression(next, depth - 1);
  const kind = next();
  if (kind < 0.1) return `!(${left})`;
  if (kind < 0.2) return `((${left}) ? ${right} : ${expression(next, depth - 1)})`;
  // `??` cannot stand beside `&&` or `||` without parentheses, so every operand has its own.
  return `(${left}) ${pick(['===', '!==', '==', '!=', '&&', '||', '??', '>=', '<', '+', '-', '*', '/', '%'])} (${right})`;
}

test('generated programs: switches off change nothing, a switch is its source edit, and an edit that agreed on an input behaves the same there', () => {
  const pool = [undefined, null, 0, '', false, true, 1, 2, 'x', NaN, 0.5, -1.5];
  let checked = 0;
  let agreedAndRun = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const body = expression(next, 3);
    const form = seed % 3;
    const source = prelude + (form === 0 ? `function f(a, b, c) { return ${body}; }\n`
      : form === 1 ? `function f(a, b, c) { if (${body}) return 'yes'; return 'no'; }\n`
        : `function f(a, b, c) { let n = 0\n  ${body}\n  return n; }\n`);
    const inputs = Array.from({ length: 8 }, () => [0, 1, 2].map(() => pool[Math.floor(next() * pool.length)]));
    const { output, mutants } = render(source);
    const original = run(source, inputs);
    const state = {};
    assert.deepEqual(run(output, inputs, state, true), original, `seed ${seed}: ${body}`);
    for (const mutant of mutants) {
      const rewritten = run(edited(source, mutant), inputs);
      assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten, `seed ${seed}: ${mutant.original} -> ${mutant.replacement}`);
      checked++;
      if (!mutant.targeted) continue;
      for (const [index] of inputs.entries()) {
        const counts = state.observed?.[mutant.id]?.tests['t' + index];
        // Not reached, the edit went another way in this test, or the probe could not tell: nothing is claimed.
        if (counts && counts[1] + counts[2] > 0) continue;
        agreedAndRun++;
        assert.equal(rewritten[index], original[index], `seed ${seed} input ${index}: ${mutant.original} -> ${mutant.replacement}`);
      }
    }
  }
  assert.ok(checked > 1000, `${checked} switches`);
  assert.ok(agreedAndRun > 3000, `${agreedAndRun} agreeing runs`);
});

test('the targeted edits of each operator, and where none is offered', () => {
  const list = source => collectMutations(source, 'f.ts', { targeted: true }).filter(mutation => mutation.targeted)
    .map(mutation => [mutation.name, mutation.targeted.form, mutation.replacement]);
  assert.deepEqual(list('const f = (a: number, b: number) => a === b;'), [
    [targetedRules.constant, 'true', '(a, b, true)'], [targetedRules.constant, 'false', '(a, b, false)']]);
  assert.deepEqual(list('const f = (a?: string) => a !== undefined;').slice(2), [[targetedRules.nullish, 'loose', 'a != undefined']]);
  assert.deepEqual(list('const f = (a?: string) => null == a;').slice(2), [
    [targetedRules.nullish, 'strict', 'null === a'], [targetedRules.nullish, 'other', 'undefined === a']]);
  assert.deepEqual(list('const f = (a?: string | null) => a != null;').slice(2), [
    [targetedRules.nullish, 'strict', 'a !== null'], [targetedRules.nullish, 'other', 'a !== undefined']]);
  // Two written literals say nothing about a value.
  assert.equal(list('const f = () => null == undefined;').length, 2);
  assert.deepEqual(list('const f = (a: boolean, b: boolean) => a && b;'), [
    [targetedRules.ignored, 'left', '(a, b)'], [targetedRules.ignored, 'right', '(a && (b, true))']]);
  assert.deepEqual(list('const f = (a?: number, b = 1) => a ?? b;'), [
    [targetedRules.ignored, 'left', '(a, b)'], [targetedRules.ignored, 'right', '(a ?? (b, undefined))'], [targetedRules.fallback, 'or', '(a || b)']]);
  assert.deepEqual(list('const f = (a?: number, b = 1) => a || b;').at(-1), [targetedRules.fallback, 'nullish', '(a ?? b)']);
  // As a condition `||` is not taken for `??`, and an operand that is itself an operation keeps its group.
  assert.deepEqual(list('function f(a: unknown, b: unknown) { if (a || b) return 1; }').map(entry => entry[1]), ['left', 'right']);
  assert.deepEqual(list('const f = (a: number, b: number, c: number) => a && b || c;').find(entry => entry[1] === 'nullish')[2], '((a && b) ?? c)');
  // A right operand that awaits or yields cannot move into a function.
  assert.deepEqual(list('async function f(a: unknown, g: () => Promise<number>) { return a && await g(); }'), []);
  assert.deepEqual(list('function* f(a: unknown) { return a || (yield 1); }'), []);
  assert.equal(list('async function f(a: unknown, g: () => Promise<number>) { return a && (async () => await g()); }').length, 2);
  // A direct eval on the right declares its variables where it stands.
  assert.deepEqual(list('function f(flag) { flag && eval("var x = 42"); return typeof x; }'), []);
  // The computed name of a method on the right is evaluated where the expression stands.
  assert.deepEqual(list('async function f(cached: unknown, name: () => Promise<string>) { return cached ?? { [await name()]() {} }; }'), []);
  assert.equal(list('function f(cached: unknown, name: () => string) { return cached ?? { [name()]() {} }; }').length, 3);
  // Where only the truth is used and the written fallback is falsy, `??` and `||` are the same for every value.
  assert.deepEqual(list('function f(n?: number) { if (n ?? 0) return 1; return !(n || false); }').map(entry => entry[1]), ['left', 'right', 'left', 'right']);
  assert.equal(list('function f(n?: number) { if (n ?? 1) return 1; }').at(-1)[1], 'or');
  assert.equal(list('function f(limit?: number) { if (limit ?? -1) return 1; }').at(-1)[1], 'or');
  assert.deepEqual(list('function f(balance?: number) { if (balance ?? -0) return 1; }').map(entry => entry[1]), ['left', 'right']);
  assert.deepEqual(list("function f(n?: string) { if (n ?? '') return 1; if (n || ``) return 2; }").map(entry => entry[1]), ['left', 'right', 'left', 'right']);
  // Without the option the built-in set is as before.
  assert.ok(collectMutations('const f = (a, b) => a === b && a;', 'f.js').every(mutation => !mutation.targeted));
});

test('only the truth of a value is used in a condition, under a negation and through logical operators', () => {
  const contexts = source => Object.fromEntries(collectMutations(source, 'f.js', { targeted: true })
    .filter(mutation => mutation.targeted?.form === 'right').map(mutation => [mutation.targeted.left, mutation.targeted.boolean]));
  assert.deepEqual(contexts('function f(a, b, c, d) { if ((a && b) || c) return 1; while (!(c && d)) c = 1; return a ? b && c : d && a; }'),
    { '(a && b)': true, a: true, c: true, b: false, d: false });
  // The conditions of a loop and of a conditional expression count; what a loop starts with, a branch and an
  // operand of another operator do not.
  assert.deepEqual(contexts('function f(a, b, c, d, e) { for (e && a; a && b;) b = 0; do { c = 0 } while (c && d); return (d && e ? 1 : 2) + -(b && c); }'),
    { e: false, a: true, c: true, d: true, b: false });
  // A value that passes on through `??` or into a call is used as it is.
  assert.deepEqual(contexts('function f(a, b, c) { if (c ?? (a && b)) return 1; return Boolean(b && c); }'), { c: true, a: false, b: false });
});

const placements = {
  'at the start of a statement': 'a && note(1)',
  'after a line without a semicolon': 'const t = a\n  a || note(2)',
  'in a template and a call': 'note(`${a ?? b}`), note(a === b, a != null)',
  'in a class field and a default parameter': 'class C { on = a && b; get(x = a ?? 3) { return x || this.on } }\n  note(new C().get())',
  'around a comment and a line end': 'note(a && // why\n    b)',
  'with a parenthesized object on the right': 'note((a || { b }).b)',
  // A probe inside a probe at the start of a statement is one operand, not two.
  'with a probe inside a probe at the start of a statement': '[a].at(0) && note(3)\n  a === b || note(4)\n  ;[b][0] ?? note(5)',
  // The syntax around the parentheses still applies to what the probe gives.
  'as a template tag, under delete and typeof': 'note(((a && null) || String.raw)`x${b}`, delete (a === b), typeof (a ?? b))',
};
for (const [name, body] of Object.entries(placements)) {
  test(`probe placement: ${name}`, () => {
    const source = `var notes = []\nfunction note() { notes.push([].slice.call(arguments).map(String).join()) }\nfunction f(a, b) {\n  ${body}\n  return notes.join(';')\n}\n`;
    const { output, mutants } = render(source);
    const ts = loadTypeScript();
    const problems = text => ts.createSourceFile('p.js', text, ts.ScriptTarget.Latest, false).parseDiagnostics.length;
    assert.equal(problems(output), 0, output);
    assert.ok(mutants.length >= 2);
    const calls = (code, state = {}) => {
      const context = vm.createContext({ __stryker__: state });
      vm.runInContext(code, context, { timeout: 1_000 });
      return JSON.stringify([[0, 0], [1, 2], [null, 1], [undefined, ''], ['', null]].map(args => {
        context.args = args;
        try {
          return vm.runInContext('notes.length = 0, f(...args)', context, { timeout: 1_000 });
        } catch (error) {
          return error.constructor.name;
        }
      }));
    };
    assert.equal(calls(output), calls(source));
    for (const mutant of mutants) {
      assert.equal(problems(edited(source, mutant)), 0, edited(source, mutant));
      assert.equal(calls(output, { activeMutant: mutant.id }), calls(edited(source, mutant)), `${mutant.original} -> ${mutant.replacement}`);
    }
  });
}

test('a probe keeps this, arguments and typed operands, counts hits like a switch and records only while the baseline runs', () => {
  const source = `class Box<T> { constructor(private v: T | null) {}\n  get(fallback: T) { return this.v ?? fallback; }\n` +
    `  has(...rest: unknown[]) { return arguments.length === 1 && (this.v as T) != null; } }\n` +
    `function f(v: number | null) { const box = new Box(v); return [box.get(7), box.has(1)]; }\n`;
  const { output, mutants } = render(source, 'p.ts');
  const ts = loadTypeScript();
  const js = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const call = (code, state, recording) => {
    const context = vm.createContext({ __stryker__: state });
    if (recording) context[session] = { phase: 'baseline' };
    vm.runInContext(js(code), context);
    return JSON.stringify([vm.runInContext('f(null)', context), vm.runInContext('f(0)', context)]);
  };
  assert.equal(call(source, {}), '[[7,false],[0,true]]');
  const control = {};
  assert.equal(call(output, control), '[[7,false],[0,true]]');
  // Outside the baseline nothing is recorded, and coverage is counted as for any switch.
  assert.equal(control.observed, undefined);
  const fallback = mutants.find(mutant => mutant.mutatorName === targetedRules.fallback);
  assert.equal(control.mutantCoverage.static[fallback.id], 2);
  const recorded = {};
  call(output, recorded, true);
  // Outside a test the observations are kept under an empty name.
  assert.deepEqual(JSON.parse(JSON.stringify(recorded.observed[fallback.id])), { tests: { '': [1, 1, 0] }, agree: ['null', '7'], differ: ['0'], typed: true });
  const active = { activeMutant: fallback.id, hitCount: 0, hitLimit: 1 };
  assert.match((() => { try { return call(output, active); } catch (error) { return error.message; } })(), /hit limit/);
  for (const mutant of mutants) assert.equal(call(output, { activeMutant: mutant.id }), call(edited(source, mutant), {}), mutant.replacement);
});

// A written literal on the right has no effect of its own, so an edit that evaluates it where the original does
// not (or the other way round) agrees whenever the values are the same: `retries ?? 0` with 0 is `retries || 0`.
test('beside a literal right side, agreement is whether the source edit gives the same value', () => {
  const lefts = ['undefined', 'null', '0', "''", 'false', 'true', '1', "'x'", 'NaN', '({})'];
  const rights = ['0', "''", 'false', 'true', 'null', 'undefined', '7', "'x'", '-1', '`t`'];
  let cases = 0;
  let agreeing = 0;
  for (const operator of ['&&', '||', '??']) {
    for (const right of rights) {
      for (const condition of [false, true]) {
        const source = prelude + (condition ? `function f(l) { if (l ${operator} ${right}) return 'yes'; return 'no'; }\n` : `function f(l) { return l ${operator} ${right}; }\n`);
        const { output, mutants } = render(source);
        assert.ok(mutants.length >= 2, source);
        // Signed zeros are different values: `1 / (x ?? 0)` is not `1 / (x || 0)` for -0.
        if (operator === '??' && right === '0' && !condition) {
          const zero = {};
          run(output, [[-0]], zero, true);
          assert.deepEqual([...zero.observed[mutants.find(mutant => mutant.targeted.form === 'or').id].tests.t0], [0, 1, 0]);
        }
        const context = vm.createContext({});
        const inputs = lefts.map(left => [vm.runInContext(`(${left})`, context)]);
        const original = run(source, inputs);
        const state = {};
        assert.deepEqual(run(output, inputs, state, true), original);
        for (const mutant of mutants) {
          assert.equal(mutant.targeted.pureRight, true);
          const rewritten = run(edited(source, mutant), inputs);
          assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten, `${mutant.original} -> ${mutant.replacement}`);
          for (const [index, left] of lefts.entries()) {
            const [agreed] = state.observed[mutant.id].tests['t' + index];
            assert.equal(agreed === 1, rewritten[index] === original[index], `${left}: ${mutant.original} -> ${mutant.replacement}`);
            cases++;
            agreeing += agreed;
          }
        }
      }
    }
  }
  assert.ok(cases >= 1400 && agreeing > 300 && agreeing < cases - 300, `${agreeing} of ${cases}`);
  assert.ok(render('function f(a) { return a ?? -1n; }').mutants.every(mutant => mutant.targeted.pureRight));
  // Anything else on the right may have an effect, and is not evaluated to compare.
  assert.ok(render('function f(a, b) { return a ?? b.c; }').mutants.every(mutant => !mutant.targeted.pureRight));
});

test('a boolean on the left counts as a value that has a falsy one for both fallback edits', () => {
  const source = prelude + 'function f(l) { return l || 7; }\n';
  const { output, mutants } = render(source);
  const state = {};
  run(output, [[true]], state, true);
  assert.equal(state.observed[mutants.find(mutant => mutant.targeted.form === 'nullish').id].typed, true);
});

test('a probe uses nothing a module or a test can replace: a local Symbol, a spied JSON.stringify or String', () => {
  const source = `const Symbol = { Plus: '+' }; const String = () => { throw new Error('String called'); };
function f(token) { return token === Symbol.Plus || token; }\n`;
  const { output, mutants } = render(source);
  const context = vm.createContext({ __stryker__: { currentTestId: 't' } });
  context[session] = { phase: 'baseline' };
  vm.runInContext(`let stringified = 0; JSON.stringify = () => { stringified++; return ''; };\n${output}\nvar out = [f('+'), f('a"b'), f(3), f(undefined), stringified];`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.out)), [true, 'a"b', 3, null, 0]);
  const strict = mutants.find(mutant => mutant.targeted.form === 'false' && mutant.original.includes('==='));
  assert.deepEqual(JSON.parse(JSON.stringify(context.__stryker__.observed[strict.id].agree)), ['"a"b"', '"+"']);
});

test('a right side that throws is still an observation: an edit that would not have evaluated it differs', () => {
  const source = prelude + "function f(l, r) { try { return l || r(); } catch (error) { return 'caught'; } }\n";
  const { output, mutants } = render(source);
  const fail = () => { throw new Error('required'); };
  const state = {};
  assert.deepEqual(run(output, [['/etc/app.json', fail], ['', fail]], state, true), run(source, [['/etc/app.json', fail], ['', fail]]));
  const seen = form => JSON.parse(JSON.stringify(state.observed[mutants.find(mutant => mutant.targeted.form === form).id].tests));
  // `??` returns '' without calling; with the left side ignored the call is made in both tests; with the right
  // side's value ignored the call is still made and throws as before.
  assert.deepEqual(seen('nullish'), { t0: [1, 0, 0], t1: [0, 1, 0] });
  assert.deepEqual(seen('left'), { t0: [0, 1, 0], t1: [1, 0, 0] });
  assert.deepEqual(seen('right'), { t0: [1, 0, 0], t1: [1, 0, 0] });
});

test('a written null or undefined on the left is found there, and the edits say for which value they differ', () => {
  const source = prelude + "function f(l) { return [null == see('l', l), undefined !== see('l', l)]; }\n";
  const { output, mutants } = render(source);
  const describe = mutants.filter(mutant => mutant.targeted.literalSide !== undefined)
    .map(mutant => [mutant.replacement, mutant.targeted.literalSide, mutant.targeted.differsFor, mutant.targeted.subject]);
  assert.deepEqual(describe, [["null === see('l', l)", 0, 'undefined', "see('l', l)"], ["undefined === see('l', l)", 0, 'null', "see('l', l)"],
    ["undefined != see('l', l)", 0, 'null', "see('l', l)"]]);
  const inputs = [[null], [undefined], [0]];
  const original = run(source, inputs);
  const state = {};
  assert.deepEqual(run(output, inputs, state, true), original);
  for (const mutant of mutants) {
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten, mutant.replacement);
    if (mutant.targeted.literalSide === undefined) continue;
    // An array holds both comparisons, so the whole result differs exactly where this comparison does.
    for (const [index] of inputs.entries()) {
      assert.equal(state.observed[mutant.id].tests['t' + index][0] === 1, rewritten[index] === original[index], `${mutant.replacement} for input ${index}`);
    }
  }
  // Only the fallback edits ask for a typed left side, and only a probe of a logical operator wraps its right side.
  const flags = text => render(text).mutants.map(mutant => [mutant.targeted.form, mutant.targeted.evidence === true, mutant.targeted.thunk === true]);
  assert.deepEqual(flags('const f = (a, b) => a ?? b;'), [['left', false, true], ['right', false, true], ['or', true, true]]);
  assert.deepEqual(flags('const f = (a, b) => a === b;'), [['true', false, false], ['false', false, false]]);
});

const operations = {
  Add: (l, r) => `${l} + ${r}`, Sub: (l, r) => `${l} - ${r}`, Mul: (l, r) => `${l} * ${r}`, Div: (l, r) => `${l} / ${r}`, Rem: (l, r) => `${l} % ${r}`,
  Max: (l, r) => `Math.max(${l}, ${r})`, Min: (l, r) => `Math.min(${l}, ${r})`,
  Floor: l => `Math.floor(${l})`, Ceil: l => `Math.ceil(${l})`, Round: l => `Math.round(${l})`, Trunc: l => `Math.trunc(${l})`,
  IndexFirst: l => `${l}[0]`, AtFirst: l => `${l}.at(0)`, AtLast: l => `${l}.at(-1)`, IndexLast: () => 'l[l.length - 1]',
  Find: (l, r) => `${l}.find(${r})`, FindLast: (l, r) => `${l}.findLast(${r})`, FindIndex: (l, r) => `${l}.findIndex(${r})`,
  FindLastIndex: (l, r) => `${l}.findLastIndex(${r})`, IndexOf: (l, r) => `${l}.indexOf(${r})`, LastIndexOf: (l, r) => `${l}.lastIndexOf(${r})`,
};
const operands = {
  Zero: 0, One: 1, MinusOne: -1, Two: 2, Half: 0.5, MinusHalf: -0.5, NotANumber: NaN, Digits: '7', Record: { valueOf: undefined },
  Empty: [], Single: [3], Pair: [1, 2], Repeated: [5, 5], Mixed: [1, 2, 1, 4], Letters: 'aba', Lookalike: { 0: 'x', length: 1 },
  SearchPresent: 1, SearchAbsent: 9, IsOdd: n => n % 2 === 1, Unused: undefined,
};
// For these the probe works the edit out again, so what it records is exact. A search callback is not run again,
// and an object among arithmetic operands is not converted again: there a recorded difference may be none.
// Neither is text given to a function of Math.
// Nor is the end of something that is neither an array nor text read again.
const exact = (operation, left, right) => !operation.startsWith('Find') && left !== 'Record' && right !== 'Record' && left !== 'Lookalike' &&
  !(['Max', 'Min', 'Floor', 'Ceil', 'Round', 'Trunc'].includes(operation) && [left, right].includes('Digits'));
const valueRows = readFileSync(new URL('../verification/pict/targeted-values.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));

test('the value table has every required case', () => {
  const seeds = readFileSync(new URL('../verification/pict/targeted-values.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(valueRows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
});

for (const [operation, which, left, right, placement] of valueRows) {
  test(`value agreement: ${operation} of ${left} and ${right}, ${which} edit, ${placement}`, () => {
    const expression = operations[operation]("see('l', l)", "see('r', r)");
    const grouped = operations[operation].length === 2 && !expression.includes('(' + "see('l'") && !expression.startsWith('Math') ? `(${expression})` : expression;
    const body = { Returned: `return ${expression};`, Condition: `if (${expression}) return 'yes'; return 'no';`,
      Member: `return typeof ${/^see\('l', l\) [-+*\/%] /.test(expression) ? grouped : expression}.valueOf;`, Argument: `return wrap(${expression});` }[placement];
    const source = prelude + `function wrap(value) { return 'wrapped ' + typeof value + ' ' + String(value); }\nfunction f(l, r) { ${body} }\n`;
    const { output, mutants } = render(source);
    const mutant = mutants[{ First: 0, Second: 1, Third: 2 }[which]];
    assert.ok(mutant?.targeted, `${which} edit of ${expression}: ${mutants.map(candidate => candidate.replacement).join(' | ')}`);
    const inputs = [[operands[left], operands[right]]];
    const original = run(source, inputs);
    const state = {};
    assert.deepEqual(run(output, inputs, state, true), original);
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten, `${mutant.original} -> ${mutant.replacement}`);
    const [agreed, differed, unsure] = state.observed[mutant.id].tests.t0;
    assert.equal(agreed + differed + unsure, 1);
    // An agreement is never wrong. Where the probe can work the edit out it always says which, and a difference
    // is never wrong either. (An operation that throws is recorded as a difference whatever the edit does.)
    if (agreed) assert.equal(rewritten[0], original[0]);
    if (exact(operation, left, right)) assert.equal(unsure, 0);
    else if (operation.startsWith('Find') && operands[left].length > 1 && Array.isArray(operands[left])) assert.equal(unsure, 1);
    if (differed && placement !== 'Condition' && placement !== 'Member' && !original[0].includes('threw')) assert.notEqual(rewritten[0], original[0]);
  });
}

test('the edits of arithmetic, of Math and of the ends of a sequence, and where none is offered', () => {
  const list = source => collectMutations(source, 'f.ts', { targeted: true }).filter(mutation => mutation.targeted)
    .map(mutation => [mutation.name, mutation.targeted.operator, mutation.targeted.form, mutation.replacement]);
  const texts = source => list(source).map(entry => entry[3]);
  assert.deepEqual(list('const f = (a: number, b: number) => a + b;'), [
    [targetedRules.arithmetic, '+', '-', '(a - b)'], [targetedRules.arithmetic, '+', '*', '(a * b)']]);
  // An operand that is an operation keeps its group under the other operator.
  assert.deepEqual(texts('const f = (a: number, b: number, c: number) => a - b * c;'), ['(a + (b * c))', '(a / (b * c))', '(b / c)', '(b + c)']);
  // Text is joined, not added.
  assert.deepEqual(texts("const f = (a: string) => 'id-' + a + `-${a}`;"), []);
  assert.deepEqual(list('const f = (a: number, b: number) => Math.max(a, b) - Math.min(a, 0);').filter(entry => entry[0] === targetedRules.extreme), [
    [targetedRules.extreme, 'max', 'min', 'Math.min(a, b)'], [targetedRules.extreme, 'min', 'max', 'Math.max(a, 0)']]);
  assert.deepEqual(texts('const f = (a: number) => [Math.floor(a), Math.ceil(a), Math.round(a), Math.trunc(a)];'), [
    'Math.ceil(a)', 'Math.round(a)', 'Math.trunc(a)', 'Math.floor(a)', 'Math.round(a)', 'Math.floor(a)', 'Math.ceil(a)', 'Math.floor(a)', 'Math.round(a)']);
  // A comment or a string that says Math binds nothing.
  assert.equal(texts('// Uses Math\nconst note = "Math"; export const f = (x: number) => Math.floor(x);').length, 3);
  assert.deepEqual(texts('import { Math } from "./lib"; export const f = (x: number) => Math.floor(x);'), []);
  assert.deepEqual(texts('const { Math } = lib; export const f = (x: number) => Math.round(x);'), []);
  // A name Math of the file's own is not the built-in one.
  assert.deepEqual(texts('function f(Math: { max(a: number, b: number): number }) { return Math.max(1, 2); }'), []);
  // Only the two-argument forms of max and min, without a spread, on Math itself.
  assert.deepEqual(texts('const f = (a: number[], m: typeof Math) => [Math.max(...a), Math.max(1, 2, 3), Math.min(1), m.max(1, 2), Math.floor(1, 2), Math?.round(1)];'), []);
  assert.deepEqual(list('const f = (a: number[], g: (n: number) => boolean) => [a[0], a.at(0), a.at(-1), a[a.length - 1], a.find(g), a.findLastIndex(g), a.lastIndexOf(1)];')
    .map(entry => entry.slice(1)), [['idx0', 'at-1', 'a.at(-1)'], ['at0', 'at-1', 'a.at(-1)'], ['at-1', 'at0', 'a.at(0)'], ['idxLast', 'idx0', 'a[0]'],
    ['find', 'findLast', 'a.findLast(g)'], ['findLastIndex', 'findIndex', 'a.findIndex(g)'], ['lastIndexOf', 'indexOf', 'a.indexOf(1)']]);
  // The index of a last element is worked out by its probe and holds no edit of its own.
  assert.deepEqual(texts('const f = (o: { items: number[] }) => o.items[o.items.length - 1] + 1;'), ['(o.items[o.items.length - 1] - 1)', '(o.items[o.items.length - 1] * 1)', 'o.items[0]']);
  // Reading the sequence twice must give the same: a call, or another sequence in the index, is no last element.
  assert.deepEqual(texts('const f = (g: () => number[], a: number[], b: number[]) => [g()[g().length - 1], a[b.length - 1], a[a.length - 2]];')
    .filter(text => !/[-+*\/] [12]\)$/.test(text)), []);
  // An element that is written, removed, called or reached through `?.` stays as it is.
  assert.deepEqual(texts('function f(a: any[], o: any) { a[0] = 1; a[0]++; delete a[0]; a[0](); a[0]`x`; [a[0]] = [1]; for (a[0] of a) {} return [o?.[0], o?.a[0], a.at(1), a.at(), a.find(), a.indexOf(1, 2), a.find(...a)]; }'), []);
  assert.deepEqual(texts('class B extends Array<number> { first() { return super.find(n => n > 0); } }').filter(text => text.includes('find')), []);
  assert.deepEqual(texts('const f = (a: number[][]) => a[0][0].toFixed();'), ['a[0].at(-1)', 'a.at(-1)']);
  // A method that only shares its name with a property every object has is no end of a sequence.
  assert.deepEqual(texts('const f = (n: number, o: object) => [n.toString(16), o.valueOf(), o.hasOwnProperty("a"), o.constructor(1)];'), []);
  // A non-null assertion does not hide that the element is called or written, and a constructor is not read by `at`.
  assert.deepEqual(texts('function f(handlers: any[], parsers: any[]) { handlers[0]!(); handlers[0]! = 1; handlers[0]!++; return new parsers[0](); }'), []);
  assert.deepEqual(texts('const f = (a: number[]) => a[0]! + 1;').at(-1), 'a.at(-1)');
});

const valueHazards = {
  'an element that is written, removed and called beside one that is read': 'var a = [3, 4, 5]; var o = { list: [function () { return this === o.list; }] }; a[0] = a[0] + 1; a[0]++; delete a[2]; var result = [a[0], a.length, o.list[0](), a[a.length - 1]]',
  'a last element of a property chain and of this': 'var o = { items: [1, 2, 3], last() { return this.items[this.items.length - 1]; } }; var result = [o.items[o.items.length - 1], o.last()]',
  'arithmetic beside its neighbours': 'var a = 7, b = 2, c = 3; var result = [a - b * c, a * b - c, a / b / c, -a - -b, a % b + c, a + b + "x", 2 ** a - 1]',
  'the functions of Math on numbers and on other values': 'var result = [Math.max(1, 2), Math.min("3", 2), Math.floor(-0.5), Math.round(2.5), Math.trunc("7.9"), Math.ceil(null), String(Math.max(0, -0))]',
  'the ends of text, of an empty array and of an array-like': 'var like = { 0: "x", length: 1 }; var result = ["ab"[0], "ab".at(-1), [].at(0), [][0], like[0], [1, 2, 1].indexOf(1), "aba".lastIndexOf("a"), [1, 2, 3].find(function (n) { return n > 1; }), [4, 5].findLastIndex(function (n) { return n > 9; })]',
  'a search whose callback counts its calls': 'var calls = 0; var found = [1, 2, 3].find(function (n) { calls++; return n > 1; }); var result = [found, calls]',
};
for (const [name, source] of Object.entries(valueHazards)) {
  test(`value probes preserve ${name}`, () => {
    const evaluate = (code, state = {}, recording = false) => {
      const context = vm.createContext({ __stryker__: state });
      if (recording) context[session] = { phase: 'baseline' };
      try {
        vm.runInContext(code, context, { timeout: 1_000 });
        return JSON.stringify(context.result);
      } catch (error) {
        return error.constructor.name;
      }
    };
    const rendered = render(source, 'hazard.js');
    const expected = evaluate(source);
    assert.doesNotMatch(expected, /Error$/, expected);
    assert.ok(rendered.mutants.length > 0);
    assert.equal(evaluate(rendered.output), expected, rendered.output);
    // Recording works the edits out again and must not be seen by the program.
    assert.equal(evaluate(rendered.output, {}, true), expected);
    for (const mutant of rendered.mutants) {
      assert.equal(evaluate(rendered.output, { activeMutant: mutant.id }), evaluate(edited(source, mutant)), `${mutant.original} -> ${mutant.replacement}`);
    }
  });
}

test('the edits of a sort, an awaited call and a copy, and where none is offered', () => {
  const list = source => collectMutations(source, 'f.ts', { targeted: true }).filter(mutation => mutation.targeted && [targetedRules.order, targetedRules.awaited, targetedRules.copy].includes(mutation.name))
    .map(mutation => [mutation.name, mutation.replacement]);
  assert.deepEqual(list('const f = (a: number[]) => [a.sort((x, y) => x - y), a.toSorted((x, y) => (x) - (y))];'), [
    [targetedRules.order, 'a.sort()'], [targetedRules.order, 'a.toSorted()']]);
  // Only the comparison of two numbers in ascending order: without it a descending sort or a sort by a field is another program at once.
  assert.deepEqual(list('const f = (a: any[], by: any) => [a.sort((x, y) => y - x), a.sort((x, y) => x.n - y.n), a.sort(by), a.sort(), a.sort((x, y) => { return x - y; }), a.sort(function (x, y) { return x - y; }), a.sort((x, y = 0) => x - y)];'), []);
  assert.deepEqual(list('async function f(g: () => Promise<void>, o: { h(): Promise<void> }) { await g(); await o.h(); const kept = await g(); return await g(); }'), [
    [targetedRules.awaited, 'g();'], [targetedRules.awaited, 'o.h();']]);
  // Only a call is left to go on alone, and one that could continue the line before is left as it is.
  assert.deepEqual(list('async function f(p: Promise<void>, g: any) { await p; await (g)(); await [g][0](); for await (const x of g()) {} }'), []);
  assert.deepEqual(list('const f = (a: number[], o: object) => [[...a], { ...o }];'), [[targetedRules.copy, '(a)'], [targetedRules.copy, '(o)']]);
  // A literal with anything beside the spread is not a copy, and a pattern on the left is no literal.
  assert.deepEqual(list('function f(a: number[], o: any) { let rest; [...rest] = a; ({ ...rest } = o); return [[...a, 1], [0, ...a], { ...o, k: 1 }, [], {}, [a], { o }]; }'), []);
});

test('a sort without its comparison agrees exactly when numbers and text keep their order as text', () => {
  const lists = [[3, 1, 2], [9, 10], [10, 9, 1], [], [5], [-1, -2], [1, 10, 2], ['b', 'a'], [2, 'a', 1], [0.5, 0.25], [1, , 3], [{ n: 1 }, { n: 2 }], [3, null], [1, 1]];
  for (const method of ['sort', 'toSorted']) {
    const source = prelude + `function f(l) { var given = l.slice(); var out = given.${method}((a, b) => a - b); return JSON.stringify([out, given, out === given]); }\n`;
    const { output, mutants } = render(source);
    const mutant = mutants.find(candidate => candidate.mutatorName === targetedRules.order);
    assert.ok(mutant, method);
    const inputs = lists.map(list => [list]);
    const original = run(source, inputs);
    const state = {};
    // Recording sorts a copy of its own and leaves the program's array to the program.
    assert.deepEqual(run(output, inputs, state, true), original);
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten);
    const recorded = lists.map((_, index) => [...state.observed[mutant.id].tests['t' + index]].join(''));
    // 100: agrees, 010: differs, 001: cannot tell. Only a hole, an object or null keeps the probe from telling.
    assert.deepEqual(recorded.map(code => code === '001'), lists.map(list => !Array.from(list, item => typeof item).every(type => type === 'number' || type === 'string') || list.includes(undefined)), method);
    for (const [index, code] of recorded.entries()) if (code !== '001') assert.equal(code === '100', rewritten[index] === original[index], `${method} of ${JSON.stringify(lists[index])}`);
    assert.deepEqual([recorded[0], recorded[1], recorded[5]], ['100', '010', '010']);
  }
});

test('an awaited call left to go on alone and a copy that is the original are the edits written into the source', async () => {
  const source = `var log = [];
async function slow(name) { await null; log.push(name); }
async function f(a) { await slow('one'); log.push('after'); const copy = [...a]; copy.push(9); const record = { ...{ n: a.length } }; return JSON.stringify([log, a, copy, record]); }
`;
  const { output, mutants } = render(source);
  const call = async (code, state = {}) => {
    const context = vm.createContext({ __stryker__: state });
    vm.runInContext(code, context);
    const result = await vm.runInContext('f([1])', context);
    await new Promise(resolveLater => setImmediate(resolveLater));
    return result;
  };
  const original = await call(source);
  assert.equal(original, '[["one","after"],[1],[1,9],{"n":1}]');
  assert.equal(await call(output), original);
  const results = {};
  for (const mutant of mutants.filter(candidate => [targetedRules.awaited, targetedRules.copy].includes(candidate.mutatorName))) {
    results[mutant.replacement] = await call(output, { activeMutant: mutant.id });
    assert.equal(results[mutant.replacement], await call(edited(source, mutant)), mutant.replacement);
  }
  // Not waited for, the call ends after what follows it; without the copy the push reaches the caller's array.
  assert.deepEqual(results, { "slow('one');": '[["after"],[1],[1,9],{"n":1}]', '(a)': '[["one","after"],[1,9],[1,9],{"n":2}]',
    '({ n: a.length })': original });
});
