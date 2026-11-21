import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const primitive = value => ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : undefined;

export function snapshotVitestRun(root, modules, unhandled, reason) {
  const errors = [...unhandled];
  const tests = [];
  const files = [];
  for (const module of modules) {
    const file = relative(root, module.moduleId);
    files.push(file);
    errors.push(...module.errors());
    for (const suite of module.children.allSuites()) errors.push(...suite.errors());
    for (const test of module.children.allTests()) {
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
  return { tests, modules: files, errors: errors.map(error => error.message), reason };
}

export default class TmtReporter {
  onTestRunEnd(modules, unhandled, reason) {
    const run = snapshotVitestRun(process.env.TMT_WORKSPACE, modules, unhandled, reason);
    writeFileSync(process.env.TMT_REPORT, JSON.stringify(run));
  }
}
