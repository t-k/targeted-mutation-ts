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
// A result is named by the operand it is, so two runs can be compared without sharing objects.
function run(code, inputs, state = {}, recording = false) {
  const context = vm.createContext({ __stryker__: state, inputs, results: [] });
  if (recording) context[session] = { phase: 'baseline' };
  vm.runInContext(`${code}
for (var n = 0; n < inputs.length; n++) {
  __stryker__.currentTestId = ${recording ? "'t' + n" : 'undefined'};
  trace.length = 0;
  var given = inputs[n], out;
  try { out = f.apply(null, given); } catch (error) { out = 'threw ' + error.message; }
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
  const left = expression(next, depth - 1);
  const right = expression(next, depth - 1);
  const kind = next();
  if (kind < 0.1) return `!(${left})`;
  if (kind < 0.2) return `((${left}) ? ${right} : ${expression(next, depth - 1)})`;
  // `??` cannot stand beside `&&` or `||` without parentheses, so every operand has its own.
  return `(${left}) ${pick(['===', '!==', '==', '!=', '&&', '||', '??', '>=', '<'])} (${right})`;
}

test('generated programs: switches off change nothing, a switch is its source edit, and an edit that agreed on an input behaves the same there', () => {
  const pool = [undefined, null, 0, '', false, true, 1, 2, 'x', NaN];
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
        // Not reached, or the edit went another way in this test: nothing is claimed.
        if (counts && counts[1] > 0) continue;
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
  // Without the option the built-in set is as before.
  assert.ok(collectMutations('const f = (a, b) => a === b && a;', 'f.js').every(mutation => !mutation.targeted));
});

test('only the truth of a value is used in a condition, under a negation and through logical operators', () => {
  const contexts = source => Object.fromEntries(collectMutations(source, 'f.js', { targeted: true })
    .filter(mutation => mutation.targeted?.form === 'right').map(mutation => [mutation.targeted.left, mutation.targeted.boolean]));
  assert.deepEqual(contexts('function f(a, b, c, d) { if ((a && b) || c) return 1; while (!(c && d)) c = 1; return a ? b && c : d && a; }'),
    { '(a && b)': true, a: true, c: true, b: false, d: false });
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
  assert.deepEqual(JSON.parse(JSON.stringify(recorded.observed[fallback.id])), { tests: { '': [1, 1] }, agree: ['null', '7'], differ: ['0'], typed: true });
  const active = { activeMutant: fallback.id, hitCount: 0, hitLimit: 1 };
  assert.match((() => { try { return call(output, active); } catch (error) { return error.message; } })(), /hit limit/);
  for (const mutant of mutants) assert.equal(call(output, { activeMutant: mutant.id }), call(edited(source, mutant), {}), mutant.replacement);
});
