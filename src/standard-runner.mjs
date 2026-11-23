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

function summarize(suite, summary) {
  for (const error of suite.result?.errors ?? []) summary.errors.push(String(error.message ?? error));
  for (const task of suite.tasks) {
    if (task.type !== 'test') summarize(task, summary);
    else if (task.result?.state === 'pass') summary.passed++;
    else if (task.result?.state === 'fail') {
      summary.failed.push(task.id);
      summary.timeout ||= (task.result.errors ?? []).some(timedOut);
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
          emit({ start: plan.id });
          const expected = plan.tests?.length ?? plan.total;
          const trial = await inner({ phase: 'trial', active: plan.id, hitLimit: plan.hitLimit, staticActivation: plan.static }, plan.tests);
          const hits = globalThis.__stryker__.hitCount;
          // The same tests without the mutation, directly afterwards. They must behave as in the baseline, or the
          // trial ran in an environment that an earlier run, or the trial itself, had changed.
          const control = await inner({ phase: 'control' }, plan.tests);
          const controlHits = globalThis.__stryker__.mutantCoverage?.static?.[plan.id] ?? 0;
          if (control.unhandled || control.errors.length || control.failed.length || control.passed !== expected || controlHits !== plan.hits) {
            emit({ stop: plan.id, reason: 'control' });
            break;
          }
          emit({ id: plan.id, expected, ...trial, hits });
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
      Object.assign(namespace, { activeMutant: undefined, currentTestId: undefined, hitCount: 0, hitLimit: undefined,
        mutantCoverage: { static: {}, perTest: {} } });
      if (trial) globalThis[trialKey] = trial;
      else delete globalThis[trialKey];
    };
    const inner = async (trial, tests) => {
      await reset(trial);
      selected = tests && new Set(tests);
      quiet.cancelRun = false;
      const before = unhandled.count;
      const files = await startTests([path], quiet);
      await new Promise(resolve => immediate(resolve));
      const summary = { passed: 0, failed: [], errors: [], timeout: false };
      for (const file of files) summarize(file, summary);
      return { ...summary, unhandled: unhandled.count - before };
    };
    inner.reset = () => reset();
    return inner;
  }

  onAfterRunFiles(files) {
    super.onAfterRunFiles(files);
    const state = globalThis[sessionKey];
    if (!state || state.phase === 'trials') return;
    const { mutantCoverage, hitCount, focused } = globalThis.__stryker__;
    appendFileSync(state.destination, JSON.stringify({
      modules: files.map(file => [file.projectName ?? '', file.filepath]),
      coverage: mutantCoverage, hits: hitCount, focused,
    }) + '\n');
  }
}
