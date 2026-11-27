import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { renderBuiltinSwitches } from '../src/builtin-switches.mjs';
import { formatProgressSummary, renderText, summarizeReport } from '../src/cli-output.mjs';
import { analyzeOperators } from '../src/operator-analysis.mjs';
import { createPlaywrightConfigWrapper } from '../src/playwright.mjs';
import { mergeProjectConfig, validateAndExpandInputs } from '../src/project-config.mjs';
import { indexAgreement, indexCoverage } from '../src/standard-plan.mjs';
import { fullBuiltinGap, targetedGap } from '../src/targeted-gaps.mjs';
import { withCopy } from '../src/vitest.mjs';

function evalInstrumented(sourceText, file, runFn, { phase = 'baseline', testId = 't1', activeMutant, shift = 0 } = {}) {
  const rendered = renderBuiltinSwitches(Buffer.from(sourceText), file, () => true, {
    dialect: 'ts',
    targeted: true,
    shifts: true,
    recordComparisons: true,
  });
  const js = ts.transpileModule(rendered.output, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const ctx = vm.createContext({
    exports: {},
    [Symbol.for('targeted-mutation-ts/session')]: { phase },
    __stryker__: { currentTestId: testId, activeMutant, shift, hitCount: 0 },
  });
  vm.runInContext(js, ctx);
  const value = runFn(ctx.exports, ctx);
  return { rendered, ns: ctx.__stryker__, value };
}

test('Math.min/Math.max targeted probe matches ECMA-262 CallExpression evaluation order when arguments mutate Math', () => {
  const src = [
    'export function calc(change: () => number) {',
    '  return Math.min(change(), 1);',
    '}',
  ].join('\n');
  const probeCheck = renderBuiltinSwitches(Buffer.from(src), 'src/math.ts', () => true, {
    dialect: 'ts',
    targeted: true,
  });
  const methodMutant = probeCheck.mutants.find(m => m.mutatorName === 'MethodExpression');
  const extremeMutant = probeCheck.mutants.find(m => m.mutatorName === 'extreme-swap/v1');
  assert.ok(methodMutant && extremeMutant);
  assert.equal(methodMutant.sharedWith, extremeMutant.id, 'MethodExpression Math.min->max should share execution with extreme-swap/v1');

  for (const activeId of [methodMutant.id, extremeMutant.id]) {
    const res = evalInstrumented(src, 'src/math.ts', (exports, ctx) => {
      const realmMath = vm.runInContext('Math', ctx);
      const origMax = realmMath.max;
      try {
        return exports.calc(() => {
          realmMath.max = () => 99;
          return 2;
        });
      } finally {
        realmMath.max = origMax;
      }
    }, { phase: 'trial', activeMutant: activeId });
    assert.equal(res.value, 2, `activeId=${activeId} must evaluate Math.max lookup before argument side effects`);
    assert.equal(res.ns.hitCount, 1);
  }
});

test('OptionalChaining preserves chain short-circuiting and method `this` while diagnosing missing nullish inputs vs unasserted nullish outcomes', () => {
  const src = [
    'export function readChain(a: any) {',
    '  return a?.b?.c;',
    '}',
    'export function callReceiverMethod(user: any) {',
    '  return user?.greet("hi");',
    '}',
    'export function callOptionalMethodProp(user: any) {',
    '  return user.greet?.("yo");',
    '}',
  ].join('\n');

  // 1. `a = null` short-circuits `a?.b?.c` at the first `?.` without recording the second `?.` as reached!
  const nullFirst = evalInstrumented(src, 'src/opt.ts', exports => exports.readChain(null));
  const chainOpts = nullFirst.rendered.mutants
    .filter(m => m.mutatorName === 'OptionalChaining' && m.location.line === 2)
    .sort((a, b) => a.location.end - b.location.end);
  assert.equal(chainOpts.length, 2);
  const [firstOpt, secondOpt] = chainOpts;
  assert.equal(nullFirst.value, undefined);
  assert.deepEqual([...nullFirst.ns.observed[firstOpt.id].tests.t1], [0, 1, 0]);
  assert.equal(nullFirst.ns.observed[secondOpt.id], undefined, 'second ?. must not be recorded when first ?. short-circuited');

  // 2. `a = { b: null }` reaches both `?.` links: first agrees, second differs (`null`)!
  const nullSecond = evalInstrumented(src, 'src/opt.ts', exports => exports.readChain({ b: null }));
  assert.equal(nullSecond.value, undefined);
  assert.deepEqual([...nullSecond.ns.observed[firstOpt.id].tests.t1], [1, 0, 0]);
  assert.deepEqual([...nullSecond.ns.observed[secondOpt.id].tests.t1], [0, 1, 0]);

  // 3. `a = { b: { c: 42 } }` -> both agree -> `fullBuiltinGap` produces `INPUT GAP` naming receiver!
  const nonNull = evalInstrumented(src, 'src/opt.ts', exports => exports.readChain({ b: { c: 42 } }));
  assert.equal(nonNull.value, 42);
  const passedTests = new Map([['t1', { id: 't1', project: '', file: 'test/opt.test.ts', name: 'reads chain', status: 'passed' }]]);
  const agreement = indexAgreement([{ observed: nonNull.ns.observed }], passedTests);
  const toSeen = id => {
    const s = agreement.get(id);
    return s && {
      agreeing: s.agreeing.size,
      differing: [...s.differing].map(tid => passedTests.get(tid)),
      unsure: [],
      outside: s.outside,
      differ: s.differ,
      agree: s.agree,
    };
  };
  const gap1 = fullBuiltinGap({ ...firstOpt, status: 'survived', evidence: 'reexecuted' }, toSeen(firstOpt.id));
  assert.equal(gap1?.kind, 'INPUT GAP');
  assert.equal(gap1?.missing, 'a test in which `a` is null or undefined');

  const gap2 = fullBuiltinGap({ ...secondOpt, status: 'survived', evidence: 'reexecuted' }, toSeen(secondOpt.id));
  assert.equal(gap2?.kind, 'INPUT GAP');
  assert.equal(gap2?.missing, 'a test in which `a?.b` is null or undefined');

  // When `a = null` passed anyway, `fullBuiltinGap` produces `ASSERTION GAP` naming `reads chain`!
  const diffAgreement = indexAgreement([{ observed: nullFirst.ns.observed }], passedTests);
  const diffSeen = diffAgreement.get(firstOpt.id);
  const assertionGap = fullBuiltinGap({ ...firstOpt, status: 'survived', evidence: 'reexecuted' }, {
    agreeing: diffSeen.agreeing.size,
    differing: [...diffSeen.differing].map(tid => passedTests.get(tid)),
    outside: false,
    differ: diffSeen.differ,
  });
  assert.equal(assertionGap?.kind, 'ASSERTION GAP');
  assert.equal(assertionGap?.tests[0].name, 'reads chain');

  // 4. `this` binding preserved on both `user?.greet("hi")` and `user.greet?.("yo")`!
  const thisCheck = evalInstrumented(src, 'src/opt.ts', exports => {
    const obj = {
      tag: 'bound-ok',
      greet(prefix) { return `${prefix}:${this?.tag}`; },
    };
    return [exports.callReceiverMethod(obj), exports.callOptionalMethodProp(obj)];
  });
  assert.deepEqual([...thisCheck.value], ['hi:bound-ok', 'yo:bound-ok']);
});

test('PICT full-targeted-sharing matrix covers overlap sharing, side-effect safety, relational complement, and condition diagnostics', () => {
  const tableLines = readFileSync(new URL('../verification/pict/full-targeted-sharing.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const seedLines = readFileSync(new URL('../verification/pict/full-targeted-sharing.seed.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const tableSet = new Set(tableLines);
  for (const seed of seedLines) assert.ok(tableSet.has(seed), `Missing mandatory PICT seed: ${seed}`);

  const passedTests = new Map([['t1', { id: 't1', project: 'unit', file: 'test/s.test.ts', name: 'checks subject', status: 'passed' }]]);

  for (const line of tableLines) {
    const [feature, testOutcome, deterministic, sideEffect] = line.split('\t');

    if (feature === 'ArithmeticOverlap' || feature === 'QuantifierOverlap' || feature === 'RegexAnchorOverlap' || feature === 'ExtremeSwapOrder') {
      const code = feature === 'ArithmeticOverlap'
        ? 'export const fn = (a: number, b: number) => a + b;\n'
        : feature === 'QuantifierOverlap'
          ? 'export const fn = (xs: number[]) => xs.some(x => x > 0);\n'
          : feature === 'RegexAnchorOverlap'
            ? 'export const fn = (s: string) => /^ok$/.test(s);\n'
            : 'export const fn = (a: number, b: number) => Math.min(a, b);\n';
      const args = feature === 'ArithmeticOverlap'
        ? (testOutcome === 'AgreesAllInputs' ? [5, 0] : [5, 2])
        : feature === 'QuantifierOverlap'
          ? (testOutcome === 'AgreesAllInputs' ? [[3]] : [[3, -1]])
          : feature === 'RegexAnchorOverlap'
            ? (testOutcome === 'AgreesAllInputs' ? ['ok'] : ['ok!'])
            : (testOutcome === 'AgreesAllInputs' ? [4, 4] : [2, 7]);

      const { rendered, ns } = evalInstrumented(code, 'src/f.ts', exports => exports.fn(...args));
      const sharedBuiltins = rendered.mutants.filter(m => m.sharedWith);
      assert.ok(sharedBuiltins.length >= 1, `${line}: expected sharedWith on built-in overlap mutant`);
      const primary = rendered.mutants.find(m => m.id === sharedBuiltins[0].sharedWith);
      assert.ok(primary, line);
      // Both IDs receive baseline coverage from a single execution!
      const covOf = indexCoverage([{ coverage: ns.mutantCoverage }], passedTests);
      assert.equal(covOf(sharedBuiltins[0].id).hits, 1, line);
      assert.equal(covOf(primary.id).hits, 1, line);
      // Summary never counts shared built-in survivor as an unexplained `otherSurvivor` when primary gap exists.
      if (testOutcome !== 'KillsMutant') {
        const summary = summarizeReport({
          mutators: 'full',
          mutants: [
            { ...sharedBuiltins[0], status: 'survived' },
            { ...primary, status: 'survived' },
          ],
          diagnostics: [{ kind: 'INPUT GAP', site: primary.id }],
        });
        assert.equal(summary.otherSurvivors, 0, line);
      }
      continue;
    }

    if (feature === 'ConditionalConstantDiag') {
      const code = sideEffect === 'Impure'
        ? 'let c = 0; export const fn = (x: number) => { if (++c === x) return 1; return 0; };\n'
        : 'export const fn = (x: number) => { if (x === 1) return 1; return 0; };\n';
      const inputVal = testOutcome === 'AgreesAllInputs' ? 1 : 2;
      const { rendered, ns } = evalInstrumented(code, 'src/cond.ts', exports => exports.fn(inputVal));
      const trueMut = rendered.mutants.find(m => m.mutatorName === 'ConditionalExpression' && m.replacement === 'true');
      assert.ok(trueMut, line);
      if (sideEffect === 'Impure') {
        assert.equal(trueMut.fullDiagnostic.pureBoolean, false, `${line}: impure ++c condition must NEVER be marked pureBoolean`);
      } else {
        assert.equal(trueMut.fullDiagnostic.pureBoolean, true, `${line}: pure local x === 1 should be marked pureBoolean`);
      }
      if (testOutcome !== 'KillsMutant') {
        const agreement = indexAgreement([{ observed: ns.observed }], passedTests);
        const s = agreement.get(trueMut.id);
        const gap = fullBuiltinGap({ ...trueMut, status: 'survived', evidence: deterministic === 'On' && trueMut.fullDiagnostic.pureBoolean && testOutcome === 'AgreesAllInputs' ? 'predicted' : 'reexecuted' }, {
          agreeing: s.agreeing.size,
          differing: [...s.differing].map(tid => passedTests.get(tid)),
          outside: false,
          differ: s.differ,
          agree: s.agree,
        });
        assert.equal(gap?.kind, testOutcome === 'AgreesAllInputs' ? 'INPUT GAP' : 'ASSERTION GAP', line);
      }
      continue;
    }

    if (feature === 'RelationalComplementDiag') {
      const code = 'export const fn = (x: number) => x >= 10;\n';
      const { rendered, ns } = evalInstrumented(code, 'src/rel.ts', exports => exports.fn(12));
      const compMut = rendered.mutants.find(m => m.mutatorName === 'EqualityOperator' && m.operatorSwap?.[1] === '<');
      assert.ok(compMut, line);
      assert.ok(Object.keys(ns.comparisons).length === 1, line);
    }
  }
});

test('Vitest --mutators full shares execution across overlapping rules and diagnoses OptionalChaining, relational complement, and ConditionalExpression', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-full-share-vitest-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'full-share-check', type: 'module' }));
    writeFileSync(join(dir, 'src/app.ts'), [
      'export function score(a: number, b: number, user?: { bonus: number }) {',
      '  const base = a + b;',
      '  const extra = user?.bonus ?? 0;',
      '  const high = base >= 10;',
      '  return { total: Math.max(base, extra), high };',
      '}',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'test/app.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { score } from '../src/app';",
      "it('computes total with user bonus without asserting high flag or missing user', () => {",
      '  expect(score(12, 3, { bonus: 5 }).total).toBe(15);',
      '});',
    ].join('\n') + '\n');

    const report = await analyzeOperators(dir, ['src/app.ts'], { mutators: 'full', concurrency: 1 });
    assert.equal(report.evaluation, 'evaluated');

    // 1. Both ArithmeticOperator (`a + b -> a - b`) and `arithmetic-swap/v1` (`a + b -> (a - b)`) are killed cleanly!
    const arithBuiltin = report.mutants.find(m => m.mutatorName === 'ArithmeticOperator');
    const arithTargeted = report.mutants.find(m => m.mutatorName === 'arithmetic-swap/v1' && m.replacement === '(a - b)');
    assert.equal(arithBuiltin?.status, 'killed');
    assert.equal(arithTargeted?.status, 'killed');

    // 2. Surviving OptionalChaining (`user?.bonus -> user.bonus`) gets an actionable INPUT GAP!
    const optGap = report.diagnostics.find(g => g.rule === 'OptionalChaining');
    assert.ok(optGap, 'expected OptionalChaining diagnostic in --mutators full');
    assert.equal(optGap.kind, 'INPUT GAP');
    assert.match(optGap.missing, /`user` is null or undefined/);

    // 3. Surviving relational complement (`base >= 10 -> base < 10`) gets an actionable ASSERTION GAP naming the test!
    const compGap = report.diagnostics.find(g => g.rule === 'EqualityOperator' && g.mutations?.[0]?.replacement?.includes('<'));
    assert.ok(compGap, 'expected EqualityOperator relational-complement diagnostic');
    assert.equal(compGap.kind, 'ASSERTION GAP');
    assert.ok(compGap.tests.some(t => t.name.includes('computes total with user bonus')));
    assert.deepEqual(compGap.example?.operands, ['15', '10']);

    // 4. Surviving ConditionalExpression (`base >= 10 -> true` / `false`) gets actionable diagnostics!
    const condGaps = report.diagnostics.filter(g => g.rule === 'ConditionalExpression');
    assert.ok(condGaps.length >= 1, 'expected ConditionalExpression diagnostic in --mutators full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Dogfooding UX fixes: webServer.port + 127.0.0.1 baseURL, baseline stderr surfacing, hoisted node_modules, directory targets, config validation, and relational short-circuit absorption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-dogfood-ux-'));
  try {
    // 1. Hoisted `node_modules` resolution in monorepo subpackages (`packages/sub`).
    mkdirSync(join(dir, 'node_modules', 'custom-dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'custom-dep', 'index.js'), 'module.exports = 42;\n');
    mkdirSync(join(dir, 'packages', 'sub', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'sub', 'package.json'), JSON.stringify({ name: 'sub-pkg' }));
    writeFileSync(join(dir, 'packages', 'sub', 'src', 'item.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'packages', 'sub', 'playwright.config.ts'), `
      export default {
        use: { baseURL: 'http://127.0.0.1:3972' },
        webServer: { command: 'node server.mjs', port: 3972 },
      };
    `);

    withCopy(join(dir, 'packages', 'sub'), copyRoot => {
      const copiedDep = resolve(copyRoot, 'node_modules', 'custom-dep', 'index.js');
      assert.equal(readFileSync(copiedDep, 'utf8').trim(), 'module.exports = 42;');
      // Wrapper generates cleanly with `webServer.port` + `127.0.0.1` `baseURL` and sets `stderr: 'pipe'`.
      const wrapperPath = createPlaywrightConfigWrapper(copyRoot, undefined, {
        injectServerPreload: true,
        originsFile: resolve(copyRoot, 'origins.json'),
        bridgeEnv: { TMT_PW_TOKEN: 'tok' },
      });
      const wrapperText = readFileSync(wrapperPath, 'utf8');
      assert.match(wrapperText, /stderr: server\.stderr \?\? 'pipe'/);
    });

    // 2. Directory target expansion (`src` -> `src/item.ts`).
    const expanded = validateAndExpandInputs(join(dir, 'packages', 'sub'), ['src'], {});
    assert.deepEqual(expanded.files, ['src/item.ts']);

    // 3. Config unknown-key warnings with typo suggestions + `projects` / `deterministic` / `displaceThresholds` merging.
    const warnings = [];
    const merged = mergeProjectConfig(
      {
        runner: 'playwright',
        projects: ['chromium'],
        deterministic: true,
        displaceThresholds: true,
        test: ['e2e/a.spec.ts'],
        include: ['src'],
      },
      {},
      [],
      { sourceName: 'targeted-mutation.config.json', onWarning: msg => warnings.push(msg) },
    );
    assert.equal(merged.values.runner, 'playwright');
    assert.deepEqual(merged.values.project, ['chromium']);
    assert.equal(merged.values.deterministic, true);
    assert.equal(merged.values['displace-thresholds'], true);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /did you mean "tests"\?/);
    assert.match(warnings[1], /did you mean "files"\?/);

    // 4. Baseline stderr output surfaced even when `baseline.errors` has `Process from config.webServer...`.
    const baselineText = renderText({
      runner: 'playwright',
      evaluation: 'baseline_error',
      baseline: {
        status: 'error',
        errors: ['Error: Process from config.webServer was not able to start. Exit code: 1'],
        output: '[WebServer] Error [ERR_MODULE_NOT_FOUND]: Cannot find package "esbuild"',
      },
    });
    assert.match(baselineText, /Process from config\.webServer/);
    assert.match(baselineText, /ERR_MODULE_NOT_FOUND.*esbuild/);

    // 5. `--verify-trials` summary shown in text output without breaking trailing summary line.
    const verifiedText = renderText({
      runner: 'playwright',
      evaluation: 'evaluated',
      baseline: { status: 'passed', tests: 3 },
      trials: { workers: 1, inWorker: 5, isolated: 0, verified: { sampled: 3, mismatches: [] } },
      mutants: [{ location: { file: 'src/a.ts', line: 1, column: 1 }, status: 'killed', rule: 'comparison-boundary/v1', operator: '>=', replacement: '>' }],
      diagnostics: [],
    });
    assert.match(verifiedText, /Verified 3 session trials in isolated runs \(0 mismatches\)\./);
    assert.match(verifiedText, /playwright, 3 baseline tests: 1 edit \(1 killed\), 0 test gaps$/);

    // 6. Relational short-circuit guard (`code === 'WELCOME500' && subtotal >= 10000`) absorbs `subtotal = 8000`
    //    into `INPUT GAP` without invoking `valueOf` on non-primitive objects!
    const guardSrc = [
      'export function discount(code: string, subtotal: any) {',
      "  return code === 'WELCOME500' && subtotal >= 10000 ? 500 : 0;",
      '}',
    ].join('\n');
    let sideEffects = 0;
    const guardEval = evalInstrumented(guardSrc, 'src/guard.ts', exports => [
      exports.discount('OTHER', 8000),
      exports.discount('OTHER', { valueOf() { sideEffects++; return 8000; } }),
    ]);
    assert.deepEqual([...guardEval.value], [0, 0]);
    assert.equal(sideEffects, 0, 'relational pure guard must never invoke valueOf on objects');
    const eqTrueMut = guardEval.rendered.mutants.find(m => m.mutatorName === 'equality-constant/v1' && m.targeted?.form === 'true');
    const obs = guardEval.ns.observed[eqTrueMut.id];
    // Call 1 (`subtotal = 8000` primitive) was absorbed (`counts[0] === 1`); Call 2 (`object`) safely declined absorption (`counts[1] === 1`)!
    assert.deepEqual([...obs.tests.t1], [1, 1, 0]);
    assert.equal(obs.absorbed, true);

    // 7. Natural `??` literal-fallback message (`couponCode ?? ''`).
    const fallbackSrc = "export const norm = (couponCode?: string | null) => couponCode ?? '';\n";
    const fbEval = evalInstrumented(fallbackSrc, 'src/fb.ts', exports => exports.norm('SAVE10'));
    const rightDrop = fbEval.rendered.mutants.find(m => m.mutatorName === 'ignored-operand/v1' && m.targeted?.form === 'right');
    const fbGap = targetedGap({ ...rightDrop, status: 'survived', evidence: 'reexecuted' }, { agreeing: 1, differing: [], unsure: [], agree: ['"SAVE10"'] });
    assert.equal(fbGap?.kind, 'INPUT GAP');
    assert.equal(fbGap?.missing, "a test in which `couponCode` is null or undefined so the fallback `''` is used");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
