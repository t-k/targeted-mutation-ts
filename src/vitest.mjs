import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const vitest = fileURLToPath(import.meta.resolve('vitest/package.json')).replace(/package\.json$/, 'vitest.mjs');
const dependencies = resolve(fileURLToPath(new URL('..', import.meta.url)), 'node_modules');
const excluded = new Set(['.git', '.worktree', 'docs.local', 'node_modules', 'reports', '.stryker-tmp']);

export function inside(root, path) {
  const target = realpathSync(resolve(root, path));
  const fromRoot = relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
    throw new Error(`Path escapes the project: ${path}`);
  }
  return target;
}

export function withCopy(project, action) {
  const source = realpathSync(project);
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'tmt-')));
  try {
    const root = resolve(temp, 'project');
    cpSync(source, root, {
      recursive: true,
      filter: path => path === source || !relative(source, path).split(sep).some(part => excluded.has(part)),
    });
    const projectModules = resolve(source, 'node_modules');
    symlinkSync(existsSync(projectModules) ? projectModules : dependencies, resolve(root, 'node_modules'), 'dir');
    return action(root, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function runVitest(root, temp, { trace, filters = [] } = {}) {
  const report = resolve(temp, 'vitest.json');
  rmSync(report, { force: true });
  const cache = resolve(temp, 'vite-cache');
  mkdirSync(cache, { recursive: true });
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--maxWorkers=1', '--no-file-parallelism', '--no-cache', '--reporter=json', '--outputFile', report, ...filters,
  ], {
    cwd: root,
    env: { ...process.env, CI: 'true', VITE_CACHE_DIR: cache, ...(trace ? { TMT_TRACE: trace } : {}) },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === 'ETIMEDOUT') return { status: 'timeout', output: result.stderr ?? '' };
  if (result.error || !existsSync(report)) {
    return { status: 'error', output: result.error?.message ?? (result.stderr + result.stdout) };
  }
  const data = JSON.parse(readFileSync(report, 'utf8'));
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
