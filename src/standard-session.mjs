import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { createRequire, enableCompileCache } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedTests, snapshotVitestRun, timeVitestRun } from './vitest-reporter.mjs';
import { changedReach, indexAgreement, indexCoverage, indexReach, reachOfRecords, assessTrial, cheapestFirst, openReasons, planInThread, sampleSettled, settleInThread, sharePlans, unanswered, withoutMutations } from './standard-plan.mjs';
import { classifyVitestSessionSupport, disableProjectFsModuleCache, inside, resolveVitestRunnerEntry, vitestDisableFsCachePlugin, vitestServerCacheOptions } from './vitest.mjs';

// Vitest and Vite are loaded on every run. Node keeps their compiled code between runs when it can.
try { enableCompileCache?.(); } catch { /* The cache is an optimisation only. */ }
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, files, selectedSpecs, mutants, setup, workerRunner, output, temporary, isolatedTrials, concurrency = 1, verifyTrials = 0, awaitsExtras = false, runTimeout = 60_000, baselineTimeout = runTimeout, baselineWorkers, progressIntervalMs } = input;
const destination = resolve(temporary, 'coverage.jsonl');
const record = event => appendFileSync(output, JSON.stringify(event) + '\n');
const lanes = [];
let supportsIds;
let createContext;
let runnerEntry;

const shiftSwitches = new Map(mutants.filter(mutant => mutant.parametric).map(mutant => [`${mutant.parametric.file}:${mutant.parametric.at}`, mutant.id]));

// The parent writes the list when the focused analysis has planned its trials, or an empty one when it has none.
async function extrasFromParent() {
  const path = resolve(temporary, 'extras.json');
  for (let waited = 0; waited < 600_000 && !existsSync(path); waited += 25) await new Promise(resolveWait => setTimeout(resolveWait, 25));
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

// Reads the lines appended since the last call, so a long trial log is never read twice.
function follow(path) {
  let position = 0;
  let rest = '';
  return () => {
    if (!existsSync(path)) return [];
    const descriptor = openSync(path, 'r');
    try {
      const chunks = [];
      const buffer = Buffer.alloc(65536);
      for (let read; (read = readSync(descriptor, buffer, 0, buffer.length, position)) > 0; position += read) {
        chunks.push(Buffer.from(buffer.subarray(0, read)));
      }
      const lines = (rest + Buffer.concat(chunks).toString('utf8')).split('\n');
      rest = lines.pop();
      return lines.filter(Boolean).map(line => JSON.parse(line));
    } finally {
      closeSync(descriptor);
    }
  };
}

function filterSelectedSpecs(allSpecs) {
  if (!selectedSpecs?.length) return allSpecs;
  const allowed = new Set(selectedSpecs.map(({ project, file }) => JSON.stringify([project ?? '', file])));
  return allSpecs.filter(spec => allowed.has(JSON.stringify([spec.project.name ?? '', inside(workspace, spec.moduleId)])));
}

// A lane is one Vitest instance with its own worker. The first lane also runs the baseline and the isolated trials.
async function openLane(index, serial = false, workerOverride = undefined) {
  const lane = { snapshot: null, events: resolve(temporary, `trials-${index}.jsonl`), serial, workerOverride };
  lane.context = await createContext(lane);
  lane.specs = filterSelectedSpecs(await lane.context.globTestSpecifications(files));
  return lane;
}

function clearVitestState(lane) {
  // Clear prior run state so Vitest 4.1 `onTestRunEnd(modules)` cannot carry over stale failed/dynamic
  // test modules from an earlier trial when `bail: 1` interrupts a subsequent run before every file runs.
  const vitestState = lane.context?.state;
  if (!vitestState) return;
  vitestState.filesMap?.clear?.();
  vitestState.idMap?.clear?.();
  vitestState.taskFileMap?.clear?.();
  vitestState.reportedTasksMap?.clear?.();
  vitestState.clearErrors?.();
}

// Runs a lane's share of the planned mutations inside its worker, one Vitest run per round. A worker that stops
// answering is replaced, its mutation is a timeout, and the rest continue in the next round.
async function runInThread(lane, plans, limit, deadline, onEvent, onTick) {
  const events = [];
  let remaining = plans;
  while (Object.keys(remaining).length) {
    rmSync(lane.events, { force: true });
    lane.snapshot = null;
    clearVitestState(lane);
    lane.context.provide('tmtSession', { phase: 'trials', plans: remaining, events: lane.events, runnerEntry, deadline });
    const chosen = lane.specs.filter(spec => remaining[JSON.stringify([spec.project.name, spec.moduleId])]);
    if (!chosen.length) break;
    const read = follow(lane.events);
    const started = new Map();
    const round = [];
    let finished = false;
    let stuck;
    const running = lane.context.runTestSpecifications(chosen).then(() => { finished = true; }, () => { finished = true; });
    while (!stuck) {
      const ended = finished;
      for (const event of read()) {
        round.push(event);
        onEvent?.(event);
        if (event.start !== undefined) started.set(event.module, { id: event.start, at: Date.now() });
        else if (event.control !== undefined) started.set(event.module, { id: event.control, at: Date.now(), control: true });
        else started.delete(event.module);
      }
      onTick?.();
      if (ended) break;
      stuck = [...started].find(([, { at }]) => Date.now() - at > limit);
      if (!stuck) await Promise.race([running, new Promise(resolvePoll => setTimeout(resolvePoll, 50))]);
    }
    if (!stuck) {
      const flagged = round.reduce((sum, event) => sum + (event.unhandled ?? 0), 0);
      // An unhandled error nobody attributed to a mutation leaves this round's verdicts without a clean environment.
      // A test file that fails outside its trials loses its own answers, unless it had already stopped: a worker
      // that a mutation changed can fail Vitest's own load of the file afterwards, and its earlier answers each
      // passed their control.
      const stopped = new Set(round.filter(event => event.stop !== undefined).map(event => event.module));
      const distrusted = new Set((lane.failedModules ?? []).filter(module => !stopped.has(module)));
      if (lane.snapshot && lane.unhandled <= flagged) events.push(...round.filter(event => !distrusted.has(event.module)));
      break;
    }
    // A worker that hangs in the control run says nothing about the mutation, which then gets a fresh run.
    events.push(...round, { module: stuck[0], id: stuck[1].id, ...(stuck[1].control ? { stuckControl: true } : { stuck: true }) });
    const answered = new Set(round.filter(event => event.id !== undefined).map(event => JSON.stringify([event.module, event.id])));
    const stopped = new Set(round.filter(event => event.stop !== undefined).map(event => event.module));
    remaining = Object.fromEntries(Object.entries(remaining).filter(([module]) => !stopped.has(module))
      .map(([module, list]) => [module, list.filter(plan => plan.id !== stuck[1].id && !answered.has(JSON.stringify([module, plan.id])))])
      .filter(([, list]) => list.length));
    await Promise.race([lane.context.close(), new Promise(resolveClose => setTimeout(resolveClose, 5_000))]);
    lane.context = await createContext(lane);
    lane.specs = filterSelectedSpecs(await lane.context.globTestSpecifications(files));
  }
  return events;
}

async function run(specs, state, lane = lanes[0], timeoutMs = runTimeout) {
  lane.snapshot = null;
  rmSync(destination, { force: true });
  clearVitestState(lane);
  lane.context.provide('tmtSession', { ...state, destination });
  const timeout = setTimeout(() => {
    record(state.id === undefined
      ? { baseline: { status: 'timeout', timeoutSeconds: Math.round(timeoutMs / 1000) } }
      : { id: state.id, status: 'timeout', statusReason: 'Vitest did not finish before its deadline' });
    process.exit(124);
  }, timeoutMs);
  try {
    await lane.context.runTestSpecifications(specs);
    if (!lane.snapshot) throw new Error('Vitest did not report a completed run');
    const records = existsSync(destination)
      ? readFileSync(destination, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : [];
    return { snapshot: lane.snapshot, records };
  } finally {
    clearTimeout(timeout);
  }
}

function subjectKey(project, file) {
  return JSON.stringify([project, file]);
}

function chooseTests(specs, tests, plan) {
  if (plan.staticActivation || !supportsIds) return specs;
  const byModule = new Map();
  for (const id of plan.covered) {
    const { file, project } = tests.get(id);
    const key = subjectKey(project, file);
    if (!byModule.has(key)) byModule.set(key, []);
    byModule.get(key).push(id);
  }
  return specs.flatMap(spec => {
    const ids = byModule.get(subjectKey(spec.project.name, relative(workspace, spec.moduleId)));
    return ids ? [spec.project.createSpecification(spec.moduleId, { testIds: ids })] : [];
  });
}

let exitStatus = 1;
try {
  const require = createRequire(resolve(workspace, 'package.json'));
  const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href);
  const vitestPkgPath = require.resolve('vitest/package.json');
  const version = require('vitest/package.json').version;
  const versionSupport = classifyVitestSessionSupport(version);
  if (!versionSupport.supported) throw new Error(versionSupport.reason);
  const fsModuleCacheDir = resolve(temporary, 'vitest-fs-cache');
  supportsIds = versionSupport.supportsIds;
  runnerEntry = resolveVitestRunnerEntry(vitestPkgPath);
  // Test files run beside each other when the project allows it: each has its own worker, and its coverage and
  // its mutations are kept per file.
  const oneByOne = { maxWorkers: 1, fileParallelism: false };
  const beside = concurrency === 1 || isolatedTrials ? oneByOne : { maxWorkers: concurrency };
  const resolveWorkers = lane => {
    if (lane.workerOverride !== undefined) {
      return lane.workerOverride === 1 ? oneByOne : { maxWorkers: lane.workerOverride };
    }
    return lane.serial ? oneByOne : beside;
  };
  createContext = async lane => {
    const workers = resolveWorkers(lane);
    const created = await createVitest('test', {
      root: workspace, config, watch: false, api: false, ui: false,
      ...vitestServerCacheOptions(version, fsModuleCacheDir),
      pool: 'threads', isolate: true, maxConcurrency: 1, ...workers,
      coverage: { enabled: false }, onConsoleLog: () => false, bail: 1,
      reporters: [{ onTestRunEnd(modules, errors, reason) {
        lane.snapshot = snapshotVitestRun(workspace, modules, errors, reason);
        lane.timing = timeVitestRun(modules);
        lane.unhandled = errors.length;
        lane.failedModules = modules.filter(module => module.errors().length).map(module => JSON.stringify([module.project.name, module.moduleId]));
      } }],
    }, { plugins: [vitestDisableFsCachePlugin(version, fsModuleCacheDir)] });
    disableProjectFsModuleCache(version, null, created);
    const configSupport = classifyVitestSessionSupport(version, created.projects.map(project => project.config));
    if (!configSupport.supported) {
      await created.close();
      throw new Error(configSupport.reason);
    }
    for (const project of created.projects) {
      Object.assign(project.config, { setupFiles: [setup, ...project.config.setupFiles],
        runner: workerRunner, pool: 'threads', isolate: true, maxConcurrency: 1, ...workers, bail: 1 });
      disableProjectFsModuleCache(version, project.config, created);
    }
    return created;
  };
  const trialWorkers = concurrency === 1 || isolatedTrials ? 1 : concurrency;
  const distinctBaselineLane = baselineWorkers !== undefined && baselineWorkers !== trialWorkers;
  const baselineLane = await openLane('baseline', false, distinctBaselineLane ? baselineWorkers : undefined);
  lanes.push(baselineLane);
  const { specs } = baselineLane;
  const discovered = new Set(specs.map(spec => inside(workspace, spec.moduleId)));
  if (files.length && (files.some(file => !discovered.has(file)) || discovered.size !== files.length)) {
    throw new Error('Vitest test selection mismatch');
  }
  const baselineState = { phase: 'baseline' };
  const baselineStarted = Date.now();
  const baseline = await run(specs, baselineState, baselineLane, baselineTimeout);
  const baselineTiming = baselineLane.timing;
  const baselineTime = Date.now() - baselineStarted;
  if (distinctBaselineLane) {
    await Promise.race([baselineLane.context.close(), new Promise(resolveClose => setTimeout(resolveClose, 5_000))]);
    lanes.length = 0;
    lanes.push(await openLane(0));
  }
  const passed = baseline.snapshot.tests.filter(test => test.status === 'passed');
  const tests = new Map(passed.map(test => [test.id, test]));
  const coveredModules = new Set(baseline.records.flatMap(record => record.modules.map(([project, file]) =>
    subjectKey(project, relative(workspace, file)))));
  if (!passed.length || tests.size !== passed.length || passed.some(test => !coveredModules.has(subjectKey(test.project, test.file))) ||
      baseline.snapshot.errors.length || baseline.snapshot.reason !== 'passed') {
    record({ baseline: { status: 'error',
      ...(baseline.snapshot.modules?.length ? { files: baseline.snapshot.modules } : {}),
      ...(baseline.snapshot.fileErrors?.length ? { fileErrors: baseline.snapshot.fileErrors } : {}),
      errors: baseline.snapshot.errors,
      output: baseline.snapshot.tests.flatMap(test => test.failures).join('\n'),
      failedTests: failedTests(baseline.snapshot) } });
  } else {
    record({ baseline: { status: 'passed', tests: baseline.snapshot.tests.length } });
    const baselineCoverage = indexCoverage(baseline.records, tests);
    const agreement = indexAgreement(baseline.records, tests);
    const reach = indexReach(baseline.records);
    if (agreement.size) {
      const named = ids => [...ids].map(id => tests.get(id)).map(({ id, project, file, name }) => ({ id, project, file, name }));
      record({ observed: Object.fromEntries([...agreement].map(([id, seen]) => [id, { agreeing: seen.agreeing.size,
        differing: named(seen.differing), unsure: named(seen.unsure), outside: seen.outside, outsideUnsure: seen.outsideUnsure, differ: seen.differ, agree: seen.agree,
        unknown: seen.unknown, ...(seen.realCopy ? { realCopy: true } : {}), ...(seen.nonArray ? { nonArray: true } : {}), ...(seen.nonPlain ? { nonPlain: true } : {}), ...(seen.absorbed ? { absorbed: true } : {}) }])) });
    }
    const pending = [];
    let settledBeforeDecide = 0;
    for (const mutant of mutants.filter(candidate => !candidate.parametric)) {
      const { id } = mutant;
      const plan = baselineCoverage(id);
      if (!plan.hits) {
        record({ id, status: 'unreached' });
        settledBeforeDecide++;
        continue;
      }
      // `??` and `||` give the same for null, undefined and every object. Where no test gave the left side a value
      // of a type that has a falsy one, the two are taken for the same code and the edit is not tried.
      const seen = agreement.get(id);
      if (mutant.evidence && seen && !seen.differing.size && !seen.unsure.size && !seen.outside && !seen.outsideUnsure && !seen.typed) {
        record({ id, status: 'ignored', statusReason: 'No test gives the left side a number, a string or a boolean, so both operators are taken to behave alike here' });
        settledBeforeDecide++;
        continue;
      }
      // `expr[0]` on a plain map or `arguments` object is not a sequence: mutating to `.at(-1)` would only raise
      // a TypeError noise kill. Never skip if any baseline evaluation threw (exception behavior is unverified).
      if (mutant.sequenceIndex && seen && !seen.sequence && seen.nonSequence && !seen.threw && !seen.differing.size && !seen.outside) {
        record({ id, status: 'ignored', statusReason: 'No test passes a sequence (array, string, or typed array) to this index expression' });
        settledBeforeDecide++;
        continue;
      }
      pending.push({ mutant, plan });
    }
    let fresh;
    const totals = { inWorker: 0, isolated: 0, sampled: 0, mismatches: [], inWorkerUsed: false };
    // Decides a list of reached trials: inside workers where that holds, in fresh runs for the rest.
    // What a surviving edit changed in the code its tests run, with the tests by name.
    const effectsOf = runs => {
      const named = list => list.map(({ test, id }) => ({ id, ...(tests.has(test) ? { test: tests.get(test).name } : {}) }));
      const { now, gone } = changedReach(reach, runs);
      return { now: named(now), gone: named(gone) };
    };
    const decide = async (pending, report, trackProgress = false) => {
      const plans = isolatedTrials ? null : planInThread(baseline.records, tests, pending, workspace, baselineTiming);
      let settled = new Map();
      let reasons = new Map();
      const effects = new Map();
      // A sample of the workers' verdicts is run again in fresh runs when asked for. A difference is reported and
      // the fresh run's verdict is the one kept.
      const sampled = new Set();
      if (plans) {
        const limit = 15_000 + 3 * baselineTime;
        let onTrialEvent = null;
        let onProgressTick = null;
        if (trackProgress) {
          const remainingFiles = new Map();
          for (const list of Object.values(plans)) {
            for (const plan of list) {
              remainingFiles.set(plan.id, (remainingFiles.get(plan.id) ?? 0) + 1);
            }
          }
          const completedInWorker = new Set();
          const seenModuleAnswer = new Set();
          const maxProvisional = Math.max(0, pending.length - 1);
          const emitIntervalMs = Math.min(2_000, Math.max(50, Math.floor((progressIntervalMs ?? 5_000) / 2)));
          let lastEmitted = 0;
          let lastEmitAt = Date.now();
          const flushProgress = () => {
            const reportedCount = Math.min(completedInWorker.size, maxProvisional);
            const now = Date.now();
            if (reportedCount > lastEmitted && now - lastEmitAt >= emitIntervalMs) {
              lastEmitted = reportedCount;
              lastEmitAt = now;
              record({ progress: { completed: settledBeforeDecide + reportedCount } });
            }
          };
          onProgressTick = flushProgress;
          onTrialEvent = event => {
            if (event.id === undefined || !remainingFiles.has(event.id)) return;
            const cleanAnswer = event.elapsed !== undefined && event.hits > 0 && !event.unhandled &&
              !(event.errors?.length) && !event.foreign && !event.missing;
            const isKilled = cleanAnswer && Array.isArray(event.failed) && event.failed.length > 0;
            if (isKilled) {
              completedInWorker.add(event.id);
            } else if (cleanAnswer) {
              const key = JSON.stringify([event.module, event.id]);
              if (!seenModuleAnswer.has(key)) {
                seenModuleAnswer.add(key);
                const left = remainingFiles.get(event.id) - 1;
                remainingFiles.set(event.id, left);
                if (left <= 0) completedInWorker.add(event.id);
              }
            }
            flushProgress();
          };
        }
        // The first lane starts alone with a deadline. Most plans end within it. What is left is timed by then, and a
        // further lane, which costs a Vitest instance, its transforms and an environment per test file, opens for
        // every six seconds of measured work in the longest test file.
        const inLanes = async step => {
          const events = await runInThread(lanes[0], step, limit, Date.now() + 2_000, onTrialEvent, onProgressTick);
          // Each further round takes what is left: entries the deadline cut off, and test files that start again
          // in a new worker after a control run differed.
          for (let round = 0; round < 12; round++) {
            const left = unanswered(step, events, 8);
            const entries = Object.values(left).flat();
            if (!entries.length) break;
            const timed = events.filter(event => event.elapsed !== undefined);
            const planned = new Map(Object.entries(step).flatMap(([module, list]) => list.map(plan => [JSON.stringify([module, plan.id]), plan])));
            const paid = timed.reduce((sum, event) => sum + planned.get(JSON.stringify([event.module, event.id])).cost + 1, 0);
            // Before anything was timed, an entry is taken as its baseline cost twice: a trial and a control run.
            const rate = timed.length ? timed.reduce((sum, event) => sum + event.elapsed, 0) / paid : 2;
            // Test files already run beside each other inside a lane. A further lane only helps the longest file.
            const work = Math.max(...Object.values(left).map(list => list.reduce((sum, plan) => sum + (plan.cost + 1) * rate, 0)));
            const wanted = Math.max(1, Math.min(concurrency, Math.ceil(work / 6_000)));
            const opened = await Promise.all(Array.from({ length: Math.max(0, wanted - lanes.length) },
              (_, index) => openLane(lanes.length + index).catch(() => null)));
            lanes.push(...opened.filter(Boolean));
            const shares = sharePlans(left, Math.min(wanted, lanes.length));
            const answered = (await Promise.all(shares.map((share, index) => runInThread(lanes[index], share, limit, undefined, onTrialEvent, onProgressTick)))).flat();
            if (!answered.some(event => event.id !== undefined || event.stop !== undefined)) break;
            events.push(...answered);
          }
          return events;
        };
        const { first, rest } = cheapestFirst(plans);
        const firstEvents = await inLanes(first);
        const killed = new Set([...settleInThread(first, firstEvents, tests)].filter(([, verdict]) => verdict.status === 'killed').map(([id]) => id));
        const restEvents = await inLanes(withoutMutations(rest, killed));
        // A mutation killed in the first step is settled by that step alone. The others need every test file's answer.
        const decisive = Object.fromEntries(Object.entries(plans).map(([module, list]) =>
          [module, list.filter(plan => !killed.has(plan.id) || first[module]?.includes(plan))]).filter(([, list]) => list.length));
        settled = settleInThread(decisive, [...firstEvents, ...restEvents], tests);
        reasons = openReasons(decisive, [...firstEvents, ...restEvents]);
        // What each surviving edit of the targeted rules changed in the code its tests run.
        const runs = new Map();
        for (const event of [...firstEvents, ...restEvents]) {
          if (!event.reached || settled.get(event.id)?.status !== 'survived') continue;
          if (!runs.has(event.id)) runs.set(event.id, []);
          runs.get(event.id).push({ module: event.module, reached: event.reached });
        }
        for (const [id, list] of runs) effects.set(id, effectsOf(list));
      }
      for (const id of sampleSettled(pending.map(({ mutant }) => mutant.id).filter(id => settled.has(id)), Math.max(0, verifyTrials - totals.sampled))) sampled.add(id);
      for (const { mutant, plan } of pending) {
        const { id } = mutant;
        const expected = plan.staticActivation || !supportsIds ? tests : new Map([...plan.covered].map(id => [id, tests.get(id)]));
        if (settled.has(id) && !sampled.has(id)) {
          report(mutant, { ...settled.get(id), ...(effects.has(id) ? { effects: effects.get(id) } : {}) });
          continue;
        }
        if (!sampled.has(id)) totals.isolated++;
        // A fresh run stops at its first failing test. Beside each other, test files would be cut off mid-run,
        // so these runs take the files one by one.
        fresh ??= beside === oneByOne ? lanes[0] : await openLane('fresh', true).then(lane => (lanes.push(lane), lane));
        const selected = chooseTests(fresh.specs, tests, plan);
        const hitLimit = plan.hits * 100;
        const trial = await run(selected, { id, phase: 'trial', active: mutant.active ?? id, shift: mutant.shift, hitLimit,
          staticActivation: plan.staticActivation }, fresh);
        const assessed = assessTrial(trial, expected, hitLimit);
        if (sampled.has(id) && assessed.status !== settled.get(id).status) totals.mismatches.push({ id, worker: settled.get(id).status, fresh: assessed.status });
        const changed = mutant.effects && assessed.status === 'survived' ? { effects: effectsOf(reachOfRecords(trial.records, expected.keys())) } : {};
        report(mutant, { ...assessed, ...changed, ...(reasons.has(id) ? { fallback: reasons.get(id) } : {}) });
      }
      totals.inWorker += settled.size;
      totals.sampled += sampled.size;
      totals.inWorkerUsed ||= plans !== null;
    };
    await decide(pending, (mutant, result) => record({ id: mutant.id, ...result }), true);
    if (awaitsExtras) {
      // Threshold edits of the focused analysis: each names a comparison and how far its right side moves.
      const extras = [];
      for (const [index, extra] of (await extrasFromParent()).entries()) {
        const active = shiftSwitches.get(`${extra.file}:${extra.at}`);
        const plan = active === undefined ? null : baselineCoverage(active);
        if (!plan) record({ extra: index, status: 'unsupported' });
        else if (!plan.hits) record({ extra: index, status: 'unreached' });
        else extras.push({ mutant: { id: `extra:${index}`, index, active, shift: extra.shift }, plan });
      }
      await decide(extras, (mutant, result) => record({ extra: mutant.index, ...result }));
    }
    record({ trials: { workers: totals.inWorkerUsed ? lanes.filter(lane => !lane.serial).length : 1, inWorker: totals.inWorker,
      isolated: totals.isolated,
      ...(verifyTrials ? { verified: { sampled: totals.sampled, mismatches: totals.mismatches } } : {}) } });
    record({ complete: true });
  }
  exitStatus = 0;
} catch (error) {
  record({ error: error.message });
} finally {
  await Promise.race([Promise.all(lanes.map(lane => lane.context.close())), new Promise(resolveClose => setTimeout(resolveClose, 5_000))]);
  // Vitest sets the exit code of a run with failures, and a worker caught in an endless loop outlives its
  // Vitest instance, so the session ends itself with its own status.
  process.exit(exitStatus);
}
