import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotVitestRun } from './vitest-reporter.mjs';
import { coveredTests, assessTrial } from './standard-plan.mjs';
import { inside } from './vitest.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { workspace, config, files, mutants, setup, workerRunner, output, temporary } = input;
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
  const baseline = await run(specs, { phase: 'baseline' });
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
    for (const mutant of mutants) {
      const { id } = mutant;
      const plan = coveredTests(id, baseline.records, tests);
      if (!plan.hits) {
        record({ id, status: 'unreached' });
        continue;
      }
      const selected = chooseTests(specs, tests, plan);
      const hitLimit = plan.hits * 100;
      const trial = await run(selected, { id, phase: 'trial', active: id, hitLimit, staticActivation: plan.staticActivation });
      const expected = plan.staticActivation || !supportsIds ? tests : new Map([...plan.covered].map(id => [id, tests.get(id)]));
      record({ id, ...assessTrial(trial, expected, hitLimit) });
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
