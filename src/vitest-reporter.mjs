import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const primitive = value => ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : undefined;

export function snapshotVitestRun(root, modules, unhandled, reason) {
  const errors = [...unhandled];
  const moduleErrors = [];
  const tests = [];
  const files = [];
  for (const module of modules) {
    const file = relative(root, module.moduleId);
    files.push(file);
    const moduleTests = [...module.children.allTests()];
    const loadErrors = module.errors();
    // File-level `beforeAll` / `afterAll` failures also appear in `module.errors()`, but only after collection
    // succeeded (`moduleTests.length > 0`). A genuine import/load failure leaves zero collected tests in the module.
    if (loadErrors.length && moduleTests.length === 0) moduleErrors.push(...loadErrors);
    errors.push(...loadErrors);
    for (const suite of module.children.allSuites()) errors.push(...suite.errors());
    for (const test of moduleTests) {
      const result = test.result();
      tests.push({
        id: test.id, file,
        project: test.project.name, name: test.fullName, status: result.state,
        failures: result.errors?.map(error => error.message) ?? [],
        assertions: result.errors?.filter(error => error.name === 'AssertionError')
          .map(({ actual, expected, message }) => ({ actual: primitive(actual), expected: primitive(expected), message })),
        timeout: result.errors?.some(error => /^(?:Hook|Test) timed out in \d+ms\.\nIf this is a long-running/.test(error.message ?? '')) ?? false,
        retry: test.options.retry ?? 0, repeats: test.options.repeats ?? 0,
        concurrent: test.options.concurrent ?? false,
      });
    }
  }
  return { tests, modules: files, errors: errors.map(error => error.message), moduleErrors: moduleErrors.map(error => error.message), reason };
}

// How long each test and each test file's collection took, for ordering later work by cost.
export function timeVitestRun(modules) {
  const tests = {};
  const collection = {};
  for (const module of modules) {
    collection[JSON.stringify([module.project.name, module.moduleId])] = module.diagnostic()?.collectDuration ?? 0;
    for (const test of module.children.allTests()) tests[test.id] = test.diagnostic()?.duration ?? 0;
  }
  return { tests, collection };
}

// A baseline report names what failed so the suite can be fixed without a second run.
export function failedTests(run, limit = 20) {
  return (run.tests ?? []).filter(test => test.status === 'failed').slice(0, limit).map(test => ({
    file: test.file, name: test.name, failures: (test.failures ?? []).slice(0, 5).map(failure => String(failure).slice(0, 2000)),
  }));
}

export default class TmtReporter {
  onTestRunEnd(modules, unhandled, reason) {
    const run = snapshotVitestRun(process.env.TMT_WORKSPACE, modules, unhandled, reason);
    writeFileSync(process.env.TMT_REPORT, JSON.stringify(run));
  }
}
