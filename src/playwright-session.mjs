import childProcess, { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { comparisonRecordsToTrace, createEmptyBucket, drainSpoolDirectory, writeAtomicJson } from './playwright-bridge.mjs';
import {
  assessIsolatedPlaywrightPass,
  classifyIsolatedStartupFailure,
  classifyPlaywrightWarmTrial,
  effectsFromPlaywrightRecords,
  indexPlaywrightBaseline,
} from './playwright-plan.mjs';
import { createPlaywrightConfigWrapper, readPidStartSignature, testFilters } from './playwright.mjs';
import { sampleSettled } from './standard-plan.mjs';
import { sameObservations } from './trace-buffer.mjs';
import { failedTests } from './vitest-reporter.mjs';
import { runnerPackage } from './vitest.mjs';

const workerPreloadUrl = pathToFileURL(fileURLToPath(new URL('./playwright-worker-preload.mjs', import.meta.url))).href;

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const {
  workspace,
  originalRoot,
  config,
  projects = [],
  tests = [],
  subjectFiles = [],
  pidsFile,
  output,
  temporary,
  awaitsExtras = false,
  deterministic = false,
  isolatedTrials = false,
  verifyTrials = 0,
  runTimeout = 60_000,
  baselineTimeout = runTimeout,
  mutants = [],
} = input;

const record = event => appendFileSync(output, JSON.stringify(event) + '\n');
const shiftSwitches = new Map(
  mutants.filter(mutant => mutant.parametric).map(mutant => [`${mutant.parametric.file}:${mutant.parametric.at}`, mutant.id]),
);

async function waitExtrasFromParent() {
  const path = resolve(temporary, 'extras.json');
  for (let waited = 0; waited < 600_000 && !existsSync(path); waited += 25) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function readRecordsFile(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function formatTestName(testCase) {
  const parts = typeof testCase.titlePath === 'function' ? testCase.titlePath() : [];
  if (parts.length >= 4) return parts.slice(3).join(' > ');
  const titles = [];
  for (let cur = testCase; cur && cur.parent && cur.parent.parent; cur = cur.parent) {
    if (cur.title && cur.parent.parent.parent) titles.unshift(cur.title);
    else if (cur === testCase) titles.unshift(cur.title);
  }
  return titles.join(' > ') || testCase.title || '';
}

function escapeLocationPattern(relFile) {
  return String(relFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recordManagedPid(kind, pid) {
  if (!pidsFile || !Number.isInteger(pid) || pid <= 1) return;
  try {
    const lstart = readPidStartSignature(pid);
    appendFileSync(pidsFile, JSON.stringify({ kind, pid, ...(lstart ? { lstart } : {}) }) + '\n', 'utf8');
  } catch {}
}

let exitStatus = 1;
let runner = null;
let browserServer = null;
let cleaningUp = false;

async function cleanupResources() {
  if (cleaningUp) return;
  cleaningUp = true;
  if (runner) {
    await Promise.race([runner.stopTests().catch(() => {}), new Promise(r => setTimeout(r, 2_000))]);
    await Promise.race([runner.runGlobalTeardown().catch(() => {}), new Promise(r => setTimeout(r, 5_000))]);
    await Promise.race([runner.closeGracefully?.().catch?.(() => {}), new Promise(r => setTimeout(r, 2_000))]);
  }
  if (browserServer) {
    await Promise.race([browserServer.close().catch(() => {}), new Promise(r => setTimeout(r, 3_000))]);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    cleanupResources().finally(() => process.exit(124));
  });
}

async function runSession() {
  const trialFile = resolve(temporary, 'pw-trial.json');
  const stateFile = resolve(temporary, 'pw-state.json');
  const recordsFile = resolve(temporary, 'pw-records.jsonl');
  const spoolDir = resolve(temporary, 'pw-spool');
  const originsFile = resolve(temporary, 'pw-origins.json');
  const token = randomBytes(32).toString('hex');
  mkdirSync(spoolDir, { recursive: true });

  process.env.CI = 'true';
  process.env.TMT_WORKSPACE = workspace;
  process.env.TMT_ORIGINAL = originalRoot ?? '';
  process.env.TMT_PW_TRIAL_FILE = trialFile;
  process.env.TMT_PW_STATE_FILE = stateFile;
  process.env.TMT_PW_RECORDS_FILE = recordsFile;
  process.env.TMT_PW_SPOOL_DIR = spoolDir;
  process.env.TMT_PW_ORIGINS_FILE = originsFile;
  if (pidsFile) process.env.TMT_PW_PIDS_FILE = pidsFile;
  process.env.TMT_PW_TOKEN = token;
  const baseNodeOptions = process.env.NODE_OPTIONS ?? '';
  if (!baseNodeOptions.includes(workerPreloadUrl)) {
    process.env.NODE_OPTIONS = `${baseNodeOptions} --import ${workerPreloadUrl}`.trim();
  }

  const bridgeEnv = {
    TMT_WORKSPACE: workspace,
    TMT_PW_STATE_FILE: stateFile,
    TMT_PW_SPOOL_DIR: spoolDir,
    ...(pidsFile ? { TMT_PW_PIDS_FILE: pidsFile } : {}),
    TMT_PW_TOKEN: token,
  };

  let wrapperPath;
  try {
    wrapperPath = createPlaywrightConfigWrapper(workspace, config, {
      injectServerPreload: true,
      originsFile,
      bridgeEnv,
    });
  } catch (configErr) {
    record({ baseline: { status: 'error', output: configErr.message, errors: [configErr.message] } });
    exitStatus = 0;
    return;
  }

  const pwPkgPath = runnerPackage(workspace, 'playwright');
  const reqFromWorkspace = createRequire(pwPkgPath);
  let TestRunner;
  let playwrightLib;
  try {
    const pwCorePkg = reqFromWorkspace.resolve('playwright/package.json');
    const runnerMod = reqFromWorkspace(resolve(dirname(pwCorePkg), 'lib/runner/index.js'));
    TestRunner = runnerMod?.testRunner?.TestRunner;
    playwrightLib = reqFromWorkspace(resolve(dirname(pwPkgPath), 'index.js'));
  } catch {
    TestRunner = null;
  }
  if (!TestRunner) {
    record({ unsupportedSession: 'playwright-runner-api-unavailable' });
    exitStatus = 0;
    return;
  }

  runner = new TestRunner(
    { resolvedConfigFile: wrapperPath, configDir: dirname(wrapperPath) },
    { workers: 1, retries: 0 },
  );
  await runner.initialize({ watchTestDirs: false });

  let loadedConfig;
  try {
    loadedConfig = await runner.loadConfig();
  } catch (loadErr) {
    record({ baseline: { status: 'error', output: loadErr.message, errors: [loadErr.message] } });
    exitStatus = 0;
    return;
  }

  const origins = existsSync(originsFile) ? JSON.parse(readFileSync(originsFile, 'utf8')) : [];
  const projectBrowserMap = new Map();
  const activeProjects = (loadedConfig.projects ?? []).filter(proj =>
    !projects.length || projects.includes(proj.project?.name ?? proj.name));
  const topRepeatEach = Number(loadedConfig.config?.repeatEach ?? loadedConfig.repeatEach ?? 1);
  if (topRepeatEach > 1 || activeProjects.some(proj => Number((proj.project ?? proj)?.repeatEach ?? 1) > 1)) {
    record({ unsupportedSession: 'repeat-each-configured' });
    exitStatus = 0;
    return;
  }
  for (const proj of loadedConfig.projects ?? []) {
    const pObj = proj.project ?? proj;
    const name = pObj.name ?? '';
    const bName = pObj.metadata?.tmtBrowser ?? pObj.use?.browserName ?? pObj.use?.defaultBrowserType ?? 'chromium';
    projectBrowserMap.set(name, bName);
  }

  const distinctBrowsers = new Set(activeProjects.map(proj => {
    const pObj = proj.project ?? proj;
    return pObj.metadata?.tmtBrowser ?? pObj.use?.browserName ?? pObj.use?.defaultBrowserType ?? 'chromium';
  }));
  const hasCustomLaunch = activeProjects.some(proj => {
    const use = (proj.project ?? proj).use ?? {};
    return Boolean(use.channel || use.connectOptions || (use.launchOptions && Object.keys(use.launchOptions).length > 0));
  });
  let connectWsEndpoint;
  if (distinctBrowsers.size === 1 && !hasCustomLaunch) {
    const [singleBrowser] = [...distinctBrowsers];
    if (['chromium', 'firefox', 'webkit'].includes(singleBrowser) && typeof playwrightLib?.[singleBrowser]?.launchServer === 'function') {
      try {
        browserServer = await playwrightLib[singleBrowser].launchServer({ headless: true });
        recordManagedPid('browserServer', browserServer.process?.()?.pid);
        connectWsEndpoint = browserServer.wsEndpoint();
      } catch {
        browserServer = null;
      }
    }
  }

  let stateSeq = 1;
  const setSessionMode = ({ phase, activeMutant, shift = 0, hitLimit }) => {
    stateSeq++;
    writeAtomicJson(trialFile, { phase, activeMutant, shift, hitLimit, origins });
    writeAtomicJson(stateFile, { seq: stateSeq, phase, currentTestId: undefined, activeMutant, shift, hitLimit });
  };

  setSessionMode({ phase: 'boot' });

  const collectSetupReporter = () => {
    const setupErrors = [];
    const setupFileErrors = [];
    let stdOutText = '';
    return {
      setupErrors,
      setupFileErrors,
      getOutput: () => stdOutText,
      reporter: {
        version: () => 'v2',
        printsToStdio: () => false,
        onStdOut: chunk => { if (stdOutText.length < 262_144) stdOutText += String(chunk); },
        onStdErr: chunk => { if (stdOutText.length < 262_144) stdOutText += String(chunk); },
        onError: error => {
          const msg = String(error?.message ?? error);
          setupErrors.push(msg);
          if (error?.location?.file) {
            setupFileErrors.push({ file: relative(workspace, error.location.file), message: msg });
          }
        },
      },
    };
  };

  let serverRunning = false;
  const startManagedServer = async () => {
    const collector = collectSetupReporter();
    const origSpawn = childProcess.spawn;
    childProcess.spawn = function trackedSpawn(...args) {
      const child = origSpawn.apply(this, args);
      if (child?.pid) recordManagedPid('webServerSpawn', child.pid);
      return child;
    };
    let res;
    try {
      res = await runner.runGlobalSetup([collector.reporter]);
    } finally {
      childProcess.spawn = origSpawn;
    }
    serverRunning = res.status === 'passed';
    return { status: res.status, errors: collector.setupErrors, fileErrors: collector.setupFileErrors, output: collector.getOutput() };
  };

  const stopManagedServer = async () => {
    if (!serverRunning) return true;
    try {
      const res = await runner.runGlobalTeardown();
      if (res?.status && res.status !== 'passed') return false;
      serverRunning = false;
      return true;
    } catch {
      return false;
    }
  };

  const initialSetup = await startManagedServer();
  if (initialSetup.status !== 'passed') {
    const message = initialSetup.errors[0] ?? 'Playwright webServer / globalSetup failed to start';
    record({
      baseline: {
        status: 'error',
        errors: initialSetup.errors.length ? initialSetup.errors : [message],
        ...(initialSetup.fileErrors.length ? { fileErrors: initialSetup.fileErrors } : {}),
        output: initialSetup.output || message,
      },
    });
    exitStatus = 0;
    return;
  }

  const initialLocations = testFilters(workspace, tests);

  const executePass = async ({ phase, activeMutant, shift = 0, hitLimit, testIds, locations, maxFailures, timeoutMs = runTimeout }) => {
    rmSync(recordsFile, { force: true });
    setSessionMode({ phase, activeMutant, shift, hitLimit });

    const collectedTests = [];
    const errors = [];
    const fileErrors = [];
    let stdioLog = '';
    let timedOut = false;
    let unstable = false;
    let endStatus = 'passed';

    const reporter = {
      version: () => 'v2',
      printsToStdio: () => false,
      onStdOut(chunk) {
        if (stdioLog.length < 262_144) stdioLog += String(chunk);
      },
      onStdErr(chunk) {
        if (stdioLog.length < 262_144) stdioLog += String(chunk);
      },
      onError(error) {
        const msg = String(error?.message ?? error);
        if (/^Testing stopped early after \d+ maximum allowed failures\.$/.test(msg.trim())) return;
        errors.push(msg);
        if (error?.location?.file) {
          fileErrors.push({ file: relative(workspace, error.location.file), message: msg });
        }
      },
      onTestEnd(testCase, result) {
        const outcome = typeof testCase.outcome === 'function' ? testCase.outcome() : undefined;
        const rawStatus = result?.status;
        if (rawStatus === 'timedOut') timedOut = true;
        if (outcome === 'flaky' || rawStatus === 'interrupted') unstable = true;
        const status = outcome === 'flaky' ? 'unstable'
          : (outcome === 'skipped' || rawStatus === 'skipped') ? 'skipped'
            : (outcome === 'expected' || rawStatus === 'passed') ? 'passed'
              : 'failed';
        const projectName = testCase.parent?.project?.()?.name ?? '';
        const relFile = testCase.location?.file ? relative(workspace, testCase.location.file) : '';
        collectedTests.push({
          id: testCase.id,
          file: relFile,
          project: projectName,
          browser: projectBrowserMap.get(projectName) ?? 'chromium',
          name: formatTestName(testCase),
          status,
          duration: result?.duration ?? 0,
          worker: result?.workerIndex,
          parallelIndex: result?.parallelIndex,
          retry: result?.retry ?? 0,
          failures: (result?.errors ?? []).map(err => String(err?.message ?? err)),
        });
      },
      onEnd(result) {
        endStatus = result?.status ?? 'passed';
        if (endStatus === 'timedout') timedOut = true;
      },
    };

    let watchTimer = null;
    const deadlineFired = new Promise(resolveTimeout => {
      watchTimer = setTimeout(async () => {
        timedOut = true;
        await runner.stopTests().catch(() => {});
        resolveTimeout('timedout');
      }, timeoutMs);
    });

    try {
      await Promise.race([
        runner.runTests(reporter, {
          locations: locations?.length ? locations : undefined,
          projects: projects.length ? projects : undefined,
          testIds: testIds?.length ? testIds : undefined,
          workers: 1,
          maxFailures,
          timeout: Math.max(500, timeoutMs - 2_000),
          disableConfigReporters: true,
          failOnLoadErrors: true,
          ...(connectWsEndpoint ? { connectWsEndpoint } : {}),
        }),
        deadlineFired,
      ]);
    } finally {
      clearTimeout(watchTimer);
    }

    const records = readRecordsFile(recordsFile);
    const totalHits = records.reduce((sum, item) => sum + Number(item.hitCount ?? 0), 0);
    const failed = collectedTests.some(t => t.status === 'failed');
    const anyPassed = collectedTests.some(t => t.status === 'passed');
    const files = [...new Set(collectedTests.map(t => t.file).filter(Boolean))].sort();

    const status = timedOut
      ? 'timeout'
      : (errors.length || !collectedTests.length)
        ? 'error'
        : unstable
          ? 'unstable'
          : (!failed && anyPassed && endStatus === 'passed')
            ? 'passed'
            : failed
              ? 'failed'
              : 'error';

    return {
      status,
      ...(timedOut ? { statusReason: `Playwright timed out after ${Math.round(timeoutMs / 1000)}s` } : {}),
      timedOut,
      unstable,
      tests: collectedTests,
      files,
      errors,
      fileErrors,
      output: stdioLog,
      records,
      totalHits,
    };
  };

  const baselineStartedAt = Date.now();
  const baselinePass = await executePass({
    phase: 'baseline',
    locations: initialLocations,
    timeoutMs: baselineTimeout,
  });
  const baselineElapsed = Date.now() - baselineStartedAt;

  if (baselinePass.status !== 'passed') {
    record({
      baseline: {
        status: baselinePass.status,
        ...(baselinePass.status === 'timeout' ? { timeoutSeconds: Math.round(baselineTimeout / 1000) } : {}),
        ...(baselinePass.files.length ? { files: baselinePass.files } : {}),
        ...(baselinePass.fileErrors.length ? { fileErrors: baselinePass.fileErrors } : {}),
        errors: baselinePass.errors,
        output: baselinePass.output || baselinePass.tests.flatMap(t => t.failures).join('\n'),
        failedTests: failedTests(baselinePass),
      },
    });
    exitStatus = 0;
    return;
  }

  if (tests.length) {
    const expectedFiles = new Set(tests.map(f => relative(workspace, resolve(workspace, f))));
    const actualFiles = new Set(baselinePass.files);
    if ([...expectedFiles].some(f => !actualFiles.has(f)) || actualFiles.size !== expectedFiles.size) {
      const msg = 'Playwright test selection mismatch';
      record({ baseline: { status: 'error', files: baselinePass.files, errors: [msg], output: msg } });
      exitStatus = 0;
      return;
    }
  }

  const passedTests = new Map(baselinePass.tests.filter(t => t.status === 'passed').map(t => [t.id, t]));
  const timingByTest = new Map(baselinePass.tests.map(t => [t.id, t.duration ?? 0]));
  const indexed = indexPlaywrightBaseline(baselinePass.records, passedTests, [], timingByTest);

  // Soundness gate: every passed test must have a corresponding worker harvest record, and if `webServer` is NOT
  // a cooperating Node server (`!indexed.serverCooperating`), then EVERY instrumented subject file must have been
  // observed loading in the browser; otherwise server-side code could execute unobserved and be misclassified as `unreached`.
  if ([...passedTests.keys()].some(id => !indexed.recordedTestIds.has(id))) {
    record({ unsupportedSession: 'missing-test-records' });
    exitStatus = 0;
    return;
  }
  if (!indexed.anySwitchActivity && mutants.length > 0) {
    record({ unsupportedSession: 'no-runtime-switch-observations' });
    exitStatus = 0;
    return;
  }
  if (!indexed.serverCooperating && subjectFiles.some(file => !indexed.loadedFiles.has(file))) {
    record({ unsupportedSession: 'non-cooperating-server-with-unloaded-files' });
    exitStatus = 0;
    return;
  }

  const serverStaticComparisonKeys = [];
  for (const [cmpKey, switchId] of shiftSwitches) {
    if (indexed.planMutant(switchId).serverStatic) serverStaticComparisonKeys.push(cmpKey);
  }

  let deterministicStable;
  let deterministicCoverageByKey;
  let replayIndexed = null;
  if (deterministic) {
    const replayPass = await executePass({
      phase: 'baseline',
      locations: initialLocations,
      timeoutMs: baselineTimeout,
    });
    if (replayPass.status === 'passed') {
      replayIndexed = indexPlaywrightBaseline(replayPass.records, passedTests, [], timingByTest);
      const t1 = comparisonRecordsToTrace(indexed.normalized, passedTests, []);
      const t2 = comparisonRecordsToTrace(replayIndexed.normalized, passedTests, []);
      deterministicStable = JSON.stringify(indexed.normalized.map(r => r.comparisons)) ===
        JSON.stringify(replayIndexed.normalized.map(r => r.comparisons)) && sameObservations(t1.rows, t2.rows);
      if (deterministicStable) {
        // Record independent `__tmtCover` per-test switch hits from the 2nd replay pass for `matchesFocusedCoverage`.
        deterministicCoverageByKey = {};
        for (const [cmpKey, switchId] of shiftSwitches) {
          const replayPlan = replayIndexed.planMutant(switchId);
          if (replayPlan.serverStatic || replayPlan.staticActivation) continue;
          const byTestIdentity = {};
          for (const [tId, cnt] of replayPlan.perTestHits) {
            const tObj = passedTests.get(tId);
            if (tObj) byTestIdentity[JSON.stringify([tObj.project, tObj.file, tObj.id])] = cnt;
          }
          deterministicCoverageByKey[cmpKey] = byTestIdentity;
        }
      }
    } else {
      deterministicStable = false;
    }
  }

  if (indexed.agreement.size) {
    const named = ids => [...ids]
      .map(id => passedTests.get(id))
      .filter(Boolean)
      .map(({ id, project, file, name }) => ({ id, project, file, name }));
    record({
      observed: Object.fromEntries([...indexed.agreement].map(([id, seen]) => [id, {
        agreeing: seen.agreeing.size,
        differing: named(seen.differing),
        unsure: named(seen.unsure),
        outside: seen.outside,
        outsideUnsure: seen.outsideUnsure,
        differ: seen.differ,
        agree: seen.agree,
        unknown: seen.unknown,
        ...(seen.realCopy ? { realCopy: true } : {}),
        ...(seen.nonArray ? { nonArray: true } : {}),
        ...(seen.nonPlain ? { nonPlain: true } : {}),
        ...(seen.absorbed ? { absorbed: true } : {}),
      }])),
    });
  }

  record({
    baseline: {
      status: 'passed',
      tests: baselinePass.tests,
      elapsedMs: baselineElapsed,
    },
    comparisonRecords: indexed.normalized.map(r => ({
      comparisons: r.comparisons,
      loadedComparisons: r.loadedComparisons,
    })),
    ...(serverStaticComparisonKeys.length ? { serverStaticComparisonKeys } : {}),
    ...(deterministicStable !== undefined ? { deterministicStable } : {}),
    ...(deterministicCoverageByKey ? { deterministicCoverageByKey } : {}),
  });

  const sumObservedByTest = (normRecords, mutantId) => {
    const map = new Map();
    for (const rec of normRecords) {
      const byTest = rec.observed?.[mutantId]?.tests;
      if (!byTest) continue;
      for (const [testId, tuple] of Object.entries(byTest)) {
        const cur = map.get(testId) ?? [0, 0, 0];
        cur[0] += Number(tuple?.[0] ?? 0);
        cur[1] += Number(tuple?.[1] ?? 0);
        cur[2] += Number(tuple?.[2] ?? 0);
        map.set(testId, cur);
      }
    }
    return map;
  };
  const canPredictFullSurvivor = (mutantId, plan, seen) => {
    if (!deterministic || !deterministicStable || !replayIndexed) return false;
    if (plan.serverStatic || plan.staticActivation || !plan.perTestHits?.size) return false;
    if (!seen || !seen.agreeing.size || seen.differing.size || seen.unsure.size || seen.outside || seen.outsideUnsure) return false;
    const replayPlan = replayIndexed.planMutant(mutantId);
    if (replayPlan.serverStatic || replayPlan.staticActivation || replayPlan.perTestHits.size !== plan.perTestHits.size) return false;
    const obs1 = sumObservedByTest(indexed.normalized, mutantId);
    const obs2 = sumObservedByTest(replayIndexed.normalized, mutantId);
    if (obs1.size !== plan.perTestHits.size || obs2.size !== plan.perTestHits.size) return false;
    for (const [testId, expectedHits] of plan.perTestHits) {
      if (!passedTests.has(testId) || expectedHits <= 0) return false;
      if (replayPlan.perTestHits.get(testId) !== expectedHits) return false;
      const t1 = obs1.get(testId);
      const t2 = obs2.get(testId);
      if (!t1 || !t2) return false;
      if (t1[0] !== expectedHits || t1[1] !== 0 || t1[2] !== 0) return false;
      if (t2[0] !== expectedHits || t2[1] !== 0 || t2[2] !== 0) return false;
    }
    return true;
  };

  const reachedTestsForPlan = plan => {
    const ids = plan.serverStatic ? [...passedTests.keys()] : (plan.orderedTestIds ?? []);
    return ids
      .map(testId => passedTests.get(testId))
      .filter(Boolean)
      .map(({ id, project, file, name }) => ({ id, project, file, name }));
  };

  let completedCount = 0;
  const pending = [];
  for (const mutant of mutants.filter(candidate => !candidate.parametric)) {
    const { id } = mutant;
    const plan = indexed.planMutant(id);
    if (!plan.hits && !plan.serverStatic) {
      record({ id, status: 'unreached', evidence: 'coverage' });
      completedCount++;
      continue;
    }
    const seen = indexed.agreement.get(id);
    if (mutant.evidence && seen && !seen.differing.size && !seen.unsure.size && !seen.outside && !seen.outsideUnsure && !seen.typed) {
      record({
        id,
        status: 'ignored',
        statusReason: 'No test gives the left side a number, a string or a boolean, so both operators are taken to behave alike here',
      });
      completedCount++;
      continue;
    }
    if (mutant.sequenceIndex && seen && !seen.sequence && seen.nonSequence && !seen.threw && !seen.differing.size && !seen.outside) {
      record({
        id,
        status: 'ignored',
        statusReason: 'No test passes a sequence (array, string, or typed array) to this index expression',
      });
      completedCount++;
      continue;
    }
    if (mutant.predictableFull && canPredictFullSurvivor(id, plan, seen)) {
      const reachedTests = reachedTestsForPlan(plan);
      record({ id, status: 'survived', evidence: 'predicted', ...(reachedTests.length ? { reachedTests } : {}) });
      completedCount++;
      continue;
    }
    pending.push({ mutant, plan });
  }

  let serverRestarts = 0;
  const MAX_SERVER_RESTARTS = 4;
  const totals = { inWorker: 0, isolated: 0, sampled: 0, mismatches: [] };

  // Run an isolated trial with a freshly booted webServer (activating the mutant BEFORE webServer boot so
  // `serverStatic` bindings evaluate with the mutant active) and full worker preload + inventory verification.
  const runIsolatedTrial = async (mutant, plan, fallbackReason) => {
    totals.isolated++;
    const activeId = mutant.active ?? mutant.id;
    const stopped = await stopManagedServer();
    if (!stopped) {
      return {
        status: 'error',
        statusReason: 'Playwright webServer failed to stop cleanly before isolated trial',
        ...(fallbackReason ? { fallback: fallbackReason } : {}),
      };
    }

    drainSpoolDirectory(spoolDir, createEmptyBucket());
    setSessionMode({
      phase: 'trial',
      activeMutant: activeId,
      shift: mutant.shift ?? 0,
      hitLimit: plan.hitLimit,
    });

    const started = await startManagedServer();
    if (started.status !== 'passed') {
      const startupBucket = createEmptyBucket();
      drainSpoolDirectory(spoolDir, startupBucket);
      return classifyIsolatedStartupFailure({
        plan,
        started,
        startupHitCount: startupBucket.hitCount,
        passedTests,
        fallbackReason,
      });
    }

    const expectedTestIds = plan.serverStatic ? [...passedTests.keys()] : plan.orderedTestIds;
    const targetLocations = plan.serverStatic
      ? initialLocations
      : [...new Set(expectedTestIds.map(id => passedTests.get(id)?.file).filter(Boolean).map(escapeLocationPattern))];

    const isoPass = await executePass({
      phase: 'trial',
      activeMutant: activeId,
      shift: mutant.shift ?? 0,
      hitLimit: plan.hitLimit,
      testIds: plan.serverStatic ? undefined : expectedTestIds,
      locations: targetLocations,
      maxFailures: 1,
      timeoutMs: runTimeout,
    });

    await stopManagedServer();

    const assessed = assessIsolatedPlaywrightPass({
      isoPass,
      plan,
      expectedTestIds,
      passedTests,
    });

    let effectsObj = {};
    if (mutant.effects && assessed.status === 'survived' && isoPass.records.length) {
      effectsObj = {
        effects: effectsFromPlaywrightRecords(indexed.reach, isoPass.records, expectedTestIds, passedTests),
      };
    }
    const reachedTests = reachedTestsForPlan(plan);
    return {
      ...assessed,
      ...effectsObj,
      ...(reachedTests.length ? { reachedTests } : {}),
      ...(fallbackReason ? { fallback: fallbackReason } : {}),
    };
  };

  const decideList = async (items, emitResult) => {
    const warmSettledMap = new Map();
    const alreadyEmitted = new Set();
    const fallbackQueue = [];

    if (!isolatedTrials && serverRestarts <= MAX_SERVER_RESTARTS) {
      if (!serverRunning) {
        setSessionMode({ phase: 'control' });
        const restarted = await startManagedServer();
        if (restarted.status !== 'passed') serverRestarts = MAX_SERVER_RESTARTS + 1;
      }
    }

    if (!isolatedTrials && serverRunning && serverRestarts <= MAX_SERVER_RESTARTS) {
      for (const item of items) {
        const { mutant, plan } = item;
        if (plan.serverStatic || !plan.orderedTestIds.length || !serverRunning || serverRestarts > MAX_SERVER_RESTARTS) {
          fallbackQueue.push({ ...item, reason: plan.serverStatic ? 'server-static' : 'worker-stopped' });
          continue;
        }
        const activeId = mutant.active ?? mutant.id;
        const targetLocations = [...new Set(
          plan.orderedTestIds.map(id => passedTests.get(id)?.file).filter(Boolean).map(escapeLocationPattern),
        )];

        const trialPass = await executePass({
          phase: 'trial',
          activeMutant: activeId,
          shift: mutant.shift ?? 0,
          hitLimit: plan.hitLimit,
          testIds: plan.orderedTestIds,
          locations: targetLocations,
          maxFailures: 1,
          timeoutMs: runTimeout,
        });

        const ranIds = trialPass.tests.map(t => t.id).filter(id => passedTests.has(id));
        const executedTestIds = ranIds.length ? ranIds : plan.orderedTestIds;
        const controlLocations = [...new Set(
          executedTestIds.map(id => passedTests.get(id)?.file).filter(Boolean).map(escapeLocationPattern),
        )];

        const controlPass = await executePass({
          phase: 'control',
          activeMutant: undefined,
          shift: 0,
          hitLimit: undefined,
          testIds: executedTestIds,
          locations: controlLocations,
          maxFailures: 1,
          timeoutMs: runTimeout,
        });

        const classified = classifyPlaywrightWarmTrial({
          activeId,
          plan,
          trialPass,
          controlPass,
          executedTestIds,
          passedTests,
        });

        if (classified.verdict === 'settled') {
          let effectsObj = {};
          if (mutant.effects && classified.result.status === 'survived') {
            effectsObj = {
              effects: effectsFromPlaywrightRecords(indexed.reach, trialPass.records, executedTestIds, passedTests),
            };
          }
          const reachedTests = reachedTestsForPlan(plan);
          const settledResult = { ...classified.result, ...effectsObj, ...(reachedTests.length ? { reachedTests } : {}) };
          warmSettledMap.set(mutant.id, settledResult);
          totals.inWorker++;
          if (!verifyTrials) {
            alreadyEmitted.add(mutant.id);
            completedCount++;
            emitResult(mutant, settledResult);
          } else {
            record({ progress: { completed: completedCount + warmSettledMap.size } });
          }
        } else {
          if (classified.needsServerRestart) {
            serverRestarts++;
            const stoppedOk = await stopManagedServer();
            if (stoppedOk && serverRestarts <= MAX_SERVER_RESTARTS) {
              setSessionMode({ phase: 'control' });
              const restarted = await startManagedServer();
              if (restarted.status !== 'passed') serverRestarts = MAX_SERVER_RESTARTS + 1;
            } else {
              serverRestarts = MAX_SERVER_RESTARTS + 1;
            }
          }
          fallbackQueue.push({ ...item, reason: classified.reason });
        }
      }
    } else {
      for (const item of items) {
        fallbackQueue.push({ ...item, reason: isolatedTrials ? undefined : 'worker-stopped' });
      }
    }

    const sampled = new Set(
      sampleSettled(
        items.map(({ mutant }) => mutant.id).filter(id => warmSettledMap.has(id)),
        Math.max(0, verifyTrials - totals.sampled),
      ),
    );
    totals.sampled += sampled.size;
    const fallbackById = new Map(fallbackQueue.map(entry => [entry.mutant.id, entry]));

    for (const { mutant, plan } of items) {
      if (alreadyEmitted.has(mutant.id)) continue;
      if (warmSettledMap.has(mutant.id) && !sampled.has(mutant.id)) {
        completedCount++;
        emitResult(mutant, warmSettledMap.get(mutant.id));
        continue;
      }
      const fb = fallbackById.get(mutant.id);
      const freshOutcome = await runIsolatedTrial(mutant, plan, fb?.reason);
      if (sampled.has(mutant.id) && freshOutcome.status !== warmSettledMap.get(mutant.id).status) {
        totals.mismatches.push({
          id: mutant.id,
          worker: warmSettledMap.get(mutant.id).status,
          fresh: freshOutcome.status,
        });
      }
      completedCount++;
      emitResult(mutant, freshOutcome);
    }
  };

  await decideList(pending, (mutant, result) => record({ id: mutant.id, ...result }));

  if (awaitsExtras) {
    const rawExtras = await waitExtrasFromParent();
    const extraItems = [];
    for (const [index, extra] of rawExtras.entries()) {
      const active = shiftSwitches.get(`${extra.file}:${extra.at}`);
      const plan = active === undefined ? null : indexed.planMutant(active);
      if (!plan) { record({ extra: index, status: 'unsupported' }); completedCount++; }
      else if (!plan.hits && !plan.serverStatic) { record({ extra: index, status: 'unreached', evidence: 'coverage' }); completedCount++; }
      else extraItems.push({ mutant: { id: `extra:${index}`, index, active, shift: extra.shift }, plan });
    }
    if (extraItems.length) {
      await decideList(extraItems, (mutant, result) => record({ extra: mutant.index, ...result }));
    }
  }

  record({
    trials: {
      workers: 1,
      inWorker: totals.inWorker,
      isolated: totals.isolated,
      ...(verifyTrials ? { verified: { sampled: totals.sampled, mismatches: totals.mismatches } } : {}),
    },
  });
  record({ complete: true });
  exitStatus = 0;
}

try {
  await runSession();
} catch (error) {
  record({ error: String(error?.message ?? error) });
} finally {
  await cleanupResources();
  process.exit(exitStatus);
}
