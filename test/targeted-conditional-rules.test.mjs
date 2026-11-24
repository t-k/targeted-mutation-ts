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
const rows = readFileSync(new URL('../verification/pict/targeted-conditional-rules.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1)
  .map(line => line.split('\t'));

test('the targeted-conditional-rules PICT table has every required seed', () => {
  const seeds = readFileSync(new URL('../verification/pict/targeted-conditional-rules.seed.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1);
  const table = new Set(rows.map(row => row.join('\t')));
  for (const seed of seeds) assert.ok(table.has(seed), seed);
});

for (const [rule, form, inputCase] of rows) {
  test(`PICT conditional: ${rule} / ${form} / ${inputCase}`, () => {
    let source;
    let inputs;
    let pickMutant;
    let expectUnsure = false;
    let compareValueOnly = false;
    if (rule === 'ClampBound') {
      source = form === 'MinOuter'
        ? prelude + "function f(x) { return Math.min(Math.max(see('x', x), 0), 10); }\n"
        : prelude + "function f(x) { return Math.max(Math.min(see('x', x), 10), 0); }\n";
      const val = { BelowLo: -5, InRange: 5, AboveHi: 15 }[inputCase];
      inputs = [[val]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === targetedRules.clampBound && m.targeted?.form === 'dropOuter');
    } else if (rule === 'LiteralSetPrune') {
      source = form === 'StrSet'
        ? prelude + "function f(x) { return ['a', 'b', 'c'].includes(see('x', x)); }\n"
        : prelude + "function f(x) { return [1, 2, 3].includes(see('x', x)); }\n";
      const val = form === 'StrSet'
        ? { MatchFirst: 'a', MatchSecond: 'b', NoMatch: 'z' }[inputCase]
        : { MatchFirst: 1, MatchSecond: 2, NoMatch: 9 }[inputCase];
      inputs = [[val]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === targetedRules.literalSetPrune && m.targeted?.form === 'prune:0');
    } else if (rule === 'MergePrecedence') {
      source = prelude + "function f(a, b) { return { ...see('a', a), ...see('b', b) }; }\n";
      inputs = [{
        Disjoint: [{ x: 1 }, { y: 2 }],
        SameVal: [{ x: 1 }, { x: 1, y: 2 }],
        DiffVal: [{ x: 1 }, { x: 2 }],
      }[inputCase]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === targetedRules.mergePrecedence);
      compareValueOnly = true;
    } else if (rule === 'QuantifierSwap') {
      const method = form === 'Every' ? 'every' : 'some';
      source = prelude + `function f(arr) { return see('arr', arr).${method}(n => n > 0); }\n`;
      inputs = [{ EmptyArr: [[]], SingleArr: [[1]], MultiArr: [[1, -1]] }[inputCase]];
      pickMutant = mutants => mutants.find(m => m.mutatorName === targetedRules.quantifierSwap);
      expectUnsure = inputCase === 'MultiArr';
    } else {
      const pat = { BothAnchors: '/^abc$/', StartOnly: '/^abc/', EndOnly: '/abc$/' }[form];
      source = prelude + `function f(s) { return ${pat}.test(see('s', s)); }\n`;
      const val = { ExactMatch: 'abc', PrefixExtra: 'xabc', SuffixExtra: 'abcx', NonMatch: 'zzz' }[inputCase];
      inputs = [[val]];
      const targetForm = form === 'EndOnly' ? 'dropEnd' : 'dropStart';
      pickMutant = mutants => mutants.find(m => m.mutatorName === targetedRules.regexAnchor && m.targeted?.form === targetForm);
    }

    const { output, mutants } = render(source);
    const mutant = pickMutant(mutants);
    assert.ok(mutant, `expected mutant for ${rule}/${form}`);
    const original = run(source, inputs);
    const state = {};
    assert.deepEqual(run(output, inputs, state, true), original);
    const rewritten = run(edited(source, mutant), inputs);
    assert.deepEqual(run(output, inputs, { activeMutant: mutant.id }), rewritten);
    const [agreed, differed, unsure = 0] = state.observed[mutant.id].tests.t0;
    assert.equal(agreed + differed + unsure, 1);
    if (expectUnsure) {
      assert.equal(unsure, 1);
    } else {
      assert.equal(unsure, 0);
      const origVal = JSON.parse(original[0])[0];
      const editVal = JSON.parse(rewritten[0])[0];
      if (compareValueOnly) {
        const sameMap = Object.keys(origVal).length === Object.keys(editVal).length &&
          Object.keys(origVal).every(k => Object.is(origVal[k], editVal[k]));
        assert.equal(agreed === 1, sameMap);
      } else {
        assert.equal(agreed === 1, JSON.stringify(origVal) === JSON.stringify(editVal));
      }
    }
  });
}

test('cleanup-dropped/v1 only targets expression-statement calls directly inside finally blocks', () => {
  const src = `function run(lock, work) {
  lock.acquire();
  try {
    work();
  } finally {
    lock.release();
    const helper = () => { lock.extra(); };
  }
}
`;
  const { mutants } = render(src);
  const cleanups = mutants.filter(m => m.mutatorName === targetedRules.cleanupDropped);
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].original, 'lock.release();');
  assert.equal(cleanups[0].replacement, ';');
});

test('regex-anchor-slack skips escaped trailing dollar and invalid patterns', () => {
  for (const snippet of [
    'const f = (s) => /foo\\$/.test(s);',
    'const f = (s) => /foo/.test(s);',
  ]) {
    assert.equal(render(snippet).mutants.filter(m => m.mutatorName === targetedRules.regexAnchor).length, 0, snippet);
  }
});

test('end-to-end Vitest reports gaps for all six conditional targeted rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-cond-rules-'));
  try {
    writeFileSync(join(root, 'subject.ts'), `export const clampScore = (x: number) => Math.min(Math.max(x, 0), 100);
export const isRole = (role: string) => ['admin', 'editor', 'viewer'].includes(role);
export const mergeCfg = (a: Record<string, number>, b: Record<string, number>) => ({ ...a, ...b });
export const allPositive = (nums: number[]) => nums.every(n => n > 0);
export const isCode = (s: string) => /^[a-z]+$/.test(s);
export function withLock(lock: { released: boolean; release(): void }, fn: () => number) {
  try { return fn(); } finally { lock.release(); }
}
`);
    writeFileSync(join(root, 'subject.test.ts'), `import { expect, it } from 'vitest';
import { allPositive, clampScore, isCode, isRole, mergeCfg, withLock } from './subject';
it('clamps only lower and in-range', () => {
  expect(clampScore(-5)).toBe(0);
  expect(clampScore(50)).toBe(50);
});
it('checks admin and editor only', () => {
  expect(isRole('admin')).toBe(true);
  expect(isRole('editor')).toBe(true);
  expect(isRole('guest')).toBe(false);
});
it('merges disjoint configs', () => {
  expect(mergeCfg({ a: 1 }, { b: 2 })).toStrictEqual({ a: 1, b: 2 });
});
it('checks single positive', () => {
  expect(allPositive([5])).toBe(true);
});
it('checks exact code and non-matching', () => {
  expect(isCode('abc')).toBe(true);
  expect(isCode('123')).toBe(false);
});
it('returns fn result without checking lock.released', () => {
  const lock = { released: false, release() { this.released = true; } };
  expect(withLock(lock, () => 7)).toBe(7);
});
`);
    const runResult = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'targeted', '--format', 'json'],
      { encoding: 'utf8', timeout: 60_000 });
    assert.equal(runResult.status, 0, runResult.stderr);
    const report = JSON.parse(runResult.stdout);
    const byRule = rule => report.diagnostics.find(d => d.rule === rule);
    assert.equal(byRule(targetedRules.clampBound)?.kind, 'INPUT GAP');
    assert.match(byRule(targetedRules.clampBound).missing, /upper clamp bound/);
    assert.equal(byRule(targetedRules.literalSetPrune)?.kind, 'INPUT GAP');
    assert.match(byRule(targetedRules.literalSetPrune).missing, /'viewer'/);
    assert.equal(byRule(targetedRules.mergePrecedence)?.kind, 'INPUT GAP');
    assert.match(byRule(targetedRules.mergePrecedence).missing, /share a key/);
    assert.equal(byRule(targetedRules.quantifierSwap)?.kind, 'INPUT GAP');
    assert.match(byRule(targetedRules.quantifierSwap).missing, /empty or has elements/);
    assert.equal(byRule(targetedRules.regexAnchor)?.kind, 'INPUT GAP');
    assert.match(byRule(targetedRules.regexAnchor).missing, /anchor/);
    assert.equal(byRule(targetedRules.cleanupDropped)?.kind, 'ASSERTION GAP');
    assert.match(byRule(targetedRules.cleanupDropped).advice, /finally cleanup/);
    const text = renderText(report);
    assert.match(text, /clamp-bound\/v1/);
    assert.match(text, /literal-set-prune\/v1/);
    assert.match(text, /merge-precedence\/v1/);
    assert.match(text, /quantifier-swap\/v1/);
    assert.match(text, /regex-anchor-slack\/v1/);
    assert.match(text, /cleanup-dropped\/v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
