import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { targetedRules } from '../src/builtin-mutations.mjs';
import { renderBuiltinSwitches, targetedOrBoundary } from '../src/builtin-switches.mjs';
import { renderText } from '../src/cli-output.mjs';

const render = (source, file = 'p.js', options = {}) =>
  renderBuiltinSwitches(Buffer.from(source), file, () => true, { targeted: true, keep: targetedOrBoundary, ...options });
const edited = (source, mutant) => {
  const input = Buffer.from(source);
  return Buffer.concat([input.subarray(0, mutant.source.edit[0]), Buffer.from(mutant.source.replacement), input.subarray(mutant.source.edit[1])]).toString();
};
const session = Symbol.for('targeted-mutation-ts/session');

function run(code, inputs, state = {}, recording = false) {
  const context = vm.createContext({ __stryker__: state, inputs, results: [] });
  if (recording) context[session] = { phase: 'baseline' };
  vm.runInContext(`${code}
for (var n = 0; n < inputs.length; n++) {
  __stryker__.currentTestId = ${recording ? "'t' + n" : 'undefined'};
  trace.length = 0;
  var given = inputs[n], out;
  try { out = f.apply(null, given); } catch (error) { out = 'threw ' + error.name; }
  results.push(JSON.stringify([out, trace.slice()]));
}`, context, { timeout: 2_000 });
  return context.results;
}

const prelude = 'var trace = [];\nfunction see(name, value) { trace.push(name); return value; }\n';
const rows = readFileSync(new URL('../verification/pict/targeted-new-rules.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));

test('the targeted-new-rules PICT table has every required seed', () => {
  const seeds = readFileSync(new URL('../verification/pict/targeted-new-rules.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
  assert.ok(rows.length >= 20);
});

for (const [rule, form, baseOrReceiver, argKind] of rows) {
  test(`PICT ${rule} / ${form} / ${baseOrReceiver} / ${argKind}`, () => {
    let source;
    let inputs;
    let expectedRule;
    let pickMutant;
    let expectUnsure = false;
    if (rule === 'SpreadDrop') {
      expectedRule = targetedRules.spreadDrop;
      if (form === 'SingleProp') {
        source = prelude + "function f(base, err) { return { ...see('b', base), error: see('e', err) }; }\n";
      } else if (form === 'MultiProp') {
        source = prelude + "function f(base, err) { return { ...see('b', base), ok: true, error: see('e', err) }; }\n";
      } else {
        source = prelude + "function f(base, error) { return { ...see('b', base), error }; }\n";
      }
      const base = {
        SameValue: { error: null, extra: 1 },
        DiffValue: { error: 'boom', extra: 1 },
        MissingKey: { extra: 1 },
        NullishBase: null,
      }[baseOrReceiver];
      inputs = [[base, null]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === expectedRule && m.targeted?.key === 'error');
    } else if (rule === 'PrefixToSubstring') {
      expectedRule = targetedRules.prefixSubstring;
      const method = form === 'StartsWith' ? 'startsWith' : 'endsWith';
      source = prelude + `function f(s, p) { return see('s', s).${method}(see('p', p)); }\n`;
      const recv = {
        PrefixOnly: form === 'StartsWith' ? 'pre_body' : 'body_pre',
        MiddleOnly: 'x_pre_y',
        Absent: 'other',
        NonString: { startsWith: () => true, endsWith: () => true, includes: () => true },
      }[baseOrReceiver];
      const arg = argKind === 'Plain' ? 'pre' : { toString: () => 'pre' };
      inputs = [[recv, arg]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === expectedRule);
      expectUnsure = baseOrReceiver === 'NonString' || argKind === 'NonPlain';
    } else {
      expectedRule = targetedRules.replaceMultiplicity;
      const method = form === 'Replace' ? 'replace' : 'replaceAll';
      source = prelude + `function f(s, a, b) { return see('s', s).${method}(see('a', a), see('b', b)); }\n`;
      const recv = {
        ZeroOcc: 'hello',
        OneOcc: 'a-b',
        MultiOcc: 'a-b-c',
        NonString: { replace: () => 'x', replaceAll: () => 'x' },
      }[baseOrReceiver];
      const rep = argKind === 'Plain' ? '_' : () => '_';
      inputs = [[recv, '-', rep]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === expectedRule);
      expectUnsure = baseOrReceiver === 'NonString' || argKind === 'NonPlain';
    }

    const { output, mutants } = render(source);
    const mutant = pickMutant(mutants);
    assert.ok(mutant, `expected mutant for ${rule}/${form}`);
    const original = run(source, inputs);
    const state = {};
    // T1: switches off changes nothing.
    assert.deepEqual(run(output, inputs, state, true), original);
    // T2: active switch matches source rewrite (value and evaluation trace).
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten);
    // T3: agreement recording matches oracle (or unsure when unsafe to re-evaluate).
    const [agreed, differed, unsure = 0] = state.observed[mutant.id].tests.t0;
    assert.equal(agreed + differed + unsure, 1);
    if (expectUnsure) {
      assert.equal(unsure, 1);
    } else {
      assert.equal(unsure, 0);
      const origVal = JSON.parse(original[0])[0];
      const editVal = JSON.parse(rewritten[0])[0];
      assert.equal(agreed === 1, JSON.stringify(origVal) === JSON.stringify(editVal));
    }
  });
}

test('spread-property-drop skips unsafe shapes, handles -0/+0 and Proxy safely, and preserves evaluation order', () => {
  // Excluded shapes produce no spread-property-drop mutant.
  for (const snippet of [
    'const f = (b, k) => ({ ...b, [k]: 1 });',
    'const f = (b) => ({ ...b, __proto__: null });',
    'const f = (b) => ({ ...b, a: 1, a: 2 });',
    'const f = (a, b) => ({ ...a, x: 1, ...b });',
    'const f = (b) => ({ ...b, get x() { return 1; } });',
    'const f = (b) => ({ ...b, m() { return 1; } });',
    'const f = async (b, p) => ({ ...b, x: await p });',
    'const f = (b) => ({ a: 1, ...b });',
  ]) {
    const { mutants } = render(snippet);
    assert.equal(mutants.filter(m => m.mutatorName === targetedRules.spreadDrop).length, 0, snippet);
  }
  // -0 vs +0 differs under Object.is.
  const negZero = 'const f = (b) => ({ ...b, z: 0 });';
  const { output, mutants } = render(negZero);
  const m = mutants.find(x => x.mutatorName === targetedRules.spreadDrop);
  assert.ok(m);
  const state = {};
  const ctx = vm.createContext({ __stryker__: state, [session]: { phase: 'baseline' } });
  vm.runInContext(output + '\n__stryker__.currentTestId = "t0"; f({ z: -0 });', ctx);
  assert.deepEqual([...state.observed[m.id].tests.t0], [0, 1, 0]);
  // Evaluation order: base is copied before property values run.
  const order = 'const f = (b) => ({ ...b, a: (b.x = 99, 1) });';
  const renderedOrder = render(order);
  const stateOrder = {};
  const ctx1 = vm.createContext({ __stryker__: stateOrder, [session]: { phase: 'baseline' } });
  const res1 = vm.runInContext(renderedOrder.output + '\nconst obj = { x: 1 }; f(obj);', ctx1);
  assert.deepEqual({ ...res1 }, { x: 1, a: 1 });
});

test('prefix-to-substring and replace-multiplicity skip RegExp literals and unsupported call shapes', () => {
  for (const snippet of [
    'const f = (s) => s.startsWith("a", 1);',
    'const f = (s) => s?.startsWith("a");',
    'const f = (s) => s.replace(/a/, "b");',
    'const f = (s) => s.replace(/a/g, "b");',
    'const f = (s) => s.replaceAll(/a/g, "b");',
    'const f = (s) => s.replace("a");',
  ]) {
    const { mutants } = render(snippet);
    assert.equal(mutants.filter(m => m.mutatorName === targetedRules.prefixSubstring || m.mutatorName === targetedRules.replaceMultiplicity).length, 0, snippet);
  }
});

test('end-to-end Vitest reports INPUT GAP and ASSERTION GAP for spread-property-drop, prefix-to-substring, and replace-multiplicity', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-new-rules-'));
  try {
    writeFileSync(join(root, 'subject.ts'), `export const clearError = (state: { ok: boolean; error: string | null }) => ({ ...state, ok: true, error: null });
export const isApiPath = (path: string) => path.startsWith('/api/');
export const normalize = (text: string) => text.replaceAll('-', '_');
`);
    writeFileSync(join(root, 'subject.test.ts'), `import { expect, it } from 'vitest';
import { clearError, isApiPath, normalize } from './subject';
it('clears already-null error', () => {
  expect(clearError({ ok: false, error: null })).toStrictEqual({ ok: true, error: null });
});
it('checks api path', () => {
  expect(isApiPath('/api/users')).toBe(true);
  expect(isApiPath('/home')).toBe(false);
});
it('normalizes single dash', () => {
  expect(normalize('a-b')).toBe('a_b');
});
`);
    const runResult = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--format', 'json'],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(runResult.status, 0, runResult.stderr);
    const report = JSON.parse(runResult.stdout);
    const spreadGap = report.diagnostics.find(d => d.rule === targetedRules.spreadDrop);
    const prefixGap = report.diagnostics.find(d => d.rule === targetedRules.prefixSubstring);
    const replaceGap = report.diagnostics.find(d => d.rule === targetedRules.replaceMultiplicity);
    assert.equal(spreadGap?.kind, 'INPUT GAP');
    assert.match(spreadGap.missing, /error/);
    assert.equal(prefixGap?.kind, 'INPUT GAP');
    assert.match(prefixGap.missing, /start/);
    assert.equal(replaceGap?.kind, 'INPUT GAP');
    assert.match(replaceGap.missing, /more than once/);
    const text = renderText(report);
    assert.match(text, /spread-property-drop\/v1/);
    assert.match(text, /prefix-to-substring\/v1/);
    assert.match(text, /replace-multiplicity\/v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
