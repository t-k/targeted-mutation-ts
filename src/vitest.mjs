import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const reporter = fileURLToPath(new URL('./vitest-reporter.mjs', import.meta.url));
const toolDependencies = [
  { name: 'vitest', bin: 'vitest.mjs', command: 'vitest' },
  { name: '@playwright/test', bin: 'cli.js', command: 'playwright' },
  { name: 'typescript' },
];
const excluded = new Set(['.git', '.worktree', '.worktrees', 'docs.local', 'node_modules', 'reports', '.stryker-tmp']);

export function inside(root, path) {
  const target = realpathSync(resolve(root, path));
  const fromRoot = relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
    throw new Error(`Path escapes the project: ${path}`);
  }
  return target;
}

export function resolveCopyExclusions(source, exclude = []) {
  return exclude.map(path => {
    const candidate = resolve(source, path);
    const fromRoot = relative(source, candidate);
    if (!fromRoot || isAbsolute(path) || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
      throw new Error(`Copy exclusion must be inside the project: ${path}`);
    }
    if (fromRoot.split(sep)[0] === 'node_modules') throw new Error(`Copy exclusion cannot target node_modules: ${path}`);
    if (!existsSync(candidate)) throw new Error(`Copy exclusion does not exist: ${path}`);
    const parent = dirname(candidate);
    if (realpathSync(parent) !== parent) throw new Error(`Copy exclusion must not traverse a symbolic link: ${path}`);
    return candidate;
  });
}

export function copyPathIsExcluded(source, path, exclusions) {
  return relative(source, path).split(sep).some(part => excluded.has(part)) ||
    exclusions.some(exclusion => path === exclusion || path.startsWith(exclusion + sep));
}

export function withCopy(project, action, { exclude = [] } = {}) {
  const source = realpathSync(project);
  const exclusions = resolveCopyExclusions(source, exclude);
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'tmt-')));
  try {
    const root = resolve(temp, 'project');
    cpSync(source, root, {
      recursive: true,
      filter: path => !copyPathIsExcluded(source, path, exclusions),
    });
    const projectModules = resolve(source, 'node_modules');
    const installed = resolve(root, 'node_modules');
    if (existsSync(projectModules)) {
      symlinkSync(projectModules, installed, 'dir');
    } else {
      const binDir = resolve(installed, '.bin');
      mkdirSync(binDir, { recursive: true });
      for (const { name, bin, command } of toolDependencies) {
        const dependency = dirname(fileURLToPath(import.meta.resolve(name + '/package.json')));
        const link = resolve(installed, name);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(dependency, link, 'dir');
        if (bin) symlinkSync(resolve(dependency, bin), resolve(binDir, command), 'file');
      }
    }
    return action(root, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function runVitest(root, temp, { trace, config, testFiles = [], product = false, active } = {}) {
  const projectRequire = createRequire(resolve(root, 'package.json'));
  const vitest = projectRequire.resolve('vitest/package.json').replace(/package\.json$/, 'vitest.mjs');
  const testsToRun = [...new Set(testFiles.map(file => inside(root, file)))];
  const configuration = config === undefined ? [] : ['--config', inside(root, config)];
  const report = resolve(temp, 'vitest.json');
  rmSync(report, { force: true });
  const cache = resolve(temp, 'vite-cache');
  mkdirSync(cache, { recursive: true });
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--maxWorkers=1', '--maxConcurrency=1', '--no-file-parallelism', '--no-cache',
    ...configuration, ...(product ? ['--reporter', reporter] : ['--reporter=json', '--outputFile', report]),
    ...testsToRun,
  ], {
    cwd: root,
    env: {
      ...process.env, CI: 'true', VITE_CACHE_DIR: cache, TMT_WORKSPACE: root, TMT_REPORT: report,
      TMT_TRACE: trace ?? '', TMT_ACTIVE_SITE: active ?? '',
    },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === 'ETIMEDOUT') return { status: 'timeout', output: result.stderr ?? '' };
  if (result.error || !existsSync(report)) {
    return { status: 'error', output: result.error?.message ?? (result.stderr + result.stdout) };
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
  if (product) {
    if (testsToRun.length) {
      const expected = new Set(testsToRun.map(file => relative(root, file)));
      const actual = new Set(data.modules);
      const missing = [...expected].filter(file => !actual.has(file));
      const unexpected = [...actual].filter(file => !expected.has(file));
      if (missing.length || unexpected.length) {
        return { status: 'error', output: `Vitest test selection mismatch (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
          errors: data.errors };
      }
    }
    const failed = data.tests.filter(test => test.status === 'failed');
    const complete = data.reason === 'passed' || data.reason === 'failed';
    const status = failed.some(test => test.timeout) ? 'timeout'
      : !complete || data.errors.length ? 'error'
        : result.status === 1 && failed.length ? 'failed'
          : result.status === 0 && data.tests.some(test => test.status === 'passed') && !failed.length ? 'passed' : 'error';
    return { status, tests: data.tests, errors: data.errors, output: result.stderr + result.stdout };
  }
  const tests = data.testResults.flatMap(file => file.assertionResults.map(assertion => ({
    file: relative(root, file.name),
    name: assertion.fullName,
    status: assertion.status,
    failures: assertion.failureMessages,
  })));
  const failed = tests.filter(test => test.status === 'failed');
  const status = result.status === 0 && data.success && data.numPassedTests > 0 ? 'passed'
    : result.status === 1 && !data.success && failed.length > 0 &&
      data.testResults.every(file => file.status !== 'failed' || file.assertionResults.some(test => test.status === 'failed'))
      ? 'failed' : 'error';
  return { status, tests, output: result.stderr + result.stdout };
}
