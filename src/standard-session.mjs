import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedTests, snapshotVitestRun } from './vitest-reporter.mjs';
import { indexCoverage, agreesWithCoverage, assessTrial, planInThread, settleInThread, sharePlans } from './standard-plan.mjs';
import { checkReplay } from './lean-replay.mjs';
import { inside } from './vitest.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, files, mutants, focused, replay, setup, workerRunner, output, temporary, isolatedTrials, concurrency = 1 } = input;
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
async function openLane(index) {
  const lane = { snapshot: null, events: resolve(temporary, `trials-${index}.jsonl`) };
  lane.context = await createContext(lane);
  lane.specs = await lane.context.globTestSpecifications(files);
  return lane;
}

// Runs a lane's share of the planned mutations inside its worker, one Vitest run per round. A worker that stops
// answering is replaced, its mutation is a timeout, and the rest continue in the next round.
async function runInThread(lane, plans, limit) {
  const events = [];
  let remaining = plans;
  while (Object.keys(remaining).length) {
    rmSync(lane.events, { force: true });
    lane.snapshot = null;
    lane.context.provide('tmtSession', { phase: 'trials', plans: remaining, events: lane.events, runnerEntry });
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
        else started.delete(event.module);
      }
      if (ended) break;
      stuck = [...started].find(([, { at }]) => Date.now() - at > limit);
      if (!stuck) await Promise.race([running, new Promise(resolvePoll => setTimeout(resolvePoll, 50))]);
    }
    if (!stuck) {
      const flagged = round.reduce((sum, event) => sum + (event.unhandled ?? 0), 0);
      // An error nobody attributed to a mutation leaves this round's verdicts without a clean environment.
      if (lane.snapshot && lane.snapshot.errors.length <= flagged) events.push(...round);
      break;
    }
    events.push(...round, { module: stuck[0], id: stuck[1].id, stuck: true });
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

async function run(specs, state) {
  const lane = lanes[0];
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
  createContext = async lane => {
    const created = await createVitest('test', {
      root: workspace, config, watch: false, api: false, ui: false, cache: false,
      pool: 'threads', isolate: true, maxWorkers: 1, maxConcurrency: 1, fileParallelism: false,
      coverage: { enabled: false }, onConsoleLog: () => false, bail: 1,
      reporters: [{ onTestRunEnd(modules, errors, reason) { lane.snapshot = snapshotVitestRun(workspace, modules, errors, reason); } }],
    });
    for (const project of created.projects) {
      if (project.config.browser?.enabled || project.config.typecheck?.enabled || project.config.runner) {
        throw new Error('The standard profile requires the default Vitest runner without browser mode or type checking');
      }
      Object.assign(project.config, { setupFiles: [setup, ...project.config.setupFiles],
        runner: workerRunner, pool: 'threads', isolate: true, maxWorkers: 1, maxConcurrency: 1, fileParallelism: false, bail: 1 });
    }
    return created;
  };
  // Further lanes start while the baseline runs. They are only used when the plan is large enough to share.
  const laneCount = isolatedTrials ? 1 : Math.max(1, Math.min(concurrency, Math.ceil((mutants.length + focused.length) / 24)));
  const opening = Array.from({ length: laneCount - 1 }, (_, index) => openLane(index + 1).then(lane => lanes.push(lane), () => {}));
  lanes.push(await openLane(0));
  const { specs } = lanes[0];
  const discovered = new Set(specs.map(spec => inside(workspace, spec.moduleId)));
  if (files.length && (files.some(file => !discovered.has(file)) || discovered.size !== files.length)) {
    throw new Error('Vitest test selection mismatch');
  }
  const baselineState = { phase: 'baseline', focusedIds: focused.map(({ id }) => id) };
  const baselineStarted = Date.now();
  const baseline = await run(specs, baselineState);
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
    const plans = isolatedTrials ? null : planInThread(baseline.records, tests, pending, workspace);
    let settled = new Map();
    let isolated = 0;
    await Promise.all(opening);
    if (plans) {
      const limit = 15_000 + 3 * baselineTime;
      const shares = sharePlans(plans, lanes.length);
      const events = await Promise.all(shares.map((share, index) => runInThread(lanes[index], share, limit)));
      settled = settleInThread(plans, events.flat(), tests);
    }
    for (const { mutant, plan } of pending) {
      const { id } = mutant;
      const expected = plan.staticActivation || !supportsIds ? tests : new Map([...plan.covered].map(id => [id, tests.get(id)]));
      const covering = mutant.focused
        ? { coveringTests: [...expected.values()].map(({ id, project, file, name }) => ({ id, project, file, name })) } : {};
      if (settled.has(id)) {
        record({ id, ...settled.get(id), ...covering });
        continue;
      }
      isolated++;
      const selected = chooseTests(lanes[0].specs, tests, plan);
      const hitLimit = plan.hits * 100;
      const trial = await run(selected, { id, phase: 'trial', active: id, hitLimit, staticActivation: plan.staticActivation });
      record({ id, ...assessTrial(trial, expected, hitLimit), ...covering });
    }
    record({ trials: { workers: plans ? lanes.length : 1, inWorker: settled.size, isolated } });
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
