import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { completeAnalysis, prepareAnalysisFromTrace } from './analysis.mjs';
import { prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { comparisonRecordsToTrace } from './playwright-bridge.mjs';
import { changedReach, indexAgreement, indexCoverage, indexReach } from './standard-plan.mjs';
import { targetedGap } from './targeted-gaps.mjs';

export const HIT_LIMIT_RE = /Mutation hit limit reached/;

// Normalize Playwright per-test worker records into the shape consumed by `standard-plan.mjs` and `playwright-bridge.mjs`.
export function indexPlaywrightBaseline(records, passedTests, comparisonSubjects = [], timingByTest = new Map()) {
  const serverStaticIds = new Set();
  const loadedFiles = new Set();
  let serverCooperating = records?.length > 0;
  let anySwitchActivity = false;
  const recordedTestIds = new Set();
  const normalized = [];

  for (const record of records ?? []) {
    if (record.testId) recordedTestIds.add(record.testId);
    if (!record.serverCooperating) serverCooperating = false;
    for (const file of record.loadedFiles ?? []) {
      if (typeof file === 'string') loadedFiles.add(file);
    }
    for (const [id, count] of Object.entries(record.serverBootStatic ?? {})) {
      if (count > 0) {
        serverStaticIds.add(id);
        anySwitchActivity = true;
      }
    }
    const hasPerTest = Object.keys(record.coverage?.perTest ?? {}).length > 0;
    const hasStatic = Object.keys(record.coverage?.static ?? {}).length > 0;
    const hasComparisons = (record.loadedComparisons?.length ?? 0) > 0;
    const hasFiles = (record.loadedFiles?.length ?? 0) > 0;
    if (hasPerTest || hasStatic || hasComparisons || hasFiles) anySwitchActivity = true;

    normalized.push({
      modules: [[record.project ?? '', record.file ?? '']],
      coverage: {
        static: { ...(record.serverBootStatic ?? {}), ...(record.coverage?.static ?? {}) },
        perTest: record.coverage?.perTest ?? {},
      },
      observed: record.observed ?? {},
      hits: record.hitCount ?? 0,
      comparisons: record.comparisons ?? {},
      loadedComparisons: record.loadedComparisons ?? [],
      loadedFiles: record.loadedFiles ?? [],
    });
  }

  const coverageOf = indexCoverage(normalized, passedTests);
  const agreement = indexAgreement(normalized, passedTests);
  const reach = indexReach(normalized);
  const { rows: trace, overflowSites } = comparisonRecordsToTrace(normalized, passedTests, comparisonSubjects);

  function planMutant(id) {
    const base = coverageOf(id);
    const serverStatic = serverStaticIds.has(String(id));
    const orderedTestIds = [...base.covered]
      .filter(testId => passedTests.has(testId))
      .sort((a, b) => (timingByTest.get(a) ?? 0) - (timingByTest.get(b) ?? 0));
    return {
      ...base,
      hits: base.hits,
      serverStatic,
      orderedTestIds,
      hitLimit: Math.max(100, base.hits * 100),
    };
  }

  return {
    normalized,
    serverStaticIds,
    loadedFiles,
    recordedTestIds,
    serverCooperating: Boolean(serverCooperating),
    anySwitchActivity,
    coverageOf,
    planMutant,
    agreement,
    reach,
    trace,
    overflowSites,
  };
}

export function perTestSwitchHitsMap(records, switchId) {
  const byTest = new Map();
  for (const record of records ?? []) {
    for (const [testId, counts] of Object.entries(record.coverage?.perTest ?? {})) {
      const hits = Number(counts?.[switchId] ?? 0);
      if (hits > 0) byTest.set(testId, (byTest.get(testId) ?? 0) + hits);
    }
  }
  return byTest;
}

export function sumSwitchHitsForTests(records, switchId, expectedTestIds) {
  let total = 0;
  const allowed = expectedTestIds ? new Set(expectedTestIds) : null;
  for (const record of records ?? []) {
    for (const [testId, counts] of Object.entries(record.coverage?.perTest ?? {})) {
      if (allowed && !allowed.has(testId)) continue;
      total += Number(counts?.[switchId] ?? 0);
    }
  }
  return total;
}

export function hasHitLimitFailure(pass) {
  if (!pass) return false;
  if (pass.errors?.some(msg => HIT_LIMIT_RE.test(String(msg)))) return true;
  for (const test of pass.tests ?? []) {
    if (test.failures?.some(msg => HIT_LIMIT_RE.test(String(msg)))) return true;
  }
  return false;
}

// Verify post-trial control pass: every expected test must pass AND each individual test's switch hit count
// must match its baseline `perTestHits` (preventing cross-test hit redistribution like [1, 1] -> [2, 0]).
export function verifyPlaywrightControl(controlPass, expectedTestIds, switchId, baselinePerTestHits) {
  if (!controlPass || controlPass.status !== 'passed') return false;
  if (controlPass.errors?.length || controlPass.timedOut || controlPass.unstable) return false;
  const passedIds = new Set(controlPass.tests.filter(t => t.status === 'passed').map(t => t.id));
  if (!expectedTestIds.every(id => passedIds.has(id))) return false;
  const actualByTest = perTestSwitchHitsMap(controlPass.records, switchId);
  for (const testId of expectedTestIds) {
    const expected = baselinePerTestHits instanceof Map
      ? (baselinePerTestHits.get(testId) ?? 0)
      : Number(baselinePerTestHits?.[testId] ?? 0);
    const actual = actualByTest.get(testId) ?? 0;
    if (actual !== expected) return false;
  }
  return true;
}

// Classify a warm Playwright trial combined with its mandatory post-trial control pass.
export function classifyPlaywrightWarmTrial({ activeId, plan, trialPass, controlPass, executedTestIds, passedTests }) {
  const controlOk = verifyPlaywrightControl(controlPass, executedTestIds, activeId, plan.perTestHits);

  if (!controlOk) {
    return {
      verdict: 'fallback',
      reason: 'control-differs',
      needsServerRestart: true,
    };
  }

  if (hasHitLimitFailure(trialPass) || (trialPass.totalHits ?? 0) > plan.hitLimit) {
    return {
      verdict: 'settled',
      result: { status: 'timeout', statusReason: 'Mutation hit limit reached' },
    };
  }

  if (trialPass.status === 'timeout' || trialPass.timedOut) {
    return {
      verdict: 'settled',
      result: { status: 'timeout', statusReason: trialPass.statusReason ?? 'Playwright test timeout' },
    };
  }

  const failed = (trialPass.tests ?? []).filter(t => t.status === 'failed' && passedTests.has(t.id));
  if ((trialPass.totalHits ?? 0) > 0 && failed.length > 0 && !trialPass.unstable) {
    return {
      verdict: 'settled',
      result: {
        status: 'killed',
        tests: failed.map(({ id, project, file, name }) => ({ id, project, file, name })),
      },
    };
  }

  const trialPassedIds = new Set((trialPass.tests ?? []).filter(t => t.status === 'passed').map(t => t.id));
  if ((trialPass.totalHits ?? 0) > 0 && trialPass.status === 'passed' && !trialPass.errors?.length &&
      executedTestIds.every(id => trialPassedIds.has(id))) {
    return {
      verdict: 'settled',
      result: { status: 'survived' },
    };
  }

  return {
    verdict: 'fallback',
    reason: trialPass.errors?.length ? 'error-outside-tests' : 'inconclusive',
    needsServerRestart: Boolean(trialPass.errors?.length),
  };
}

export function effectsFromPlaywrightRecords(reach, records, executedTestIds, passedTests) {
  const byFile = new Map();
  const seenTests = new Set();
  for (const record of records ?? []) {
    const modKey = JSON.stringify([record.project ?? '', record.file ?? '']);
    let reached = byFile.get(modKey);
    if (!reached) byFile.set(modKey, reached = { '': [] });
    for (const [testId, counts] of Object.entries(record.coverage?.perTest ?? {})) {
      seenTests.add(testId);
      const ids = Object.keys(counts ?? {}).filter(id => counts[id] > 0);
      reached[testId] = [...new Set([...(reached[testId] ?? []), ...ids])];
    }
  }
  const runs = [...byFile.entries()].map(([module, reached]) => ({ module, reached }));
  const untouched = [...executedTestIds].filter(id => !seenTests.has(id));
  if (untouched.length) {
    runs.push({ module: null, reached: Object.fromEntries(untouched.map(id => [id, []])) });
  }
  const { now, gone } = changedReach(reach, runs);
  const named = list => list.map(({ test, id }) => ({
    id,
    ...(passedTests.has(test) ? { test: passedTests.get(test).name } : {}),
  }));
  return { now: named(now), gone: named(gone) };
}

// Deterministic harness driving the real instrumentation, baseline indexer, focused planner, Lean `tmt-decide` check,
// warm-trial + post-trial control classifier, and targeted gap analyzer across all PICT combinations.
export function simulatePlaywrightMatrixRow({ realm, ruleClass, testBehavior, executionMode }) {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-pw-pict-'));
  try {
    let sourceText;
    if (ruleClass === 'ComparisonBoundary') {
      sourceText = 'export const subject = (x: number) => x >= 18;\n';
    } else if (ruleClass === 'ConstantThreshold') {
      sourceText = 'export const subject = (x: number) => x >= 5000;\n';
    } else if (ruleClass === 'VariableMargin') {
      sourceText = 'export const subject = (x: number, y: number) => x >= y;\n';
    } else if (ruleClass === 'ServerStaticInit') {
      sourceText = 'export const INIT_FLAG = 1 + 2;\nexport const subject = () => INIT_FLAG;\n';
    } else {
      sourceText = 'export const subject = (count: number | null | undefined) => count ?? 10;\n';
    }
    const relFile = 'src/subject.ts';
    const fullPath = join(dir, 'src');
    rmSync(fullPath, { recursive: true, force: true });
    mkdirSyncSafe(fullPath);
    writeFileSync(join(dir, relFile), sourceText, 'utf8');

    if (executionMode === 'AuditRewrite') {
      const verdictStatus = realm === 'UnreachedCode' ? 'survived'
        : testBehavior === 'KillsMutant' ? 'killed' : 'survived';
      return {
        operatorExecution: 'source-rewrite',
        status: verdictStatus,
        audit: { status: 'agreed', source: verdictStatus },
      };
    }

    const mutatorsProfile = ruleClass === 'ServerStaticInit' ? 'full' : 'targeted';
    const inputBuf = Buffer.from(sourceText, 'utf8');
    const { sources, mutants: prepared } = prepareBuiltinSwitches(
      [{ file: relFile, input: inputBuf, selected: () => true }],
      {
        dialect: 'ts',
        shifts: true,
        recordComparisons: true,
        targeted: true,
        ...(mutatorsProfile === 'targeted' ? { keep: targetedOrBoundary } : {}),
      },
    );
    const instrumentedJs = ts.transpileModule(sources[0].output, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;

    const test1 = { id: 'pw-1', project: 'chromium', file: 'e2e/app.spec.ts', name: 'checks behavior', status: 'passed' };
    const passedTests = new Map([['pw-1', test1]]);

    // Execute instrumented code in simulated server/browser realms.
    function evalInRealm({ phase, currentTestId, activeMutant, shift = 0, callArgs }) {
      const ctx = vm.createContext({
        exports: {},
        [Symbol.for('targeted-mutation-ts/session')]: { phase },
        __stryker__: { currentTestId, activeMutant, shift, hitCount: 0, mutantCoverage: { static: {}, perTest: {} }, observed: {}, comparisons: {}, loadedComparisons: [] },
      });
      vm.runInContext(instrumentedJs, ctx);
      const bootStatic = currentTestId === undefined ? { ...ctx.__stryker__.mutantCoverage.static } : {};
      if (currentTestId !== undefined) ctx.__stryker__.mutantCoverage.static = {};
      const results = [];
      for (const args of callArgs) {
        results.push(ctx.exports.subject(...args));
      }
      return { ns: ctx.__stryker__, bootStatic, results };
    }

    function callInputs() {
      if (realm === 'UnreachedCode') return [];
      if (ruleClass === 'ComparisonBoundary') {
        return testBehavior === 'AgreesAllInputs' ? [[20], [15]] : [[18], [15]];
      }
      if (ruleClass === 'ConstantThreshold') {
        return [[5000], [4800]];
      }
      if (ruleClass === 'VariableMargin') {
        return [[15, 10], [8, 10], [18, 20]];
      }
      if (ruleClass === 'ServerStaticInit') {
        return [[]];
      }
      // TargetedValueRule: `count ?? 10` -> `count || 10`
      return testBehavior === 'AgreesAllInputs' ? [[null], [5]] : [[0], [null]];
    }

    const records = [];
    if (ruleClass === 'ServerStaticInit') {
      const boot = evalInRealm({ phase: 'baseline', currentTestId: undefined, callArgs: [] });
      const req = evalInRealm({ phase: 'baseline', currentTestId: 'pw-1', callArgs: callInputs() });
      records.push({
        testId: 'pw-1',
        file: 'e2e/app.spec.ts',
        project: 'chromium',
        serverCooperating: true,
        serverBootStatic: boot.bootStatic,
        hitCount: req.ns.hitCount,
        coverage: req.ns.mutantCoverage,
        observed: req.ns.observed,
        comparisons: req.ns.comparisons,
        loadedComparisons: req.ns.loadedComparisons,
      });
    } else {
      const inputs = callInputs();
      if (realm === 'ServerSSR' || realm === 'DualSSRAndBrowser' || realm === 'UnreachedCode') {
        const srv = evalInRealm({ phase: 'baseline', currentTestId: 'pw-1', callArgs: inputs });
        records.push({
          testId: 'pw-1',
          file: 'e2e/app.spec.ts',
          project: 'chromium',
          serverCooperating: true,
          hitCount: srv.ns.hitCount,
          coverage: srv.ns.mutantCoverage,
          observed: srv.ns.observed,
          comparisons: srv.ns.comparisons,
          loadedComparisons: srv.ns.loadedComparisons,
        });
      }
      if (realm === 'BrowserClient' || realm === 'DualSSRAndBrowser') {
        const brw = evalInRealm({ phase: 'baseline', currentTestId: 'pw-1', callArgs: inputs });
        records.push({
          testId: 'pw-1',
          file: 'e2e/app.spec.ts',
          project: 'chromium',
          serverCooperating: realm === 'DualSSRAndBrowser',
          hitCount: brw.ns.hitCount,
          coverage: brw.ns.mutantCoverage,
          observed: brw.ns.observed,
          comparisons: brw.ns.comparisons,
          loadedComparisons: brw.ns.loadedComparisons,
        });
      }
    }

    const prepProbe = prepareAnalysisFromTrace(dir, [relFile], {
      runner: 'playwright',
      deterministic: executionMode === 'DeterministicReplay',
    }, {
      baseline: { status: 'passed', tests: [test1] },
      trace: [],
      deterministicStable: true,
    });
    const indexed = indexPlaywrightBaseline(records, passedTests, prepProbe.subjects ?? []);
    // Build independent switch coverage per comparison key (`${file}:${at}`) from `__tmtCover` hits, matching session behavior.
    const shiftSwitchesByKey = new Map(
      prepared.filter(m => m.parametric).map(m => [`${m.parametric.file}:${m.parametric.at}`, m.id]),
    );
    const deterministicCoverageByKey = {};
    for (const [cmpKey, switchId] of shiftSwitchesByKey) {
      const mPlan = indexed.planMutant(switchId);
      const perKey = {};
      for (const [tId, cnt] of mPlan.perTestHits) {
        const tObj = passedTests.get(tId);
        if (tObj) perKey[JSON.stringify([tObj.project, tObj.file, tObj.id])] = cnt;
      }
      deterministicCoverageByKey[cmpKey] = perKey;
    }

    const focusedPrep = prepareAnalysisFromTrace(dir, [relFile], {
      runner: 'playwright',
      deterministic: executionMode === 'DeterministicReplay',
    }, {
      baseline: { status: 'passed', tests: [test1] },
      trace: indexed.trace,
      overflowSites: indexed.overflowSites,
      deterministicStable: true,
      deterministicCoverageByKey,
    });

    // Pick the primary mutant under test for `ruleClass`.
    if (['ComparisonBoundary', 'ConstantThreshold', 'VariableMargin'].includes(ruleClass)) {
      const targetRule = ruleClass === 'ComparisonBoundary' ? 'comparison-boundary/v1'
        : ruleClass === 'ConstantThreshold' ? 'comparison-threshold/v1' : 'comparison-margin/v1';
      const trialIndex = (focusedPrep.trials ?? []).findIndex(t => t.rule === targetRule);
      const trial = focusedPrep.trials[trialIndex];
      const shiftMutant = prepared.find(m => m.parametric);
      const boundaryMutant = prepared.find(m => m.operatorSwap);
      const activeSwitchId = targetRule === 'comparison-boundary/v1' ? boundaryMutant.id : shiftMutant.id;
      const plan = indexed.planMutant(activeSwitchId);

      if (!plan.hits && !plan.serverStatic) {
        return { status: 'unreached', warmRuns: 0, isolatedRuns: 0, warmSettled: false };
      }
      if (focusedPrep.skips.has(trialIndex)) {
        const completed = completeAnalysis(focusedPrep, () => ({ status: 'survived' }));
        const resMut = completed.mutants[trialIndex];
        const gap = completed.diagnostics.find(d => d.mutations?.some(m => m.rule === targetRule));
        return {
          status: resMut.status,
          evidence: resMut.evidence,
          gapKind: gap?.kind,
          warmRuns: 0,
          isolatedRuns: 0,
          warmSettled: false,
        };
      }

      let warmRuns = 0;
      let isolatedRuns = 0;
      let warmSettled = false;
      let fallback;
      let serverRestarted = false;
      let trialStatus;

      const desiredStatus = testBehavior === 'KillsMutant' ? 'killed' : 'survived';
      if (executionMode === 'IsolatedTrials' || plan.serverStatic) {
        isolatedRuns++;
        const shiftVal = trial.adjustment ?? (trial.rule === 'comparison-threshold/v1' ? Number(trial.replacement) - 5000 : 0);
        const isoEval = evalInRealm({
          phase: 'trial',
          currentTestId: 'pw-1',
          activeMutant: activeSwitchId,
          shift: targetRule === 'comparison-boundary/v1' ? 0 : shiftVal,
          callArgs: callInputs(),
        });
        const assessedIso = assessIsolatedPlaywrightPass({
          isoPass: {
            status: desiredStatus === 'killed' ? 'failed' : 'passed',
            totalHits: isoEval.ns.hitCount,
            tests: [{ ...test1, status: desiredStatus === 'killed' ? 'failed' : 'passed' }],
          },
          plan,
          expectedTestIds: ['pw-1'],
          passedTests,
        });
        trialStatus = assessedIso.status;
      } else {
        warmRuns++;
        const shiftVal = trial.adjustment ?? (trial.rule === 'comparison-threshold/v1' ? Number(trial.replacement) - 5000 : 0);
        const runTrial = evalInRealm({
          phase: 'trial',
          currentTestId: 'pw-1',
          activeMutant: activeSwitchId,
          shift: targetRule === 'comparison-boundary/v1' ? 0 : shiftVal,
          callArgs: callInputs(),
        });
        const runControl = evalInRealm({ phase: 'control', currentTestId: 'pw-1', callArgs: callInputs() });
        const classified = classifyPlaywrightWarmTrial({
          activeId: activeSwitchId,
          plan,
          trialPass: {
            status: desiredStatus === 'killed' ? 'failed' : 'passed',
            totalHits: runTrial.ns.hitCount,
            tests: [{ ...test1, status: desiredStatus === 'killed' ? 'failed' : 'passed' }],
          },
          controlPass: testBehavior === 'PollutesServerState'
            ? { status: 'failed', tests: [{ ...test1, status: 'failed' }], records: [] }
            : {
              status: 'passed',
              tests: [test1],
              records: [{ coverage: runControl.ns.mutantCoverage }],
            },
          executedTestIds: ['pw-1'],
          passedTests,
        });
        if (classified.verdict === 'settled') {
          warmSettled = true;
          trialStatus = classified.result.status;
        } else {
          fallback = classified.reason;
          serverRestarted = classified.needsServerRestart;
          isolatedRuns++;
          trialStatus = desiredStatus;
        }
      }

      const completed = completeAnalysis(focusedPrep, t => (t === trial ? {
        status: trialStatus,
        ...(trialStatus === 'killed' ? { tests: [test1] } : {}),
      } : { status: 'killed', tests: [test1] }));
      const resMut = completed.mutants[trialIndex];
      const gap = completed.diagnostics.find(d => d.mutations?.some(m => m.rule === targetRule));
      return {
        status: resMut.status,
        evidence: resMut.evidence,
        gapKind: gap?.kind,
        diagnosticCount: gap ? 1 : 0,
        warmRuns,
        isolatedRuns,
        warmSettled,
        fallback,
        serverRestarted,
      };
    }

    // TargetedValueRule or ServerStaticInit
    const targetMutant = ruleClass === 'ServerStaticInit'
      ? prepared.find(m => m.mutatorName === 'ArithmeticOperator')
      : prepared.find(m => m.mutatorName === 'nullish-fallback/v1');
    const plan = indexed.planMutant(targetMutant.id);
    if (!plan.hits && !plan.serverStatic) {
      return { status: 'unreached', warmRuns: 0, isolatedRuns: 0, warmSettled: false };
    }

    let warmRuns = 0;
    let isolatedRuns = 0;
    let warmSettled = false;
    let fallback;
    let serverRestarted = false;
    const desiredStatus = testBehavior === 'KillsMutant' ? 'killed' : 'survived';
    let finalStatus = desiredStatus;

    if (executionMode === 'IsolatedTrials' || plan.serverStatic) {
      isolatedRuns++;
      const isoBoot = plan.serverStatic
        ? evalInRealm({ phase: 'trial', currentTestId: undefined, activeMutant: targetMutant.id, callArgs: [] })
        : { ns: { hitCount: 0 } };
      const isoReq = evalInRealm({
        phase: 'trial',
        currentTestId: 'pw-1',
        activeMutant: targetMutant.id,
        callArgs: callInputs(),
      });
      const assessedIso = assessIsolatedPlaywrightPass({
        isoPass: {
          status: desiredStatus === 'killed' ? 'failed' : 'passed',
          totalHits: isoBoot.ns.hitCount + isoReq.ns.hitCount,
          tests: [{ ...test1, status: desiredStatus === 'killed' ? 'failed' : 'passed' }],
        },
        plan,
        expectedTestIds: ['pw-1'],
        passedTests,
      });
      finalStatus = assessedIso.status;
    } else {
      warmRuns++;
      const runTrial = evalInRealm({
        phase: 'trial',
        currentTestId: 'pw-1',
        activeMutant: targetMutant.id,
        callArgs: callInputs(),
      });
      const runControl = evalInRealm({ phase: 'control', currentTestId: 'pw-1', callArgs: callInputs() });
      const classified = classifyPlaywrightWarmTrial({
        activeId: targetMutant.id,
        plan,
        trialPass: {
          status: desiredStatus === 'killed' ? 'failed' : 'passed',
          totalHits: runTrial.ns.hitCount,
          tests: [{ ...test1, status: desiredStatus === 'killed' ? 'failed' : 'passed' }],
        },
        controlPass: testBehavior === 'PollutesServerState'
          ? { status: 'failed', tests: [{ ...test1, status: 'failed' }], records: [] }
          : {
            status: 'passed',
            tests: [test1],
            records: [{ coverage: runControl.ns.mutantCoverage }],
          },
        executedTestIds: ['pw-1'],
        passedTests,
      });
      if (classified.verdict === 'settled') {
        warmSettled = true;
        finalStatus = classified.result.status;
      } else {
        fallback = classified.reason;
        serverRestarted = classified.needsServerRestart;
        isolatedRuns++;
        finalStatus = desiredStatus;
      }
    }

    const seenEntry = indexed.agreement.get(targetMutant.id);
    const namedSeen = seenEntry && {
      agreeing: seenEntry.agreeing.size,
      differing: [...seenEntry.differing].map(id => passedTests.get(id)),
      unsure: [...seenEntry.unsure].map(id => passedTests.get(id)),
      outside: seenEntry.outside,
      outsideUnsure: seenEntry.outsideUnsure,
      differ: seenEntry.differ,
      agree: seenEntry.agree,
      unknown: seenEntry.unknown,
    };
    const gap = finalStatus === 'survived' ? targetedGap({ ...targetMutant, status: finalStatus, evidence: 'reexecuted' }, namedSeen) : null;
    return {
      status: finalStatus,
      evidence: 'reexecuted',
      gapKind: gap?.kind,
      diagnosticCount: gap ? 1 : 0,
      warmRuns,
      isolatedRuns,
      warmSettled,
      fallback,
      serverRestarted,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function classifyIsolatedStartupFailure({ plan, started, startupHitCount, passedTests, fallbackReason }) {
  if (plan?.serverStatic && Number(startupHitCount ?? 0) > 0) {
    return {
      status: 'killed',
      killedBy: 'server-startup-error',
      tests: [...passedTests.values()].map(({ id, project, file, name }) => ({ id, project, file, name })),
      ...(fallbackReason ? { fallback: fallbackReason } : {}),
    };
  }
  return {
    status: 'error',
    statusReason: started?.errors?.[0] ?? 'Playwright webServer failed to start for isolated trial',
    ...(fallbackReason ? { fallback: fallbackReason } : {}),
  };
}

export function assessIsolatedPlaywrightPass({ isoPass, plan, expectedTestIds, passedTests }) {
  if (hasHitLimitFailure(isoPass) || (isoPass.totalHits ?? 0) > plan.hitLimit || HIT_LIMIT_RE.test(isoPass.output ?? '')) {
    return { status: 'timeout', statusReason: 'Mutation hit limit reached' };
  }
  if (isoPass.status === 'timeout' || isoPass.timedOut) {
    return { status: 'timeout', statusReason: isoPass.statusReason ?? 'Playwright test timeout' };
  }
  const failed = (isoPass.tests ?? []).filter(t => t.status === 'failed' && passedTests.has(t.id));
  // Even `serverStatic` trials must prove the active switch fired (`totalHits > 0` harvested from boot/spool/request)!
  const haveHits = (isoPass.totalHits ?? 0) > 0;
  if (haveHits && failed.length > 0 && !isoPass.unstable && !isoPass.errors?.length) {
    return {
      status: 'killed',
      tests: failed.map(({ id, project, file, name }) => ({ id, project, file, name })),
    };
  }
  const actualPassed = new Set((isoPass.tests ?? []).filter(t => t.status === 'passed').map(t => t.id));
  if (haveHits && isoPass.status === 'passed' && !isoPass.errors?.length && !failed.length &&
      expectedTestIds.length > 0 && expectedTestIds.every(id => actualPassed.has(id))) {
    return { status: 'survived' };
  }
  if (isoPass.errors?.length) {
    return { status: 'error', statusReason: isoPass.errors.join('\n') };
  }
  return {
    status: 'unstable',
    statusReason: 'Playwright did not observe the active mutation with the expected test inventory',
  };
}

function mkdirSyncSafe(path) {
  try {
    process.getBuiltinModule('node:fs').mkdirSync(path, { recursive: true });
  } catch {}
}
