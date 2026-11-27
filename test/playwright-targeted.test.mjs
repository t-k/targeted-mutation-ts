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
