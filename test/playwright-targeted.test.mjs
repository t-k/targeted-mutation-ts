import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { renderBuiltinSwitches, targetedOrBoundary } from '../src/builtin-switches.mjs';
import { collectComparisons, planFocusedTrials } from '../src/analysis.mjs';
import { comparisonRecordsToTrace } from '../src/playwright-bridge.mjs';

test('pure-JS comparison switches record browser-safe safe-integer pairs and bound tight loops', () => {
  const source = Buffer.from([
    'export const checkConst = (n: number) => n >= 5000;',
    'export const checkMargin = (a: number, b: number) => a >= b;',
    'export const neverCalled = (x: number) => x < 10;',
  ].join('\n'));
  const rendered = renderBuiltinSwitches(source, 'src/rules.ts', () => true, {
    dialect: 'ts',
    targeted: true,
    shifts: true,
    recordComparisons: true,
    keep: targetedOrBoundary,
  });
  assert.doesNotMatch(rendered.output, /\bnode:fs\b|\bimport\s+\{/);

  // Transpile TypeScript annotations (just as Vite/esbuild/ts.transpileModule does for browser/server code)
  // and run in a plain VM context without `process` or Node globals.
  const transpiled = ts.transpileModule(rendered.output, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const realm = vm.createContext({
    exports: {},
    [Symbol.for('targeted-mutation-ts/session')]: { phase: 'baseline' },
    __stryker__: { currentTestId: 'spec-1' },
  });
  vm.runInContext(transpiled, realm);
  realm.api = realm.exports;

  // Simulate 5,000 loop iterations on checkConst (values 0..4800 and 5000..5199, leaving 4801..4999 open).
  for (let i = 0; i <= 4800; i++) assert.equal(realm.api.checkConst(i), false);
  for (let i = 5000; i < 5200; i++) assert.equal(realm.api.checkConst(i), true);

  // Simulate checkMargin on another test ('spec-2') with varying RHS (10 and 20) and margin >= 5 (leaving margin 1..4 open).
  realm.__stryker__.currentTestId = 'spec-2';
  assert.equal(realm.api.checkMargin(15, 10), true);
  assert.equal(realm.api.checkMargin(18, 20), false);

  const compEntries = Object.values(realm.__stryker__.comparisons ?? {});
  assert.equal(compEntries.length, 2);
  const constSlot = Object.values(compEntries[0])[0];
  assert.equal(constSlot.overflow, true);
  assert.ok(constSlot.rows.length <= 1024);

  // Convert to analysis trace rows and verify threshold + margin synthesis plus unreached site tracking.
  const tests = new Map([
    ['spec-1', { id: 'spec-1', project: 'chromium', file: 'e2e/a.spec.ts', name: 'checks const', status: 'passed' }],
    ['spec-2', { id: 'spec-2', project: 'chromium', file: 'e2e/b.spec.ts', name: 'checks margin', status: 'passed' }],
  ]);
  // Build mock subjects matching src/rules.ts comparison sites.
  const { extract } = await_extract();
  function await_extract() { return { extract: null }; }
  const trace = comparisonRecordsToTrace([{
    comparisons: realm.__stryker__.comparisons,
    loadedComparisons: realm.__stryker__.loadedComparisons,
  }], tests, [
    { file: 'src/rules.ts', sites: [
      { id: 'site-const', edit: [source.indexOf('>='), source.indexOf('>=') + 2], operator: '>=' },
      { id: 'site-margin', edit: [source.lastIndexOf('>='), source.lastIndexOf('>=') + 2], operator: '>=' },
      { id: 'site-unused', edit: [source.indexOf('<'), source.indexOf('<') + 1], operator: '<' },
    ] },
  ]);
  assert.ok(trace.rows.some(r => Array.isArray(r.loaded) && r.loaded.includes('site-unused')));
  assert.equal(trace.overflowSites.has('site-const'), true);
  assert.equal(trace.overflowSites.has('site-margin'), false);

  const subjects = [{
    file: 'src/rules.ts',
    input: source,
    sites: [
      {
        id: 'site-const',
        rule: 'comparison-boundary/v1',
        operator: '>=',
        edit: [source.indexOf('>='), source.indexOf('>=') + 2],
        left: [source.indexOf('n >='), source.indexOf('n >=') + 1],
        right: [source.indexOf('5000'), source.indexOf('5000') + 4],
        replacement: '>',
        location: { file: 'src/rules.ts', line: 1, column: 43, start: source.indexOf('>='), end: source.indexOf('>=') + 2 },
      },
      {
        id: 'site-margin',
        rule: 'comparison-boundary/v1',
        operator: '>=',
        edit: [source.lastIndexOf('>='), source.lastIndexOf('>=') + 2],
        left: [source.indexOf('a >='), source.indexOf('a >=') + 1],
        right: [source.indexOf('b;'), source.indexOf('b;') + 1],
        replacement: '>',
        location: { file: 'src/rules.ts', line: 2, column: 55, start: source.lastIndexOf('>='), end: source.lastIndexOf('>=') + 2 },
      },
    ],
  }];
  const baseline = { status: 'passed', tests: [...tests.values()] };
  const planned = planFocusedTrials(subjects, trace.rows, baseline, {}, false);
  const thresholdTrial = planned.find(t => t.rule === 'comparison-threshold/v1');
  const marginTrial = planned.find(t => t.rule === 'comparison-margin/v1');
  assert.ok(thresholdTrial, 'expected comparison-threshold/v1 trial even after loop overflow');
  assert.equal(thresholdTrial.replacement, '4999');
  assert.ok(marginTrial, 'expected comparison-margin/v1 trial');
  assert.equal(marginTrial.replacement, '((b) - 1)');
});

test('coordinator and server preload enforce loopback token auth and merge multi-navigation + server snapshots', async () => {
  const { createPlaywrightCoordinator, mergeRealmSnapshots } = await import('../src/playwright-bridge.mjs');
  const coordinator = await createPlaywrightCoordinator({ maxBodyBytes: 2048 });
  try {
    const addr = new URL(coordinator.url);
    assert.equal(addr.hostname, '127.0.0.1');

    // Missing or wrong token must be rejected with 403.
    const noToken = await fetch(`${coordinator.url}/state`);
    assert.equal(noToken.status, 403);
    const badToken = await fetch(`${coordinator.url}/state`, { headers: { 'x-tmt-token': '0'.repeat(64) } });
    assert.equal(badToken.status, 403);

    // Browser Origin or Sec-Fetch-Site headers must be rejected even with a valid token.
    const fromBrowserOrigin = await fetch(`${coordinator.url}/state`, {
      headers: { 'x-tmt-token': coordinator.token, Origin: 'http://evil.example' },
    });
    assert.equal(fromBrowserOrigin.status, 403);

    // Oversized body must be rejected with 413.
    const oversized = await fetch(`${coordinator.url}/record`, {
      method: 'POST',
      headers: { 'x-tmt-token': coordinator.token, 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    });
    assert.equal(oversized.status, 413);

    // Authenticated state transition + multi-navigation browser merge.
    await coordinator.setState({ phase: 'baseline', currentTestId: 'pw-test-1' });
    const stateRes = await fetch(`${coordinator.url}/state`, { headers: { 'x-tmt-token': coordinator.token } });
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.currentTestId, 'pw-test-1');

    const bucket = coordinator.createBucket();
    // Simulate navigation 1 (agreeing observation + 600 comparison rows) + navigation 2 (differing observation + 600 rows -> bounded at 1024).
    const rowsA = Array.from({ length: 600 }, (_, i) => [i, 1000, true]);
    const rowsB = Array.from({ length: 600 }, (_, i) => [600 + i, 1000, i < 400]);
    mergeRealmSnapshots(bucket, {
      hitCount: 0,
      mutantCoverage: { static: {}, perTest: { 'pw-test-1': { m1: 1 } } },
      observed: { m1: { tests: { 'pw-test-1': [1, 0, 0] }, agree: ['false'] } },
      comparisons: { 'src/a.ts:10': { 'pw-test-1': { rows: rowsA, overflow: false, invalid: false } } },
      loadedComparisons: ['src/a.ts:10'],
    });
    mergeRealmSnapshots(bucket, {
      hitCount: 0,
      mutantCoverage: { static: {}, perTest: { 'pw-test-1': { m1: 2 } } },
      observed: { m1: { tests: { 'pw-test-1': [0, 1, 0] }, differ: ['true', 'false'] } },
      comparisons: { 'src/a.ts:10': { 'pw-test-1': { rows: rowsB, overflow: false, invalid: false } } },
      loadedComparisons: ['src/a.ts:10'],
    });
    assert.equal(bucket.mutantCoverage.perTest['pw-test-1'].m1, 3);
    assert.deepEqual(bucket.observed.m1.tests['pw-test-1'], [1, 1, 0]);
    assert.deepEqual(bucket.observed.m1.differ, ['true', 'false']);
    const mergedSlot = bucket.comparisons['src/a.ts:10']['pw-test-1'];
    assert.equal(mergedSlot.rows.length, 1024);
    assert.equal(mergedSlot.overflow, true);
    assert.ok(mergedSlot.extrema.maxFalse);
  } finally {
    await coordinator.close();
  }
});

test('PICT playwright-targeted matrix satisfies every cross-realm, synthesis, and soundness invariant', async () => {
  const { readFileSync } = await import('node:fs');
  const { simulatePlaywrightMatrixRow } = await import('../src/playwright-plan.mjs');

  const tableLines = readFileSync(new URL('../verification/pict/playwright-targeted.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const seedLines = readFileSync(new URL('../verification/pict/playwright-targeted.seed.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const tableSet = new Set(tableLines);
  for (const seed of seedLines) assert.ok(tableSet.has(seed), `Missing mandatory PICT seed: ${seed}`);

  for (const line of tableLines) {
    const [realm, ruleClass, testBehavior, executionMode] = line.split('\t');
    const outcome = simulatePlaywrightMatrixRow({ realm, ruleClass, testBehavior, executionMode });

    if (realm === 'UnreachedCode') {
      if (executionMode === 'AuditRewrite') {
        assert.equal(outcome.operatorExecution, 'source-rewrite', line);
      } else {
        assert.equal(outcome.status, 'unreached', line);
        assert.equal(outcome.warmRuns, 0, line);
        assert.equal(outcome.isolatedRuns, 0, line);
      }
      continue;
    }

    if (executionMode === 'AuditRewrite') {
      assert.equal(outcome.operatorExecution, 'source-rewrite', line);
      assert.ok(outcome.audit !== undefined, line);
      continue;
    }

    if (ruleClass === 'ServerStaticInit') {
      // TLA+ invariant ServerStaticNeverWarm: never settled by warm switching.
      assert.equal(outcome.warmSettled, false, line);
      assert.equal(outcome.isolatedRuns >= 1, true, line);
      continue;
    }

    if (executionMode === 'IsolatedTrials') {
      assert.equal(outcome.warmSettled, false, line);
      continue;
    }

    if (executionMode === 'DeterministicReplay' &&
        ['ComparisonBoundary', 'ConstantThreshold', 'VariableMargin'].includes(ruleClass) &&
        testBehavior === 'AgreesAllInputs') {
      assert.equal(outcome.evidence, 'predicted', line);
      assert.equal(outcome.status, 'survived', line);
      assert.equal(outcome.gapKind, 'INPUT GAP', line);
      continue;
    }

    if (testBehavior === 'PollutesServerState') {
      // TLA+ invariant CleanIdleServer: polluted control discards warm verdict, restarts server, and settles via isolated fallback.
      assert.equal(outcome.fallback, 'control-differs', line);
      assert.equal(outcome.serverRestarted, true, line);
      assert.equal(outcome.isolatedRuns, 1, line);
      continue;
    }

    if (testBehavior === 'KillsMutant') {
      assert.equal(outcome.status, 'killed', line);
      assert.equal(outcome.diagnosticCount, 0, line);
    } else if (testBehavior === 'DivergesWithoutAssert') {
      assert.equal(outcome.status, 'survived', line);
      assert.equal(outcome.gapKind, 'ASSERTION GAP', line);
    } else if (testBehavior === 'AgreesAllInputs') {
      assert.equal(outcome.status, 'survived', line);
      assert.equal(outcome.gapKind, 'INPUT GAP', line);
    }
  }
});

test('Round 1 review regressions: per-test control check, isolated inventory/hit guard, independent deterministic coverage, BigInt extrema, and redirect block', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { assessIsolatedPlaywrightPass, verifyPlaywrightControl } = await import('../src/playwright-plan.mjs');
  const { mergeRealmSnapshots, createEmptyBucket } = await import('../src/playwright-bridge.mjs');
  const { harvestOrigins } = await import('../src/playwright-worker-preload.mjs');
  const { prepareAnalysisFromTrace } = await import('../src/analysis.mjs');

  // 1. Per-test control check rejects [1, 1] -> [2, 0] hit redistribution even when total hits (2) match.
  const baselinePerTest = new Map([['tA', 1], ['tB', 1]]);
  const redistributedControl = {
    status: 'passed',
    tests: [{ id: 'tA', status: 'passed' }, { id: 'tB', status: 'passed' }],
    records: [{ coverage: { perTest: { tA: { sw1: 2 }, tB: { sw1: 0 } } } }],
  };
  assert.equal(verifyPlaywrightControl(redistributedControl, ['tA', 'tB'], 'sw1', baselinePerTest), false);
  const matchingControl = {
    status: 'passed',
    tests: [{ id: 'tA', status: 'passed' }, { id: 'tB', status: 'passed' }],
    records: [{ coverage: { perTest: { tA: { sw1: 1 }, tB: { sw1: 1 } } } }],
  };
  assert.equal(verifyPlaywrightControl(matchingControl, ['tA', 'tB'], 'sw1', baselinePerTest), true);

  // 2. Isolated pass rejects zero-hit pass and skipped reaching test (never misclassifying as `survived`).
  const passedMap = new Map([
    ['tA', { id: 'tA', project: 'chromium', file: 'e2e/a.spec.ts', name: 'A', status: 'passed' }],
    ['tB', { id: 'tB', project: 'chromium', file: 'e2e/a.spec.ts', name: 'B', status: 'passed' }],
  ]);
  assert.equal(assessIsolatedPlaywrightPass({
    isoPass: { status: 'passed', totalHits: 0, tests: [{ id: 'tA', status: 'passed' }] },
    plan: { serverStatic: false, hitLimit: 100 },
    expectedTestIds: ['tA'],
    passedTests: passedMap,
  }).status, 'unstable');
  assert.equal(assessIsolatedPlaywrightPass({
    isoPass: { status: 'passed', totalHits: 2, tests: [{ id: 'tA', status: 'skipped' }, { id: 'tB', status: 'passed' }] },
    plan: { serverStatic: false, hitLimit: 100 },
    expectedTestIds: ['tA', 'tB'],
    passedTests: passedMap,
  }).status, 'unstable');

  // 3. Partial-reach `--deterministic` requires independent `__tmtCover` count agreement (never self-comparing trace).
  const dir = mkdtempSync(join(tmpdir(), 'tmt-pw-det-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const srcText = 'export const check = (n: number) => n >= 18;\n';
    writeFileSync(join(dir, 'src/a.ts'), srcText, 'utf8');
    const opOffset = Buffer.from(srcText).indexOf('>=');
    const probe = prepareAnalysisFromTrace(dir, ['src/a.ts'], { runner: 'playwright', deterministic: true }, {
      baseline: { status: 'passed', tests: [...passedMap.values()] },
      trace: [],
      deterministicStable: true,
    });
    const siteId = probe.subjects[0].sites[0].id;
    // Only `tA` has recorded trace rows (`tB` is another passing test), and independent switch coverage says `tA` had 2 hits (mismatch with 1 trace row!).
    const mismatched = prepareAnalysisFromTrace(dir, ['src/a.ts'], { runner: 'playwright', deterministic: true }, {
      baseline: { status: 'passed', tests: [...passedMap.values()] },
      trace: [
        { loaded: [siteId] },
        { site: siteId, identity: { id: 'tA', project: 'chromium', file: 'e2e/a.spec.ts' }, operands: [20, 18], result: true, operator: '>=' },
      ],
      deterministicStable: true,
      deterministicCoverageByKey: {
        [`src/a.ts:${opOffset}`]: { [JSON.stringify(['chromium', 'e2e/a.spec.ts', 'tA'])]: 2 },
      },
    });
    assert.equal(mismatched.skips.size, 0, 'mismatched independent switch count must forbid predicted skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. BigInt exact difference preserves ordering near MAX_SAFE_INTEGER (`MAX_SAFE_INTEGER - (-2)` > `MAX_SAFE_INTEGER - (-1)`).
  const source = Buffer.from('export const wide = (a: number, b: number) => a >= b;\n');
  const switched = renderBuiltinSwitches(source, 'src/wide.ts', () => true, {
    dialect: 'ts',
    targeted: true,
    shifts: true,
    recordComparisons: true,
    trackLoadedFile: true,
    keep: targetedOrBoundary,
  });
  const js = ts.transpileModule(switched.output, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const ctx = vm.createContext({
    exports: {},
    [Symbol.for('targeted-mutation-ts/session')]: { phase: 'baseline' },
    __stryker__: { currentTestId: 't1' },
  });
  vm.runInContext(js, ctx);
  assert.deepEqual([...ctx.__stryker__.loadedFiles], ['src/wide.ts']);
  assert.equal(Object.keys(ctx).includes('__stryker__'), true); // passed in initial sandbox object
  for (let i = 0; i < 1024; i++) ctx.exports.wide(10, 5);
  ctx.exports.wide(Number.MAX_SAFE_INTEGER, -1);
  ctx.exports.wide(Number.MAX_SAFE_INTEGER, -2);
  const wideSlot = Object.values(Object.values(ctx.__stryker__.comparisons)[0])[0];
  assert.deepEqual([...wideSlot.extrema.maxTrue], [Number.MAX_SAFE_INTEGER, -2, true]);

  const mergedBucket = createEmptyBucket();
  mergeRealmSnapshots(mergedBucket, {
    comparisons: {
      'src/wide.ts:48': {
        t1: {
          rows: Array.from({ length: 1024 }, () => [10, 5, true]),
          overflow: true,
          extrema: { maxTrue: [Number.MAX_SAFE_INTEGER, -1, true] },
        },
      },
    },
  });
  mergeRealmSnapshots(mergedBucket, {
    comparisons: {
      'src/wide.ts:48': {
        t1: {
          rows: [[Number.MAX_SAFE_INTEGER, -2, true]],
          overflow: false,
        },
      },
    },
  });
  assert.deepEqual(mergedBucket.comparisons['src/wide.ts:48'].t1.extrema.maxTrue, [Number.MAX_SAFE_INTEGER, -2, true]);

  // 5. `harvestOrigins` blocks HTTP redirects (`redirect: 'error'`) so `x-tmt-token` is never sent to redirect target.
  let leakedHeader = null;
  const targetSrv = createServer((req, res) => {
    leakedHeader = req.headers['x-tmt-token'] ?? null;
    res.writeHead(200).end('target');
  });
  await new Promise(r => targetSrv.listen(0, '127.0.0.1', r));
  const targetUrl = `http://127.0.0.1:${targetSrv.address().port}/capture`;
  const redirectSrv = createServer((_req, res) => {
    res.writeHead(302, { Location: targetUrl }).end();
  });
  await new Promise(r => redirectSrv.listen(0, '127.0.0.1', r));
  const redirectOrigin = `http://127.0.0.1:${redirectSrv.address().port}`;
  try {
    const harvestRes = await harvestOrigins([redirectOrigin], 'secret-token-value');
    assert.equal(harvestRes.serverCooperating, false);
    assert.equal(leakedHeader, null, 'redirect target must never receive x-tmt-token');
  } finally {
    await new Promise(r => redirectSrv.close(r));
    await new Promise(r => targetSrv.close(r));
  }
});

test('Round 2 review regressions: BigInt-free extrema, boot-time comparisons, multi-origin cooperation, loopback check, startup error guard, and PID lstart guard', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { isLoopbackRemoteAddress } = await import('../src/playwright-bridge.mjs');
  const { classifyIsolatedStartupFailure, indexPlaywrightBaseline } = await import('../src/playwright-plan.mjs');
  const { harvestOrigins } = await import('../src/playwright-worker-preload.mjs');
  const { terminateRecordedPids } = await import('../src/playwright.mjs');
  const { completeAnalysis, prepareAnalysisFromTrace } = await import('../src/analysis.mjs');

  // 1. Deleted/overwritten `globalThis.BigInt` never breaks target code or overflow extrema tracking.
  const srcBuf = Buffer.from('export const wide = (a: number, b: number) => a >= b;\n');
  const rendered = renderBuiltinSwitches(srcBuf, 'src/wide.ts', () => true, {
    dialect: 'ts',
    targeted: true,
    shifts: true,
    recordComparisons: true,
    keep: targetedOrBoundary,
  });
  const transpiled = ts.transpileModule(rendered.output, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const noBigIntCtx = vm.createContext({
    exports: {},
    BigInt: undefined,
    [Symbol.for('targeted-mutation-ts/session')]: { phase: 'baseline' },
    __stryker__: { currentTestId: 't1' },
  });
  vm.runInContext(transpiled, noBigIntCtx);
  for (let i = 0; i < 1024; i++) assert.equal(noBigIntCtx.exports.wide(10, 5), true);
  assert.equal(noBigIntCtx.exports.wide(Number.MAX_SAFE_INTEGER, -1), true);
  assert.equal(noBigIntCtx.exports.wide(Number.MAX_SAFE_INTEGER, -2), true);
  assert.equal(noBigIntCtx.exports.wide(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), false);
  const slot = Object.values(Object.values(noBigIntCtx.__stryker__.comparisons)[0])[0];
  assert.deepEqual([...slot.extrema.maxTrue], [Number.MAX_SAFE_INTEGER, -2, true]);
  assert.deepEqual([...slot.extrema.minFalse], [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false]);

  // 2. Boot-time (`phase: 'boot'`) comparison records `identity: null` row, preventing `--deterministic` false skip
  //    and keeping isolated `survived` verdicts as `survived` (never downgraded to `unreached`).
  const bootDir = mkdtempSync(join(tmpdir(), 'tmt-pw-boot-'));
  try {
    mkdirSync(join(bootDir, 'src'), { recursive: true });
    const bootSrc = 'export const BOOT_OK = 18 >= 18;\nexport const check = (n: number) => n >= 18;\n';
    writeFileSync(join(bootDir, 'src/boot.ts'), bootSrc, 'utf8');
    const bootRendered = renderBuiltinSwitches(Buffer.from(bootSrc), 'src/boot.ts', () => true, {
      dialect: 'ts',
      targeted: true,
      shifts: true,
      recordComparisons: true,
      keep: targetedOrBoundary,
    });
    const bootJs = ts.transpileModule(bootRendered.output, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const bootCtx = vm.createContext({
      exports: {},
      [Symbol.for('targeted-mutation-ts/session')]: { phase: 'boot' },
      __stryker__: {},
    });
    vm.runInContext(bootJs, bootCtx);
    assert.equal(bootCtx.exports.BOOT_OK, true);
    const bootKeys = Object.keys(bootCtx.__stryker__.comparisons);
    assert.equal(bootKeys.length, 1, 'boot-time comparison must be recorded during phase === boot');

    const t1 = { id: 't1', project: 'chromium', file: 'e2e/a.spec.ts', name: 'A', status: 'passed' };
    const passedMap = new Map([['t1', t1]]);
    const probe = prepareAnalysisFromTrace(bootDir, ['src/boot.ts'], { runner: 'playwright', deterministic: true }, {
      baseline: { status: 'passed', tests: [t1] },
      trace: [],
      deterministicStable: true,
    });
    const traceFromBoot = comparisonRecordsToTrace([{
      comparisons: bootCtx.__stryker__.comparisons,
      loadedComparisons: bootCtx.__stryker__.loadedComparisons,
    }], passedMap, probe.subjects);
    const bootOpOffset = Buffer.from(bootSrc).indexOf('>=');
    const prepped = prepareAnalysisFromTrace(bootDir, ['src/boot.ts'], { runner: 'playwright', deterministic: true }, {
      baseline: { status: 'passed', tests: [t1] },
      trace: traceFromBoot.rows,
      serverStaticComparisonKeys: [`src/boot.ts:${bootOpOffset}`],
      deterministicStable: true,
      deterministicCoverageByKey: {},
    });
    assert.equal(prepped.skips.size, 0, 'boot-evaluated comparison must never be predicted-skipped under --deterministic');
    const finished = completeAnalysis(prepped, () => ({ status: 'survived' }));
    const bootMutant = finished.mutants.find(m => m.location.line === 1);
    assert.equal(bootMutant.status, 'survived', 'isolated survived serverStatic comparison must not be downgraded to unreached');
  } finally {
    rmSync(bootDir, { recursive: true, force: true });
  }

  // 3. Loopback remoteAddress enforcement & multi-origin `serverCooperating` requires ALL origins + ALL records.
  assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('::1'), true);
  assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('192.168.1.25'), false);
  assert.equal(isLoopbackRemoteAddress('10.0.0.5'), false);

  const coopSrv = createServer((req, res) => {
    if (req.url === '/__tmt_harvest__' && req.headers['x-tmt-token'] === 'tok') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-tmt-harvested': '1' }).end(JSON.stringify({
        cooperating: true,
        bootStatic: {},
        snapshot: { hitCount: 0, mutantCoverage: { static: {}, perTest: {} }, observed: {}, comparisons: {}, loadedComparisons: [], loadedFiles: [] },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const nonCoopSrv = createServer((_req, res) => {
    res.writeHead(404).end('plain static server');
  });
  await new Promise(r => coopSrv.listen(0, '127.0.0.1', r));
  await new Promise(r => nonCoopSrv.listen(0, '127.0.0.1', r));
  try {
    const o1 = `http://127.0.0.1:${coopSrv.address().port}`;
    const o2 = `http://127.0.0.1:${nonCoopSrv.address().port}`;
    const multiHarvest = await harvestOrigins([o1, o2], 'tok');
    assert.equal(multiHarvest.serverCooperating, false, 'mixed Node + non-Node origins must report serverCooperating: false');

    const bothCoop = await harvestOrigins([o1], 'tok');
    assert.equal(bothCoop.serverCooperating, true);

    const pTests = new Map([['t1', { id: 't1', status: 'passed' }], ['t2', { id: 't2', status: 'passed' }]]);
    const partialIndexed = indexPlaywrightBaseline([
      { testId: 't1', serverCooperating: true, loadedFiles: ['src/a.ts'] },
      { testId: 't2', serverCooperating: false, loadedFiles: ['src/a.ts'] },
    ], pTests);
    assert.equal(partialIndexed.serverCooperating, false);
    assert.deepEqual([...partialIndexed.recordedTestIds], ['t1', 't2']);
  } finally {
    await new Promise(r => coopSrv.close(r));
    await new Promise(r => nonCoopSrv.close(r));
  }

  // 4. Isolated startup failure without mutant hits (`startupHitCount === 0`) is `error`, NOT `killed`.
  const pTestsSingle = new Map([['t1', { id: 't1', project: 'chromium', file: 'e2e/a.spec.ts', name: 'A', status: 'passed' }]]);
  assert.equal(classifyIsolatedStartupFailure({
    plan: { serverStatic: true },
    started: { status: 'failed', errors: ['EADDRINUSE'] },
    startupHitCount: 0,
    passedTests: pTestsSingle,
  }).status, 'error');
  assert.equal(classifyIsolatedStartupFailure({
    plan: { serverStatic: true },
    started: { status: 'failed', errors: ['Mutant boot crash'] },
    startupHitCount: 1,
    passedTests: pTestsSingle,
  }).status, 'killed');

  // 5. `terminateRecordedPids` skips recycled PIDs whose `lstart` signature does not match.
  const pidDir = mkdtempSync(join(tmpdir(), 'tmt-pw-pid-'));
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const pidsFile = join(pidDir, 'pids.jsonl');
    writeFileSync(pidsFile, JSON.stringify({ kind: 'server', pid: sleeper.pid, lstart: 'Mon Jan  1 00:00:00 1999' }) + '\n', 'utf8');
    terminateRecordedPids(pidsFile, { readStartSignature: () => 'Fri Nov 27 18:50:00 2026' });
    // Process must STILL be alive because `lstart` mismatched!
    assert.doesNotThrow(() => process.kill(sleeper.pid, 0));

    // Now match `lstart` -> process is terminated cleanly.
    writeFileSync(pidsFile, JSON.stringify({ kind: 'server', pid: sleeper.pid, lstart: 'Fri Nov 27 18:50:00 2026' }) + '\n', 'utf8');
    terminateRecordedPids(pidsFile, { readStartSignature: () => 'Fri Nov 27 18:50:00 2026' });
    await new Promise(resolveExit => sleeper.once('exit', resolveExit));
  } finally {
    try { sleeper.kill('SIGKILL'); } catch {}
    rmSync(pidDir, { recursive: true, force: true });
  }
});
