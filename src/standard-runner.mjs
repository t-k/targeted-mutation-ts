import { appendFileSync } from 'node:fs';
import { vi } from 'vitest';
import { VitestTestRunner } from 'vitest/runners';

const sessionKey = Symbol.for('targeted-mutation-ts/session');
const trialKey = Symbol.for('targeted-mutation-ts/trial');
const unhandledKey = Symbol.for('targeted-mutation-ts/unhandled');
const immediate = setImmediate;
const base = VitestTestRunner.prototype;
const runs = task => task.mode === 'run' || task.mode === 'queued';
const timeoutMessage = /^(?:Hook|Test) timed out in \d+ms\./;
const vitestModule = /\/vitest\/dist\/|vitest-virtual-\w+\/dist|@vitest\/dist/;
const timedOut = error => timeoutMessage.test(error?.message ?? '');

function watchUnhandled() {
  if (globalThis[unhandledKey]) return globalThis[unhandledKey];
  const counter = globalThis[unhandledKey] = { count: 0 };
  process.on('unhandledRejection', () => { counter.count++; });
  process.on('uncaughtException', () => { counter.count++; });
  return counter;
}

// Leaves only the chosen tests runnable. A suite with nothing left to run is skipped, so its hooks stay quiet.
function choose(suite, selected) {
  let any = false;
  for (const task of suite.tasks) {
    if (task.type !== 'test') any = choose(task, selected) || any;
    else if (runs(task)) {
      if (selected.has(task.id)) any = true;
      else task.mode = 'skip';
    }
  }
  if (!any && runs(suite)) suite.mode = 'skip';
  return any;
}

// `expected` holds the tests the baseline ran for this entry. A test outside it that ran, or one of them that is
// no longer registered, means the file now holds different tests, which only a fresh run can judge.
function summarize(suite, summary, expected) {
  for (const error of suite.result?.errors ?? []) summary.errors.push(String(error.message ?? error));
  for (const task of suite.tasks) {
    if (task.type !== 'test') summarize(task, summary, expected);
    else if (expected.has(task.id)) summary.missing--;
    if (task.type === 'test' && (task.result?.state === 'pass' || task.result?.state === 'fail')) {
      if (!expected.has(task.id)) summary.foreign++;
      if (task.result.state === 'pass') summary.passed++;
      else {
        summary.failed.push(task.id);
        summary.timeout ||= (task.result.errors ?? []).some(timedOut);
      }
    }
  }
  return summary;
}

export default class StandardMutationRunner extends VitestTestRunner {
  // Every mutation planned for this test file runs here, in the worker that would otherwise run the file once.
  // A control run follows each mutation. When it differs from the baseline the file stops, and the session
  // gives that mutation and the remaining ones a fresh Vitest run each.
  async onBeforeCollect(paths) {
    const state = this.injectValue('tmtSession');
    if (state?.phase !== 'trials') return;
    // Vitest's own run of these files has nothing left to decide. Its tests are skipped, so a worker that the
    // mutations changed cannot fail it and end the run for the other test files.
    this.cancelRun = true;
    for (const path of paths) {
      const module = JSON.stringify([this.config.name ?? '', path]);
      const plans = state.plans[module] ?? [];
      const emit = event => appendFileSync(state.events, JSON.stringify({ module, ...event }) + '\n');
      if (!plans.length) continue;
      try {
        const { startTests } = await import(state.runnerEntry);
        const inner = this.#engine(startTests, path);
        for (const plan of plans) {
          // Past the deadline the session takes the rest back and decides how many workers it is worth.
          if (state.deadline !== undefined && Date.now() > state.deadline) {
            emit({ yielded: true });
            break;
          }
          const began = Date.now();
          emit({ start: plan.id });
          const expected = plan.tests.length;
          const selected = plan.static ? undefined : plan.tests;
          const active = plan.active ?? plan.id;
          const trial = await inner({ phase: 'trial', active, shift: plan.shift, hitLimit: plan.hitLimit, staticActivation: plan.static }, selected, plan.tests);
          const hits = globalThis.__stryker__.hitCount;
          // For an edit whose tests all passed, the switches each test reached say what the edit changed on the way.
          const reachedIds = counts => Object.entries(counts ?? {}).filter(([, count]) => count).map(([id]) => id);
          const coverage = globalThis.__stryker__.mutantCoverage;
          // A test that ran and reached no switch at all is listed with none.
          const reached = plan.effects && !trial.failed.length ? { ...Object.fromEntries(plan.tests.map(test => [test, []])),
            ...Object.fromEntries(Object.entries(coverage?.perTest ?? {}).map(([test, counts]) => [test, reachedIds(counts)])),
            '': reachedIds(coverage?.static) } : undefined;
          // From here on a silent worker is a failed control, not a mutation that never returns.
          emit({ control: plan.id });
          // The same tests without the mutation, directly afterwards. They must behave as in the baseline, or the
          // trial ran in an environment that an earlier run, or the trial itself, had changed.
          const control = await inner({ phase: 'control' }, selected, plan.tests);
          const controlHits = globalThis.__stryker__.mutantCoverage?.static?.[active] ?? 0;
          if (control.unhandled || control.errors.length || control.failed.length || control.foreign || control.missing || control.passed !== expected ||
              controlHits !== plan.hits) {
            emit({ stop: plan.id, reason: 'control' });
            break;
          }
          emit({ id: plan.id, expected, ...trial, hits, elapsed: Date.now() - began, ...(reached ? { reached } : {}) });
        }
        await inner.reset();
      } catch (error) {
        emit({ stop: null, reason: String(error?.message ?? error) });
      } finally {
        delete globalThis[trialKey];
      }
    }
  }

  #engine(startTests, path) {
    const unhandled = watchUnhandled();
    const quiet = Object.create(this);
    let selected;
    // The worker reports nothing of these runs to Vitest.
    Object.assign(quiet, {
      config: { ...this.config, bail: 0 },
      onTaskUpdate: async () => {},
      onTestAnnotate: async (_test, annotation) => annotation,
      onTestArtifactRecord: async (_test, artifact) => artifact,
      onCollectStart: file => base.onCollectStart.call(quiet, file),
      onCollected: files => { if (selected) for (const file of files) choose(file, selected); },
      onBeforeCollect: () => {},
      onAfterRunFiles: () => base.onAfterRunFiles.call(quiet),
      onAfterRunTask: test => {
        if (test.result?.state === 'fail') quiet.cancelRun = true;
        return base.onAfterRunTask.call(quiet, test);
      },
      onAfterRunSuite: async suite => {
        if (suite.mode !== 'skip' && 'filepath' in suite) await quiet.snapshotClient.finish(suite.file.filepath);
        quiet.workerState.current = suite.suite || suite.file;
      },
    });
    const reset = async trial => {
      const namespace = globalThis.__stryker__ ??= {};
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetConfig();
      this.moduleRunner.mocker.reset();
      for (const [id, node] of this.workerState.evaluatedModules.idToModuleMap) {
        if (vitestModule.test(id)) continue;
        node.promise = undefined;
        node.exports = undefined;
        node.evaluated = false;
        node.importers.clear();
      }
      Object.assign(namespace, { activeMutant: undefined, currentTestId: undefined, hitCount: 0, hitLimit: undefined, shift: 0,
        mutantCoverage: { static: {}, perTest: {} } });
      if (trial) globalThis[trialKey] = trial;
      else delete globalThis[trialKey];
    };
    const inner = async (trial, tests, baselineTests) => {
      await reset(trial);
      selected = tests && new Set(tests);
      const expected = new Set(baselineTests);
      quiet.cancelRun = false;
      const before = unhandled.count;
      const files = await startTests([path], quiet);
      await new Promise(resolve => immediate(resolve));
      const summary = { passed: 0, failed: [], errors: [], timeout: false, foreign: 0, missing: expected.size };
      for (const file of files) summarize(file, summary, expected);
      return { ...summary, unhandled: unhandled.count - before };
    };
    inner.reset = () => reset();
    return inner;
  }

  onAfterRunFiles(files) {
    super.onAfterRunFiles(files);
    const state = globalThis[sessionKey];
    if (!state || state.phase === 'trials') return;
    const { mutantCoverage, hitCount, observed } = globalThis.__stryker__;
    appendFileSync(state.destination, JSON.stringify({
      modules: files.map(file => [file.projectName ?? '', file.filepath]),
      coverage: mutantCoverage, hits: hitCount, observed,
    }) + '\n');
  }
}
