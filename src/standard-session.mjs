import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotVitestRun } from './vitest-reporter.mjs';
import { indexCoverage, agreesWithCoverage, assessTrial } from './standard-plan.mjs';
import { checkReplay } from './lean-replay.mjs';
import { inside } from './vitest.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, files, mutants, focused, replay, setup, workerRunner, output, temporary } = input;
const destination = resolve(temporary, 'coverage.jsonl');
const record = event => appendFileSync(output, JSON.stringify(event) + '\n');
let snapshot;
let context;
let supportsIds;

async function run(specs, state) {
  snapshot = null;
  rmSync(destination, { force: true });
  context.provide('tmtSession', { ...state, destination });
  const timeout = setTimeout(() => {
    record(state.id === undefined
      ? { baseline: { status: 'timeout' } }
      : { id: state.id, status: 'timeout', statusReason: 'Vitest did not finish before its deadline' });
    process.exit(124);
  }, 60_000);
  try {
    await context.runTestSpecifications(specs);
    if (!snapshot) throw new Error('Vitest did not report a completed run');
    const records = existsSync(destination)
      ? readFileSync(destination, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : [];
    return { snapshot, records };
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

try {
  const require = createRequire(resolve(workspace, 'package.json'));
  const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href);
  const version = require('vitest/package.json').version;
  if (!version.startsWith('4.')) throw new Error(`The standard profile requires Vitest 4, found ${version}`);
  supportsIds = !version.startsWith('4.0.');
  context = await createVitest('test', {
    root: workspace, config, watch: false, api: false, ui: false, cache: false,
    pool: 'threads', isolate: true, maxWorkers: 1, maxConcurrency: 1, fileParallelism: false,
    coverage: { enabled: false }, onConsoleLog: () => false, bail: 1,
    reporters: [{ onTestRunEnd(modules, errors, reason) { snapshot = snapshotVitestRun(workspace, modules, errors, reason); } }],
  });
  for (const project of context.projects) {
    if (project.config.browser?.enabled || project.config.typecheck?.enabled || project.config.runner) {
      throw new Error('The standard profile requires the default Vitest runner without browser mode or type checking');
    }
    Object.assign(project.config, { setupFiles: [setup, ...project.config.setupFiles],
      runner: workerRunner, pool: 'threads', isolate: true, maxWorkers: 1, maxConcurrency: 1, fileParallelism: false, bail: 1 });
  }
  const specs = await context.globTestSpecifications(files);
  const discovered = new Set(specs.map(spec => inside(workspace, spec.moduleId)));
  if (files.length && (files.some(file => !discovered.has(file)) || discovered.size !== files.length)) {
    throw new Error('Vitest test selection mismatch');
  }
  const baselineState = { phase: 'baseline', focusedIds: focused.map(({ id }) => id) };
  const baseline = await run(specs, baselineState);
  const passed = baseline.snapshot.tests.filter(test => test.status === 'passed');
  const tests = new Map(passed.map(test => [test.id, test]));
  const coveredModules = new Set(baseline.records.flatMap(record => record.modules.map(([project, file]) =>
    subjectKey(project, relative(workspace, file)))));
  if (!passed.length || tests.size !== passed.length || passed.some(test => !coveredModules.has(subjectKey(test.project, test.file))) ||
      baseline.snapshot.errors.length || baseline.snapshot.reason !== 'passed') {
    record({ baseline: { status: 'error', errors: baseline.snapshot.errors,
      output: baseline.snapshot.tests.flatMap(test => test.failures).join('\n') } });
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
      const selected = chooseTests(specs, tests, plan);
      const hitLimit = plan.hits * 100;
      const trial = await run(selected, { id, phase: 'trial', active: id, hitLimit, staticActivation: plan.staticActivation });
      const expected = plan.staticActivation || !supportsIds ? tests : new Map([...plan.covered].map(id => [id, tests.get(id)]));
      record({ id, ...assessTrial(trial, expected, hitLimit),
        ...(mutant.focused ? { coveringTests: [...expected.values()].map(({ id, project, file, name }) => ({ id, project, file, name })) } : {}) });
    }
    record({ complete: true });
  }
  process.exitCode = 0;
} catch (error) {
  record({ error: error.message });
  process.exitCode = 1;
} finally {
  await context?.close();
}
