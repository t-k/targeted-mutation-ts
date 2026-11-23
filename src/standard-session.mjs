import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { createRequire, enableCompileCache } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedTests, snapshotVitestRun, timeVitestRun } from './vitest-reporter.mjs';
import { indexCoverage, agreesWithCoverage, assessTrial, cheapestFirst, openReasons, planInThread, sampleSettled, settleInThread, sharePlans, unanswered, withoutMutations } from './standard-plan.mjs';
import { checkReplay } from './lean-replay.mjs';
import { inside } from './vitest.mjs';

// Vitest and Vite are loaded on every run. Node keeps their compiled code between runs when it can.
try { enableCompileCache?.(); } catch { /* The cache is an optimisation only. */ }
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, files, mutants, focused, replay, setup, workerRunner, output, temporary, isolatedTrials, concurrency = 1, verifyTrials = 0 } = input;
const destination = resolve(temporary, 'coverage.jsonl');
const record = event => appendFileSync(output, JSON.stringify(event) + '\n');
const lanes = [];
let supportsIds;
let createContext;
let runnerEntry;

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

// A lane is one Vitest instance with its own worker. The first lane also runs the baseline and the isolated trials.
async function openLane(index, serial = false) {
  const lane = { snapshot: null, events: resolve(temporary, `trials-${index}.jsonl`), serial };
  lane.context = await createContext(lane);
  lane.specs = await lane.context.globTestSpecifications(files);
  return lane;
}

// Runs a lane's share of the planned mutations inside its worker, one Vitest run per round. A worker that stops
// answering is replaced, its mutation is a timeout, and the rest continue in the next round.
async function runInThread(lane, plans, limit, deadline) {
  const events = [];
  let remaining = plans;
  while (Object.keys(remaining).length) {
    rmSync(lane.events, { force: true });
    lane.snapshot = null;
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
        if (event.start !== undefined) started.set(event.module, { id: event.start, at: Date.now() });
        else if (event.control !== undefined) started.set(event.module, { id: event.control, at: Date.now(), control: true });
        else started.delete(event.module);
      }
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
    lane.specs = await lane.context.globTestSpecifications(files);
  }
  return events;
}

async function run(specs, state, lane = lanes[0]) {
  lane.snapshot = null;
  rmSync(destination, { force: true });
  lane.context.provide('tmtSession', { ...state, destination });
  const timeout = setTimeout(() => {
    record(state.id === undefined
      ? { baseline: { status: 'timeout' } }
      : { id: state.id, status: 'timeout', statusReason: 'Vitest did not finish before its deadline' });
    process.exit(124);
  }, 60_000);
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

function numericTraces(records, candidates, tests) {
  const accepted = {};
  for (const { id } of candidates) {
    const rows = records.flatMap(row => row.focused?.[id] ?? []);
    if (rows.length && !rows.includes(false) && rows.every(([test]) => tests.has(test))) accepted[id] = rows;
  }
  return accepted;
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
  const version = require('vitest/package.json').version;
  if (!version.startsWith('4.')) throw new Error(`The standard profile requires Vitest 4, found ${version}`);
  supportsIds = !version.startsWith('4.0.');
  runnerEntry = pathToFileURL(realpathSync(createRequire(require.resolve('vitest/package.json')).resolve('@vitest/runner'))).href;
  // Test files run beside each other when the project allows it: each has its own worker, and its coverage and
  // its mutations are kept per file. Recorded comparisons are replayed in a fixed order, so that profile stays serial.
  const oneByOne = { maxWorkers: 1, fileParallelism: false };
  const beside = focused.length || concurrency === 1 || isolatedTrials ? oneByOne : { maxWorkers: concurrency };
  createContext = async lane => {
    const workers = lane.serial ? oneByOne : beside;
    const created = await createVitest('test', {
      root: workspace, config, watch: false, api: false, ui: false, cache: false,
      pool: 'threads', isolate: true, maxConcurrency: 1, ...workers,
      coverage: { enabled: false }, onConsoleLog: () => false, bail: 1,
      reporters: [{ onTestRunEnd(modules, errors, reason) {
        lane.snapshot = snapshotVitestRun(workspace, modules, errors, reason);
        lane.timing = timeVitestRun(modules);
        lane.unhandled = errors.length;
        lane.failedModules = modules.filter(module => module.errors().length).map(module => JSON.stringify([module.project.name, module.moduleId]));
      } }],
    });
    for (const project of created.projects) {
      if (project.config.browser?.enabled || project.config.typecheck?.enabled || project.config.runner) {
        throw new Error('The standard profile requires the default Vitest runner without browser mode or type checking');
      }
      Object.assign(project.config, { setupFiles: [setup, ...project.config.setupFiles],
        runner: workerRunner, pool: 'threads', isolate: true, maxConcurrency: 1, ...workers, bail: 1 });
    }
    return created;
  };
  lanes.push(await openLane(0));
  const { specs } = lanes[0];
  const discovered = new Set(specs.map(spec => inside(workspace, spec.moduleId)));
  if (files.length && (files.some(file => !discovered.has(file)) || discovered.size !== files.length)) {
    throw new Error('Vitest test selection mismatch');
  }
  const baselineState = { phase: 'baseline', focusedIds: focused.map(({ id }) => id) };
  const baselineStarted = Date.now();
  const baseline = await run(specs, baselineState);
  const baselineTiming = lanes[0].timing;
  const baselineTime = Date.now() - baselineStarted;
  const passed = baseline.snapshot.tests.filter(test => test.status === 'passed');
  const tests = new Map(passed.map(test => [test.id, test]));
  const coveredModules = new Set(baseline.records.flatMap(record => record.modules.map(([project, file]) =>
    subjectKey(project, relative(workspace, file)))));
  if (!passed.length || tests.size !== passed.length || passed.some(test => !coveredModules.has(subjectKey(test.project, test.file))) ||
      baseline.snapshot.errors.length || baseline.snapshot.reason !== 'passed') {
    record({ baseline: { status: 'error', errors: baseline.snapshot.errors,
      output: baseline.snapshot.tests.flatMap(test => test.failures).join('\n'),
      failedTests: failedTests(baseline.snapshot) } });
  } else {
    record({ baseline: { status: 'passed', tests: baseline.snapshot.tests.length } });
    const baselineCoverage = indexCoverage(baseline.records, tests);
    const focusedTrace = numericTraces(baseline.records, focused, tests);
    for (const { id } of focused) {
      if (!focusedTrace[id]) record({ id, status: 'unsupported', statusReason: 'Missing or unsupported numeric observations' });
    }
    if (focused.length) record({ focusedTrace });
    const requests = [];
    const ids = [];
    if (!passed.some(test => test.retry || test.repeats || test.concurrent)) {
      for (const { id, candidate, original, replacement } of replay) {
        const rows = focusedTrace[candidate];
        const plan = baselineCoverage(id);
        if (!agreesWithCoverage(rows, plan)) continue;
        requests.push({ candidate, traceCandidate: candidate, original, replacement, complete: true,
          deterministic: true, observations: rows.map(([, lhs, rhs]) => [lhs, rhs]) });
        ids.push(id);
      }
    }
    const checked = checkReplay(requests);
    let predicted = new Set(ids.filter((_, index) => checked?.[index] === true));
    if (predicted.size) {
      const confirmation = await run(specs, baselineState);
      if (JSON.stringify(confirmation.snapshot) !== JSON.stringify(baseline.snapshot)) predicted.clear();
      else {
        const confirmationCoverage = indexCoverage(confirmation.records, tests);
        const repeated = numericTraces(confirmation.records, focused, tests);
        predicted = new Set(replay.filter(({ id, candidate }) => predicted.has(id) &&
          agreesWithCoverage(repeated[candidate], confirmationCoverage(id)) &&
          JSON.stringify(repeated[candidate]) === JSON.stringify(focusedTrace[candidate])).map(({ id }) => id));
      }
    }
    const qualified = focused.filter(({ id }) => focusedTrace[id]).map(mutant => ({ ...mutant, focused: true }));
    const pending = [];
    for (const mutant of [...mutants, ...qualified]) {
      const { id } = mutant;
      if (predicted.has(id)) {
        record({ id, status: 'survived', evidence: 'predicted' });
        continue;
      }
      const plan = baselineCoverage(id);
      if (!plan.hits) {
        record({ id, status: 'unreached' });
        continue;
      }
      pending.push({ mutant, plan });
    }
    const plans = isolatedTrials ? null : planInThread(baseline.records, tests, pending, workspace, baselineTiming);
    let settled = new Map();
    let isolated = 0;
    let fresh;
    let reasons = new Map();
    // A sample of the workers' verdicts is run again in fresh runs when asked for. A difference is reported and
    // the fresh run's verdict is the one kept.
    const sampled = new Set();
    const mismatches = [];
    if (plans) {
      const limit = 15_000 + 3 * baselineTime;
      // The first lane starts alone with a deadline. Most plans end within it. What is left is timed by then, and a
      // further lane, which costs a Vitest instance, its transforms and an environment per test file, opens for
      // every six seconds of measured work in the longest test file.
      const inLanes = async step => {
        const events = await runInThread(lanes[0], step, limit, Date.now() + 2_000);
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
          const answered = (await Promise.all(shares.map((share, index) => runInThread(lanes[index], share, limit)))).flat();
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
    }
    for (const id of sampleSettled(pending.map(({ mutant }) => mutant.id).filter(id => settled.has(id)), verifyTrials)) sampled.add(id);
    for (const { mutant, plan } of pending) {
      const { id } = mutant;
      const expected = plan.staticActivation || !supportsIds ? tests : new Map([...plan.covered].map(id => [id, tests.get(id)]));
      const covering = mutant.focused
        ? { coveringTests: [...expected.values()].map(({ id, project, file, name }) => ({ id, project, file, name })) } : {};
      if (settled.has(id) && !sampled.has(id)) {
        record({ id, ...settled.get(id), ...covering });
        continue;
      }
      if (!sampled.has(id)) isolated++;
      // A fresh run stops at its first failing test. Beside each other, test files would be cut off mid-run,
      // so these runs take the files one by one.
      fresh ??= beside === oneByOne ? lanes[0] : await openLane('fresh', true).then(lane => (lanes.push(lane), lane));
      const selected = chooseTests(fresh.specs, tests, plan);
      const hitLimit = plan.hits * 100;
      const trial = await run(selected, { id, phase: 'trial', active: id, hitLimit, staticActivation: plan.staticActivation }, fresh);
      const assessed = assessTrial(trial, expected, hitLimit);
      if (sampled.has(id) && assessed.status !== settled.get(id).status) mismatches.push({ id, worker: settled.get(id).status, fresh: assessed.status });
      record({ id, ...assessed, ...covering, ...(reasons.has(id) ? { fallback: reasons.get(id) } : {}) });
    }
    record({ trials: { workers: plans ? lanes.filter(lane => !lane.serial).length : 1, inWorker: settled.size, isolated,
      ...(verifyTrials ? { verified: { sampled: sampled.size, mismatches } } : {}) } });
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
