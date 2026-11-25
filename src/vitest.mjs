import { spawn, spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const reporter = fileURLToPath(new URL('./vitest-reporter.mjs', import.meta.url));
const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const relatedWorker = fileURLToPath(new URL('./vitest-related-worker.mjs', import.meta.url));
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

const normalizeExclusionKey = value => (process.platform === 'win32' ? value.toLowerCase() : value);

export function resolveCopyExclusions(source, exclude = [], { onMissing } = {}) {
  const resolved = [];
  const seenResolved = new Set();
  const seenMissing = new Set();
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  for (const path of exclude) {
    const candidate = resolve(source, path);
    const fromRoot = relative(source, candidate);
    if (!fromRoot || isAbsolute(path) || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
      throw new Error(`Copy exclusion must be inside the project: ${path}`);
    }
    const components = fromRoot.split(sep);
    const dependency = components.findIndex(part => (caseInsensitive ? part.toLowerCase() : part) === 'node_modules');
    if (dependency === 0) throw new Error(`Copy exclusion cannot target node_modules: ${path}`);
    if (dependency > 0 && dependency !== components.length - 1) {
      throw new Error(`Copy exclusion cannot target node_modules contents: ${path}`);
    }
    let cursor = source;
    let parentMissing = false;
    for (let i = 0; i < components.length - 1; i++) {
      cursor = resolve(cursor, components[i]);
      const stat = lstatSync(cursor, { throwIfNoEntry: false });
      if (!stat) {
        parentMissing = true;
        break;
      }
      if (stat.isSymbolicLink() || realpathSync(cursor) !== cursor) {
        throw new Error(`Copy exclusion must not traverse a symbolic link: ${path}`);
      }
      if (!stat.isDirectory()) {
        parentMissing = true;
        break;
      }
    }
    const key = normalizeExclusionKey(candidate);
    if (parentMissing || !lstatSync(candidate, { throwIfNoEntry: false })) {
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        onMissing?.(path, candidate);
      }
      continue;
    }
    if (!seenResolved.has(key)) {
      seenResolved.add(key);
      resolved.push(candidate);
    }
  }
  return resolved;
}

export function copyPathIsExcluded(source, path, exclusions) {
  const normalizedPath = normalizeExclusionKey(path);
  return relative(source, path).split(sep).some(part => excluded.has(part)) ||
    exclusions.some(exclusion => {
      const normalizedExclusion = normalizeExclusionKey(exclusion);
      return normalizedPath === normalizedExclusion || normalizedPath.startsWith(normalizedExclusion + sep);
    });
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

const activeCopies = new Set();
let signalHandlersRegistered = false;

function stopCopyProcesses(dir) {
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.pid')) continue;
      const pid = Number(readFileSync(resolve(dir, entry), 'utf8').trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        try {
          if (process.platform === 'win32') process.kill(pid, sig);
          else process.kill(-pid, sig);
        } catch {
          // Process already exited or unreachable.
        }
      }
    }
  } catch {
    // Best-effort process stop during shutdown.
  }
}

function cleanupActiveCopies() {
  for (const dir of [...activeCopies]) {
    activeCopies.delete(dir);
    stopCopyProcesses(dir);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best-effort cleanup during shutdown.
    }
  }
}

function handleSignal(signal, code) {
  if (activeCopies.size === 0) {
    process.off(signal, signal === 'SIGINT' ? handleSigint : handleSigterm);
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(code);
    }
    return;
  }
  cleanupActiveCopies();
  process.exit(code);
}

function handleSigint() {
  handleSignal('SIGINT', 130);
}

function handleSigterm() {
  handleSignal('SIGTERM', 143);
}

function registerActiveCopy(dir) {
  activeCopies.add(dir);
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    process.on('exit', cleanupActiveCopies);
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
  }
}

function unregisterActiveCopy(dir) {
  activeCopies.delete(dir);
  // Defer listener removal to the next turn so a signal queued during a synchronous
  // `withCopy` call (e.g. `spawnSync`) is still delivered and exits with 130/143.
  if (signalHandlersRegistered && activeCopies.size === 0) {
    setImmediate(() => {
      if (signalHandlersRegistered && activeCopies.size === 0) {
        signalHandlersRegistered = false;
        process.off('exit', cleanupActiveCopies);
        process.off('SIGINT', handleSigint);
        process.off('SIGTERM', handleSigterm);
      }
    }).unref?.();
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export const DEFAULT_LARGE_COPY_BYTES = 500 * 1024 * 1024;
export const DEFAULT_LARGE_COPY_FILES = 10_000;

function snapshotWorkspaceTree(root) {
  const entries = new Map();
  const walk = (dir, insideNodeModules = false) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      const rel = relative(root, full);
      const st = lstatSync(full, { bigint: true });
      const kind = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f';
      entries.set(rel, kind === 'd' ? `d:${st.mode}` : `${kind}:${st.mode}:${st.size}:${st.mtimeNs}`);
      if (kind === 'd') {
        if (entry.name === 'node_modules') {
          // Only inspect real (copied/synthesized) node_modules entries without following symlinks into shared installs.
          walk(full, true);
        } else if (!insideNodeModules || entry.name.startsWith('@') || entry.name === '.bin') {
          walk(full, insideNodeModules);
        }
      }
    }
  };
  walk(root);
  return entries;
}

function workspaceTreeChanged(before, root) {
  const after = snapshotWorkspaceTree(root);
  if (after.size !== before.size) return true;
  for (const [rel, sig] of before) {
    if (after.get(rel) !== sig) return true;
  }
  return false;
}

export function createCopy(project, {
  exclude = [],
  onProgress,
  onLargeCopy,
  largeCopyBytes = DEFAULT_LARGE_COPY_BYTES,
  largeCopyFiles = DEFAULT_LARGE_COPY_FILES,
} = {}) {
  const source = realpathSync(project);
  const exclusions = resolveCopyExclusions(source, exclude);
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'tmt-')));
  registerActiveCopy(temp);
  let removed = false;
  let claimed = false;
  let busy = false;
  const dispose = () => {
    if (removed) return;
    removed = true;
    busy = false;
    unregisterActiveCopy(temp);
    rmSync(temp, { recursive: true, force: true });
  };
  const claim = () => {
    if (claimed || removed || busy) return false;
    claimed = true;
    return true;
  };
  const beginUse = () => {
    if (claimed || removed || busy) return false;
    busy = true;
    return true;
  };
  const endUse = () => {
    busy = false;
  };
  try {
    const root = resolve(temp, 'project');
    const moduleTrees = [];
    let copiedFiles = 0;
    let copiedBytes = 0;
    let warnedLargeCopy = false;
    const copyStarted = Date.now();
    let lastProgressAt = copyStarted;
    onProgress?.('Copying project to temporary workspace...');
    cpSync(source, root, {
      recursive: true,
      // Copy-on-write where the file system offers it (APFS, Btrfs, XFS); an ordinary copy elsewhere.
      mode: constants.COPYFILE_FICLONE,
      filter(path) {
        if (path !== source && basename(path) === 'node_modules' && !exclusions.includes(path) &&
            !copyPathIsExcluded(source, dirname(path), exclusions) &&
            statSync(path, { throwIfNoEntry: false })?.isDirectory()) moduleTrees.push(path);
        const keep = !copyPathIsExcluded(source, path, exclusions);
        if (keep && path !== source) {
          const st = lstatSync(path, { throwIfNoEntry: false });
          if (st?.isFile()) {
            copiedFiles++;
            copiedBytes += st.size;
            if (!warnedLargeCopy && (copiedBytes >= largeCopyBytes || copiedFiles >= largeCopyFiles)) {
              warnedLargeCopy = true;
              const message = `Warning: Copying a large project (${formatBytes(copiedBytes)}, ${copiedFiles} files) into a temporary directory. ` +
                'Consider excluding large directories with --copy-exclude <PATH> or setting "copyExclude" in targeted-mutation.config.json.';
              if (onLargeCopy) onLargeCopy({ bytes: copiedBytes, files: copiedFiles, message });
              else process.stderr.write(message + '\n');
            }
            if (onProgress) {
              const now = Date.now();
              if (now - lastProgressAt >= 2_000) {
                lastProgressAt = now;
                onProgress(`Copying project (${copiedFiles} files, ${formatBytes(copiedBytes)})...`);
              }
            }
          }
        }
        return keep;
      },
    });
    if (onProgress && (Date.now() - copyStarted >= 500 || copiedFiles >= 1_000)) {
      onProgress(`Copied ${copiedFiles} files (${formatBytes(copiedBytes)}).`);
    }
    rebaseCopiedLinks(source, root);
    const projectModules = resolve(source, 'node_modules');
    const hasLocalModules = moduleTrees.includes(projectModules);
    const tools = toolLinks(source, projectModules, hasLocalModules);
    for (const modules of moduleTrees) {
      linkInstalledModules(source, root, modules, resolve(root, relative(source, modules)), modules === projectModules ? tools : []);
    }
    if (!hasLocalModules) linkModules(resolve(root, 'node_modules'), tools);
    return { root, temp, dispose, claim, beginUse, endUse };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function withCopy(project, action, {
  reuseCopy,
  exclude = [],
  onProgress,
  onLargeCopy,
  largeCopyBytes = DEFAULT_LARGE_COPY_BYTES,
  largeCopyFiles = DEFAULT_LARGE_COPY_FILES,
} = {}) {
  const copy = reuseCopy?.claim?.()
    ? reuseCopy
    : createCopy(project, { exclude, onProgress, onLargeCopy, largeCopyBytes, largeCopyFiles });
  let pending = false;
  try {
    const result = action(copy.root, copy.temp);
    // An action that is still running keeps its copy until it settles.
    pending = typeof result?.then === 'function';
    return pending ? result.finally(copy.dispose) : result;
  } finally {
    if (!pending) copy.dispose();
  }
}

// How one Vitest run is started, shared by the blocking and the concurrent form.
function vitestCommand(root, temp, { trace, config, testFiles = [], testProjects = [], product = false, active, probePreload, synchronousTrace, timeout = 60_000, workers = 1 } = {}) {
  const vitest = resolve(dirname(runnerPackage(root, 'vitest')), 'vitest.mjs');
  const testsToRun = [...new Set(testFiles.map(file => inside(root, file)))];
  const projectArgs = [...new Set(testProjects.filter(Boolean))].flatMap(name => ['--project', name]);
  const configuration = config === undefined ? [] : ['--config', inside(root, config)];
  const report = resolve(temp, 'vitest.json');
  rmSync(report, { force: true });
  const cache = resolve(temp, 'vite-cache');
  mkdirSync(cache, { recursive: true });
  const workerArgs = workers > 1
    ? [`--maxWorkers=${workers}`, '--maxConcurrency=1']
    : ['--maxWorkers=1', '--maxConcurrency=1', '--no-file-parallelism'];
  return { report, testsToRun, product, args: [
    supervisor, resolve(temp, 'vitest.pid'), String(timeout),
    vitest, 'run', ...workerArgs, '--no-cache',
    ...configuration, ...projectArgs, ...(product ? ['--reporter', reporter] : ['--reporter=json', '--outputFile', report]),
    ...testsToRun,
  ], options: {
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
  } };
}

function vitestOutcome(root, { report, testsToRun, product }, result) {
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
    return { status, tests: data.tests, errors: data.errors, moduleErrors: data.moduleErrors ?? [], output: result.stderr + result.stdout };
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

export async function resolveRelatedVitestSpecs(project, targetFiles = [], { config, copyExclude = [], timeout = 60_000, onProgress, onLargeCopy, copy } = {}) {
  const root = realpathSync(project);
  const relTargets = [...new Set(targetFiles.map(file => relative(root, inside(root, file))))];
  if (!relTargets.length) return { tests: [], specs: [] };
  // Validate Vitest availability up front before copying.
  runnerPackage(root, 'vitest');
  const resolveInWorkspace = async (workspace, temp) => {
    onProgress?.('Resolving related Vitest test files...');
    const cache = resolve(temp, 'vite-cache');
    mkdirSync(cache, { recursive: true });
    const manifestPath = resolve(temp, 'related-request.json');
    const outputPath = resolve(temp, 'related-output.json');
    const pidPath = resolve(temp, 'related.pid');
    writeFileSync(manifestPath, JSON.stringify({
      workspace,
      config,
      targets: relTargets,
      output: outputPath,
    }), 'utf8');
    const maxBuffer = 4 * 1024 * 1024;
    let run;
    try {
      run = await new Promise(settle => {
        const child = spawn(process.execPath, [
          supervisor, pidPath, String(timeout),
          relatedWorker, manifestPath,
        ], {
          cwd: workspace,
          env: { ...process.env, CI: 'true', VITEST: '1', NODE_ENV: 'test', VITE_CACHE_DIR: cache },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = { stdout: '', stderr: '' };
        for (const stream of ['stdout', 'stderr']) {
          child[stream].setEncoding('utf8');
          child[stream].on('data', chunk => { if (out[stream].length < maxBuffer) out[stream] += chunk; });
        }
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, timeout + 5_000);
        killTimer.unref?.();
        let failure;
        child.once('error', error => { failure = error; });
        child.once('close', (status, signal) => {
          clearTimeout(killTimer);
          settle({
            status,
            signal,
            ...out,
            error: failure ?? (signal && status === null ? Object.assign(new Error('Vitest related discovery did not finish in time'), { code: 'ETIMEDOUT' }) : undefined),
          });
        });
      });
    } finally {
      // Remove the finished worker PID file so a reused copy's signal handler never targets a recycled PID.
      rmSync(pidPath, { force: true });
    }
    if (run.status === 124 || run.error?.code === 'ETIMEDOUT') {
      throw new Error(`Vitest related test discovery timed out after ${Math.round(timeout / 1000)}s. Try increasing --timeout or specifying --test <FILE>.`);
    }
    if (run.status !== 0 || !existsSync(outputPath)) {
      const detail = (run.stderr || run.stdout || run.error?.message || '').trim();
      throw new Error(detail || 'Failed to resolve related Vitest tests');
    }
    const { specs = [] } = JSON.parse(readFileSync(outputPath, 'utf8'));
    const tests = [...new Set(specs.map(spec => spec.file))].sort();
    if (!tests.length) {
      const shown = targetFiles.slice(0, 5).join(', ') + (targetFiles.length > 5 ? `, ... (${targetFiles.length} files)` : '');
      throw new Error(`No Vitest test files are related to ${shown}. Specify test files explicitly with --test <FILE>.`);
    }
    return { tests, specs };
  };
  if (copy?.beginUse?.()) {
    try {
      const before = snapshotWorkspaceTree(copy.root);
      const result = await resolveInWorkspace(copy.root, copy.temp);
      if (workspaceTreeChanged(before, copy.root)) {
        // Vitest config or plugins modified the workspace during discovery; discard so analysis gets a clean copy.
        copy.dispose();
      }
      return result;
    } finally {
      copy.endUse();
    }
  }
  return withCopy(root, resolveInWorkspace, { exclude: copyExclude, onProgress, onLargeCopy });
}

export async function resolveRelatedVitestTests(project, targetFiles = [], options = {}) {
  const { tests } = await resolveRelatedVitestSpecs(project, targetFiles, options);
  return tests;
}

export function runVitest(root, temp, settings) {
  const command = vitestCommand(root, temp, settings);
  return vitestOutcome(root, command, spawnSync(process.execPath, command.args, command.options));
}

// The same run without blocking, so several project copies can run their suites side by side.
export async function runVitestAsync(root, temp, settings) {
  const command = vitestCommand(root, temp, settings);
  const result = await new Promise(settle => {
    const child = spawn(process.execPath, command.args, { ...command.options, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => { if (output[stream].length < command.options.maxBuffer) output[stream] += chunk; });
    }
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (status, signal) => settle({ status, signal, ...output,
      error: failure ?? (signal && status === null ? Object.assign(new Error('Vitest did not finish in time'), { code: 'ETIMEDOUT' }) : undefined) }));
  });
  return vitestOutcome(root, command, result);
}
