import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const reporter = fileURLToPath(new URL('./vitest-reporter.mjs', import.meta.url));
const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const toolDependencies = [
  { name: 'vitest', bin: 'vitest.mjs', command: 'vitest' },
  { name: '@playwright/test', bin: 'cli.js', command: 'playwright' },
  { name: 'typescript' },
];
const excluded = new Set(['.git', '.worktree', '.worktrees', 'docs.local', 'node_modules', 'reports', '.stryker-tmp']);
const toolRequire = createRequire(import.meta.url);

export function resolveOptional(require, id) {
  try {
    return require.resolve(id);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}

export function runnerPackage(root, runner) {
  const name = runner === 'vitest' ? 'vitest' : '@playwright/test';
  const manifest = resolveOptional(createRequire(resolve(root, 'package.json')), name + '/package.json');
  if (!manifest) {
    const label = runner === 'vitest' ? 'Vitest' : 'Playwright';
    throw new Error(`Install ${label} in the project or its workspace: npm install -D ${name}`);
  }
  return manifest;
}

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
    const components = fromRoot.split(sep);
    const dependency = components.indexOf('node_modules');
    if (dependency === 0) throw new Error(`Copy exclusion cannot target node_modules: ${path}`);
    if (dependency > 0 && dependency !== components.length - 1) {
      throw new Error(`Copy exclusion cannot target node_modules contents: ${path}`);
    }
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

function linkInstalledModules(source, root, projectModules, installed, tools) {
  const mergedDirectories = new Set(tools.map(({ name }) => dirname(name)));
  const entries = readdirSync(projectModules, { withFileTypes: true }).flatMap(entry =>
    (entry.isDirectory() && entry.name.startsWith('@') || mergedDirectories.has(entry.name))
      ? readdirSync(resolve(projectModules, entry.name), { withFileTypes: true })
        .map(child => ({ entry: child, name: join(entry.name, child.name) }))
      : [{ entry, name: entry.name }]);
  const modules = entries.map(({ entry, name }) => {
    const original = resolve(projectModules, name);
    const target = entry.isSymbolicLink() && existsSync(original) ? realpathSync(original) : null;
    const within = target === null ? '..' : relative(source, target);
    const local = within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within) &&
      !within.split(sep).includes('node_modules');
    return { name, target: local ? resolve(root, within) : original, local };
  });
  if (!tools.length && !modules.some(module => module.local)) {
    symlinkSync(projectModules, installed, 'dir');
    return;
  }
  linkModules(installed, [...modules, ...tools]);
}

function linkModules(installed, modules) {
  for (const { name, target, type } of modules) {
    const destination = resolve(installed, name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(target, destination, type);
  }
}

function toolLinks(source, projectModules, hasLocalModules) {
  const projectRequire = createRequire(resolve(source, 'package.json'));
  const links = [];
  const canLink = name => {
    const destination = resolve(projectModules, name);
    const parent = dirname(destination);
    return (!lstatSync(parent, { throwIfNoEntry: false }) || statSync(parent, { throwIfNoEntry: false })?.isDirectory()) &&
      !lstatSync(destination, { throwIfNoEntry: false });
  };
  for (const { name, bin, command } of toolDependencies) {
    if (!canLink(name)) continue;
    const id = name + '/package.json';
    const manifest = resolveOptional(projectRequire, id) ?? (!hasLocalModules ? resolveOptional(toolRequire, id) : undefined);
    if (!manifest) continue;
    const target = dirname(manifest);
    links.push({ name, target, type: 'dir' });
    if (bin && canLink(join('.bin', command))) {
      links.push({ name: join('.bin', command), target: resolve(target, bin), type: 'file' });
    }
  }
  return links;
}

function rebaseCopiedLinks(source, workspace) {
  for (const entry of readdirSync(workspace, { withFileTypes: true, recursive: true })) {
    if (!entry.isSymbolicLink()) continue;
    const path = resolve(entry.parentPath, entry.name);
    const target = resolve(entry.parentPath, readlinkSync(path));
    let within = relative(source, target);
    const outside = value => isAbsolute(value) || value === '..' || value.startsWith('..' + sep);
    if (outside(within) && existsSync(target)) within = relative(source, realpathSync(target));
    if (outside(within)) continue;
    unlinkSync(path);
    symlinkSync(resolve(workspace, within), path);
  }
}

export function withCopy(project, action, { exclude = [] } = {}) {
  const source = realpathSync(project);
  const exclusions = resolveCopyExclusions(source, exclude);
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'tmt-')));
  try {
    const root = resolve(temp, 'project');
    const moduleTrees = [];
    cpSync(source, root, {
      recursive: true,
      filter(path) {
        if (path !== source && basename(path) === 'node_modules' && !exclusions.includes(path) &&
            !copyPathIsExcluded(source, dirname(path), exclusions) &&
            statSync(path, { throwIfNoEntry: false })?.isDirectory()) moduleTrees.push(path);
        return !copyPathIsExcluded(source, path, exclusions);
      },
    });
    rebaseCopiedLinks(source, root);
    const projectModules = resolve(source, 'node_modules');
    const hasLocalModules = moduleTrees.includes(projectModules);
    const tools = toolLinks(source, projectModules, hasLocalModules);
    for (const modules of moduleTrees) {
      linkInstalledModules(source, root, modules, resolve(root, relative(source, modules)), modules === projectModules ? tools : []);
    }
    if (!hasLocalModules) linkModules(resolve(root, 'node_modules'), tools);
    return action(root, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function runVitest(root, temp, { trace, config, testFiles = [], product = false, active, probePreload, synchronousTrace, timeout = 60_000 } = {}) {
  const vitest = resolve(dirname(runnerPackage(root, 'vitest')), 'vitest.mjs');
  const testsToRun = [...new Set(testFiles.map(file => inside(root, file)))];
  const configuration = config === undefined ? [] : ['--config', inside(root, config)];
  const report = resolve(temp, 'vitest.json');
  rmSync(report, { force: true });
  const cache = resolve(temp, 'vite-cache');
  mkdirSync(cache, { recursive: true });
  const result = spawnSync(process.execPath, [
    supervisor, resolve(temp, 'vitest.pid'), String(timeout),
    vitest, 'run', '--maxWorkers=1', '--maxConcurrency=1', '--no-file-parallelism', '--no-cache',
    ...configuration, ...(product ? ['--reporter', reporter] : ['--reporter=json', '--outputFile', report]),
    ...testsToRun,
  ], {
    cwd: root,
    env: {
      ...process.env, CI: 'true', VITE_CACHE_DIR: cache, TMT_WORKSPACE: root, TMT_REPORT: report,
      TMT_TRACE: trace ?? '', TMT_ACTIVE_SITE: active ?? '', TMT_TRACE_SYNC: synchronousTrace ? '1' : '',
      ...(probePreload ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(probePreload)]
        .filter(Boolean).join(' ') } : {}),
    },
    encoding: 'utf8',
    timeout: timeout + 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 124 || result.error?.code === 'ETIMEDOUT') return { status: 'timeout', output: result.stderr ?? '' };
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

// A baseline report names what failed so the suite can be fixed without a second run.
export function failedTests(run, limit = 20) {
  return (run.tests ?? []).filter(test => test.status === 'failed').slice(0, limit).map(test => ({
    file: test.file, name: test.name, failures: (test.failures ?? []).slice(0, 5).map(failure => String(failure).slice(0, 2000)),
  }));
}
