import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

export default class TmtReporter {
  onTestRunEnd(modules, unhandled, reason) {
    const errors = [...unhandled];
    const tests = [];
    for (const module of modules) {
      errors.push(...module.errors());
      for (const suite of module.children.allSuites()) errors.push(...suite.errors());
      for (const test of module.children.allTests()) {
        const result = test.result();
        tests.push({
          id: test.id, file: relative(process.env.TMT_WORKSPACE, module.moduleId),
          project: test.project.name, name: test.fullName, status: result.state,
          failures: result.errors?.map(error => error.message) ?? [],
          timeout: result.errors?.some(error => /^(?:Hook|Test) timed out in \d+ms\.\nIf this is a long-running/.test(error.message ?? '')) ?? false,
          retry: test.options.retry ?? 0, repeats: test.options.repeats ?? 0,
          concurrent: test.options.concurrent ?? false,
        });
      }
    }
    writeFileSync(process.env.TMT_REPORT, JSON.stringify({ tests, errors: errors.map(error => error.message), reason }));
  }
}
