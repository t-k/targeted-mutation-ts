import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { checkpointKeyForTrial } from './checkpoint.mjs';
import { extract } from './extract.mjs';
import { selectScope } from './scope.mjs';
import { candidateKey } from './shard.mjs';
import { fullBuiltinGap, targetedGap } from './targeted-gaps.mjs';
import { createTypeContext } from './type-equivalence.mjs';
import { canonicalPath, inside, runnerPackage, withCopy } from './vitest.mjs';

const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const sessionEntry = fileURLToPath(new URL('./playwright-session.mjs', import.meta.url));
const serverPreloadUrl = pathToFileURL(fileURLToPath(new URL('./playwright-server-preload.mjs', import.meta.url))).href;
const workerPreloadUrl = pathToFileURL(fileURLToPath(new URL('./playwright-worker-preload.mjs', import.meta.url))).href;
const defaultConfigs = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(ext => 'playwright.config.' + ext);

export function createPlaywrightConfigWrapper(root, name, {
  injectServerPreload = false,
  originsFile = '',
  bridgeEnv = null,
} = {}) {
  const selected = name ?? defaultConfigs.find(file => existsSync(resolve(root, file)));
  if (!selected) throw new Error('Playwright runs require a project configuration file');
  const original = inside(root, selected);
  const wrapper = resolve(dirname(original), `.tmt-playwright-${randomUUID()}.config.mts`);
  const serializedBridgeEnv = JSON.stringify(bridgeEnv ?? {});
  const serializedServerPreload = JSON.stringify(injectServerPreload ? serverPreloadUrl : '');
  const serializedWorkerPreload = JSON.stringify(injectServerPreload ? workerPreloadUrl : '');
  const serializedOriginsFile = JSON.stringify(originsFile ?? '');
  writeFileSync(wrapper, `import imported from ${JSON.stringify('./' + basename(original))};
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const config = imported.default ?? imported;
const root = process.env.TMT_WORKSPACE;
const configDirectory = dirname(fileURLToPath(import.meta.url));
const bridgeEnv = ${serializedBridgeEnv};
const srvPreload = ${serializedServerPreload};
const wrkPreload = ${serializedWorkerPreload};
const originsOut = ${serializedOriginsFile};
const own = directory => {
  const raw = realpathSync(resolve(configDirectory, directory ?? '.'));
  let resolved = raw;
  if (process.platform === 'win32') {
    try {
      const native = realpathSync.native(raw);
      if (raw.startsWith('\\\\\\\\') || !native.startsWith('\\\\\\\\')) resolved = native;
    } catch {}
  }
  const target = relative(root, resolved);
  if (isAbsolute(target) || target === '..' || target.startsWith('..' + sep)) {
    throw new Error('Managed webServer cwd escapes the trial workspace');
  }
  return resolved;
};
const buildServerNodeOptions = raw => {
  let base = String(raw ?? '');
  if (wrkPreload) {
    base = base.replaceAll('--import=' + wrkPreload, '').replaceAll('--import ' + wrkPreload, '').trim();
  }
  if (srvPreload && !base.includes(srvPreload)) {
    base = (base ? base + ' ' : '') + '--import ' + srvPreload;
  }
  return base;
};
const settings = Array.isArray(config.webServer) ? config.webServer : config.webServer ? [config.webServer] : [];
if (!settings.length) throw new Error('Playwright analysis requires a managed webServer');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const configuredBaseUrls = [];
for (const project of config.projects?.length ? config.projects : [config]) {
  const target = project.use?.baseURL ?? config.use?.baseURL;
  if (target) {
    try { configuredBaseUrls.push(new URL(target)); } catch {}
  }
}
const allowedOrigins = new Set();
const harvestOriginsList = [];
const seenHarvest = new Set();
const servers = settings.map(server => {
  const hasExplicitUrl = server.url !== undefined && server.url !== null && String(server.url).trim() !== '';
  const url = new URL(hasExplicitUrl ? server.url : ('http://localhost:' + server.port));
  if (!loopback.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The managed webServer must listen on loopback');
  }
  if (typeof server.command !== 'string' ||
      (process.env.TMT_ORIGINAL && server.command.includes(process.env.TMT_ORIGINAL))) {
    throw new Error('The managed webServer command must run the trial workspace');
  }
  let primaryOrigin = url.origin;
  if (hasExplicitUrl) {
    allowedOrigins.add(url.origin);
  } else {
    const matchingBases = [...new Set(
      configuredBaseUrls
        .filter(b => b.protocol === url.protocol && b.port === url.port && loopback.has(b.hostname))
        .map(b => b.origin),
    )];
    if (matchingBases.length > 1) {
      throw new Error('Playwright projects target multiple loopback hosts on webServer.port (' + server.port + '); set webServer.url explicitly');
    }
    primaryOrigin = matchingBases[0] ?? url.origin;
    allowedOrigins.add(primaryOrigin);
  }
  if (!seenHarvest.has(primaryOrigin)) {
    seenHarvest.add(primaryOrigin);
    harvestOriginsList.push(primaryOrigin);
  }
  const baseEnv = server.env ?? {};
  const mergedEnv = srvPreload ? {
    ...baseEnv,
    ...bridgeEnv,
    NODE_OPTIONS: buildServerNodeOptions(baseEnv.NODE_OPTIONS ?? process.env.NODE_OPTIONS),
  } : undefined;
  return {
    ...server,
    cwd: own(server.cwd),
    reuseExistingServer: false,
    stderr: server.stderr ?? 'pipe',
    ...(mergedEnv ? { env: mergedEnv } : {}),
  };
});
if (originsOut) {
  try { writeFileSync(originsOut, JSON.stringify(harvestOriginsList), 'utf8'); } catch {}
}
for (const project of config.projects?.length ? config.projects : [config]) {
  const target = project.use?.baseURL ?? config.use?.baseURL;
  if (target && !allowedOrigins.has(new URL(target).origin)) {
    throw new Error('Playwright baseURL (' + target + ') must target a managed webServer origin (' + harvestOriginsList.join(', ') + ')');
  }
}
const browser = (project) => project.use?.browserName ?? project.use?.defaultBrowserType ?? config.use?.browserName ?? 'chromium';
const projects = config.projects?.map(project => ({ ...project,
  metadata: { ...project.metadata, tmtBrowser: browser(project) },
}));
const webServer = Array.isArray(config.webServer) ? servers : servers[0];
export default { ...config, projects, webServer,
  metadata: { ...config.metadata, tmtBrowser: browser(config) }
};
`, { flag: 'wx' });
  return wrapper;
}

export function classifyPlaywright(report, exitCode, workspace) {
  const browsers = new Map(report.config.projects.map(project => [project.name, project.metadata?.tmtBrowser]));
  const fallback = report.config.metadata?.tmtBrowser;
  const tests = [];
  let timeout = false;
  let unstable = false;
  let incomplete = false;

  function walk(suite, parents = []) {
    const headings = suite.title && !suite.file?.endsWith(suite.title) ? [...parents, suite.title] : parents;
    for (const child of suite.suites ?? []) walk(child, headings);
    for (const spec of suite.specs ?? []) {
      const seen = new Map();
      for (const test of spec.tests) {
        const count = seen.get(test.projectName) ?? 0;
        seen.set(test.projectName, count + 1);
        const last = test.results.at(-1);
        const status = test.status === 'flaky' ? 'unstable' : test.status === 'skipped' ? 'skipped'
          : test.status === 'expected' ? 'passed' : 'failed';
        if (test.results.some(attempt => attempt.status === 'timedOut')) timeout = true;
        if (test.status === 'flaky' || test.results.some(attempt => attempt.status === 'interrupted')) unstable = true;
        if (!last && status !== 'skipped') incomplete = true;
        tests.push({
          id: `${spec.id}:${count}`, file: workspace ? relative(workspace, resolve(report.config.rootDir, spec.file)) : spec.file, project: test.projectName, browser: browsers.get(test.projectName) ?? fallback,
          name: [...headings, spec.title].join(' > '), status, worker: last?.workerIndex, parallelIndex: last?.parallelIndex,
          retry: last?.retry, failures: (last?.errors ?? []).map(error => error.message),
        });
      }
    }
  }
  for (const root of report.suites) walk(root);

  const failed = tests.some(test => test.status === 'failed');
  const files = [...new Set(tests.map(test => test.file).filter(Boolean))].sort();
  const fileErrors = report.errors
    .filter(error => error?.location?.file)
    .map(error => ({
      file: workspace ? relative(workspace, resolve(report.config.rootDir, error.location.file)) : error.location.file,
      message: String(error.message ?? error),
    }));
  const status = report.errors.length || incomplete || !tests.length ? 'error'
    : timeout ? 'timeout' : unstable ? 'unstable'
      : exitCode === 0 && !failed && tests.some(test => test.status === 'passed') ? 'passed'
        : exitCode === 1 && failed ? 'failed' : 'error';
  return { status, tests, files, errors: report.errors.map(error => error.message), fileErrors };
}

// Playwright takes test files as patterns, so a path is passed with its pattern characters escaped.
export const testFilters = (root, tests = []) => [...new Set(tests.map(file => relative(root, inside(root, file))))]
  .map(file => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export function runPlaywright(root, temp, { config, projects = [], tests = [], timeout = 60_000, original, wrapperOptions, extraEnv } = {}) {
  const bin = resolve(dirname(runnerPackage(root, 'playwright')), 'cli.js');
  const wrapper = createPlaywrightConfigWrapper(root, config, wrapperOptions);
  const report = resolve(temp, 'playwright.json');
  const pid = resolve(temp, 'playwright.pid');
  const server = resolve(temp, 'server.pid');
  const attempt = randomUUID();
  const child = spawnSync(process.execPath, [supervisor, pid, String(timeout), bin,
    'test', '--config', wrapper, '--workers=1', '--reporter=json', '--global-timeout', String(Math.max(100, timeout - 3000)),
    '--output', resolve(temp, 'results'),
    ...projects.flatMap(project => ['--project', project]),
    ...testFilters(root, tests),
  ], {
    cwd: root, encoding: 'utf8', timeout: timeout + 5000, maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: report, TMT_RUN_ID: attempt, TMT_SERVER_PID_FILE: server,
      TMT_WORKSPACE: root, TMT_ORIGINAL: original ?? '',
      ...(extraEnv ?? {}),
    },
  });
  const output = child.error?.message ?? child.stderr + child.stdout;
  const runnerPid = existsSync(pid) ? Number(readFileSync(pid, 'utf8')) : undefined;
  const serverPid = existsSync(server) ? Number(readFileSync(server, 'utf8')) : undefined;
  const metadata = { output, attempt, runnerPid, serverPid };
  if (child.status === 124 || child.error?.code === 'ETIMEDOUT') {
    return { status: 'timeout', statusReason: `Playwright timed out after ${Math.round(timeout / 1000)}s`, ...metadata };
  }
  if (child.error || !existsSync(report)) return { status: 'error', ...metadata };
  try {
    return { ...classifyPlaywright(JSON.parse(readFileSync(report, 'utf8')), child.status, root), ...metadata };
  } catch (error) {
    return { status: 'error', ...metadata, output: output + '\n' + error.message };
  }
}

function readJsonlEvents(path) {
  if (!existsSync(path)) return [];
  const input = readFileSync(path, 'utf8');
  const completeLines = input.endsWith('\n') ? input.split('\n').slice(0, -1) : input.split('\n').slice(0, -1);
  return completeLines.filter(Boolean).map(line => JSON.parse(line));
}

function supervisePlaywrightSession(workspace, temp, manifest, limit, signal) {
  const log = resolve(temp, 'playwright-session.stderr');
  const descriptor = openSync(log, 'w');
  return new Promise(settle => {
    const child = spawn(process.execPath, [supervisor, resolve(temp, 'playwright-session.pid'), String(limit), sessionEntry, manifest], {
      cwd: workspace,
      stdio: ['ignore', 'ignore', descriptor],
      timeout: limit + 5_000,
      signal,
      env: { ...process.env, CI: 'true' },
    });
    const finish = result => {
      closeSync(descriptor);
      settle({ ...result, stderr: readFileSync(log, 'utf8').slice(0, 4 * 1024 * 1024) });
    };
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (status, stopped) => finish({ status, signal: stopped, error: failure }));
  });
}

export function readPidStartSignature(pid) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const res = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1500 });
    if (res.status !== 0) return null;
    const sig = String(res.stdout ?? '').trim();
    return sig || null;
  } catch {
    return null;
  }
}

export function terminateRecordedPids(pidsFile, { readStartSignature = readPidStartSignature } = {}) {
  if (!pidsFile || !existsSync(pidsFile)) return;
  let lines = [];
  try {
    lines = readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return;
  }
  const pidEntries = new Map();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (Number.isInteger(parsed?.pid) && parsed.pid > 1 && parsed.pid !== process.pid) {
        const lstart = typeof parsed.lstart === 'string' && parsed.lstart.trim() ? parsed.lstart.trim() : null;
        if (!pidEntries.has(parsed.pid) || lstart) {
          pidEntries.set(parsed.pid, lstart);
        }
      }
    } catch {}
  }
  const matchesIdentity = (pid, expectedLstart) => {
    if (!expectedLstart || process.platform === 'win32') return true;
    const current = readStartSignature(pid);
    return Boolean(current && current === expectedLstart);
  };
  const signalPid = (pid, sig) => {
    if (process.platform !== 'win32') {
      try { process.kill(-pid, sig); } catch {}
    }
    try { process.kill(pid, sig); } catch {}
  };
  const alive = [];
  for (const [pid, expectedLstart] of pidEntries) {
    try {
      process.kill(pid, 0);
      if (!matchesIdentity(pid, expectedLstart)) continue;
      signalPid(pid, 'SIGTERM');
      alive.push([pid, expectedLstart]);
    } catch {}
  }
  if (!alive.length) return;
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    if (alive.every(([pid]) => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
  }
  for (const [pid, expectedLstart] of alive) {
    try {
      process.kill(pid, 0);
      if (!matchesIdentity(pid, expectedLstart)) continue;
      signalPid(pid, 'SIGKILL');
    } catch {}
  }
}

// Runs a switched Playwright E2E session: instruments sources once with pure-JS switches + comparison probes,
// starts webServer + browserServer once, collects dual-realm baseline observations, plans threshold/margin shifts,
// and decides reached mutants with post-trial control checks and automatic isolated fallback.
export async function analyzePlaywrightSession(project, files, options) {
  const root = canonicalPath(project);
  const profile = options.mutators ?? 'targeted';
  const targets = selectScope(root, files, options).map(subject => ({
    ...subject,
    input: readFileSync(inside(root, subject.file)),
  }));
  const extraction = [];
  for (const { file, input } of targets) {
    const ext = extract(input, { file, mode: options.mode, dialect: options.dialect });
    extraction.push({ file, path: ext.path, reason: ext.reason, diagnostics: ext.diagnostics, ...(ext.fallback === undefined ? {} : { fallback: ext.fallback }) });
  }
  if (extraction.some(item => item.path === 'diagnostic')) {
    return {
      schemaVersion: 1,
      runner: 'playwright',
      mutators: profile,
      extraction,
      mutants: [],
      diagnostics: [],
      evaluation: 'no_sites',
    };
  }
  const originals = new Map(targets.map(({ file, input }) => [file, input]));
  const typeContext = options['type-check']
    ? createTypeContext(root, targets.map(t => t.file), {
      tsconfig: options.tsconfig,
      onWarning: options.onTypeCheckWarning,
      silent: options['type-check'] === 'auto',
    })
    : null;

  const { sources, mutants: prepared } = prepareBuiltinSwitches(targets, {
    dialect: options.dialect,
    shifts: true,
    recordComparisons: true,
    trackLoadedFile: true,
    excludeRules: options['exclude-rule'],
    typeContext,
    targeted: true,
    ...(profile === 'targeted' ? { keep: targetedOrBoundary } : {}),
  });

  const report = {
    schemaVersion: 1,
    runner: 'playwright',
    mutators: profile,
    extraction,
    mutants: [],
    diagnostics: [],
    evaluation: 'no_sites',
    ...(options.config !== undefined || options.test?.length || options['copy-exclude']?.length ? {
      selection: { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] },
    } : {}),
  };

  const shardKeys = options.shardKeys;
  const inShard = mutant => !shardKeys || mutant.parametric || shardKeys.has(candidateKey({
    location: mutant.location,
    rule: mutant.mutatorName,
    replacement: mutant.replacement,
  }));
  const mutants = prepared.filter(mutant => !mutant.parametric && inShard(mutant));
  const ckpt = options.checkpointStore;
  const cachedById = new Map();
  if (ckpt) {
    for (const mutant of mutants) {
      if (mutant.status !== undefined) continue;
      const hit = ckpt.get(checkpointKeyForTrial(mutant));
      if (hit) cachedById.set(mutant.id, hit);
    }
  }
  const runnable = prepared.filter(mutant => mutant.status === undefined && inShard(mutant) && !cachedById.has(mutant.id));
  const runnableIds = new Set(runnable.map(mutant => mutant.id));
  const sessionRunnable = runnable.filter(mutant => !(mutant.sharedWith && runnableIds.has(mutant.sharedWith)));
  const hasComparisons = prepared.some(mutant => mutant.parametric);
  if (!mutants.length && !hasComparisons) return report;
  if (!sessionRunnable.length && !hasComparisons) {
    const cachedDiagnostics = [];
    const mapped = mutants.map(({ targeted: _rule, fullDiagnostic: _fd, ...mutant }) => {
      const cached = cachedById.get(mutant.id);
      if (cached?.diagnostic) cachedDiagnostics.push(cached.diagnostic);
      if (!cached) return mutant;
      const { diagnostic: _diag, ...outcome } = cached;
      return { ...mutant, ...outcome, evidence: outcome.evidence ?? 'checkpoint' };
    });
    return { ...report, evaluation: 'evaluated', mutants: mapped, diagnostics: cachedDiagnostics };
  }

  return withCopy(root, async (workspace, temp) => {
    runnerPackage(workspace, 'playwright');
    for (const { file, output } of sources) {
      const path = inside(workspace, file);
      if (!readFileSync(path).equals(originals.get(file))) throw new Error(`Source changed during analysis: ${file}`);
      writeFileSync(path, output);
    }
    const manifest = resolve(temp, 'playwright-session.json');
    const output = resolve(temp, 'playwright-session.jsonl');
    const pidsFile = resolve(temp, 'pw-pids.jsonl');
    const extrasPath = resolve(temp, 'extras.json');
    const runTimeoutMs = options.timeout ? options.timeout * 1000 : 60_000;
    const baselineTimeoutMs = options['baseline-timeout'] ? options['baseline-timeout'] * 1000 : runTimeoutMs;
    const baseRunnableCount = sessionRunnable.filter(mutant => !mutant.parametric).length;
    let totalExpected = baseRunnableCount;

    writeFileSync(manifest, JSON.stringify({
      workspace,
      originalRoot: root,
      config: options.config,
      projects: options.project ?? [],
      tests: options.test ?? [],
      subjectFiles: sources.map(s => s.file),
      pidsFile,
      output,
      temporary: temp,
      awaitsExtras: typeof options.onBaselineRecorded === 'function',
      deterministic: Boolean(options.deterministic),
      isolatedTrials: options['isolated-trials'] === true,
      verifyTrials: options['verify-trials'] ?? 0,
      runTimeout: runTimeoutMs,
      baselineTimeout: baselineTimeoutMs,
      mutants: sessionRunnable.map(({ id, parametric, targeted, fullDiagnostic }) => ({
        id,
        ...(parametric ? { parametric } : {}),
        ...(targeted?.evidence ? { evidence: true } : {}),
        ...(targeted?.operator === 'idx0' ? { sequenceIndex: true } : {}),
        ...(targeted ? { effects: true } : {}),
        ...((fullDiagnostic?.kind === 'optional-chaining' && fullDiagnostic.wrapSafe) ||
            (fullDiagnostic?.kind === 'condition' && fullDiagnostic.pureBoolean && fullDiagnostic.truthMode === 1)
          ? { predictableFull: true }
          : {}),
      })),
    }));

    const limit = 90_000 + baselineTimeoutMs * (options.deterministic ? 2 : 1) + runTimeoutMs * Math.max(4, sessionRunnable.length * 2);
    const sessionAbort = new AbortController();
    const onAbort = () => sessionAbort.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) sessionAbort.abort();

    let finished = false;
    let baselineDispatched = false;
    let extrasReady = typeof options.onBaselineRecorded !== 'function';
    let extrasError = null;
    let lastDone = -1;
    const progressIntervalMs = options.progressIntervalMs ?? 5_000;
    const baselineStartedAt = Date.now();
    let baselineDoneAt = baselineStartedAt;
    let lastReportAt = baselineStartedAt;

    const pollSession = () => {
      if (finished) return;
      const now = Date.now();
      const current = readJsonlEvents(output);
      if (!baselineDispatched) {
        const baseEvent = current.find(event => event.baseline !== undefined);
        if (baseEvent) {
          baselineDispatched = true;
          baselineDoneAt = now;
          lastReportAt = now;
          if (baseEvent.baseline.status === 'passed') {
            if (typeof options.onBaselineRecorded === 'function') {
              Promise.resolve()
                .then(() => options.onBaselineRecorded(baseEvent))
                .then(list => list ?? [])
                .then(list => {
                  if (finished || sessionAbort.signal.aborted) return;
                  totalExpected = baseRunnableCount + list.length;
                  extrasReady = true;
                  lastReportAt = Date.now();
                  options.onProgress?.(`Baseline passed (${baseEvent.baseline.tests.length} tests). Running ${totalExpected} mutant(s)...`);
                  writeFileSync(extrasPath + '.part', JSON.stringify(list));
                  renameSync(extrasPath + '.part', extrasPath);
                })
                .catch(err => {
                  if (!finished && !sessionAbort.signal.aborted) {
                    extrasError = err;
                    sessionAbort.abort();
                  }
                });
            } else {
              options.onProgress?.(`Baseline passed (${baseEvent.baseline.tests.length} tests). Running ${totalExpected} mutant(s)...`);
            }
          }
        } else if (options.onProgress && now - lastReportAt >= progressIntervalMs) {
          lastReportAt = now;
          const elapsed = Math.max(1, Math.round((now - baselineStartedAt) / 1000));
          options.onProgress(`Running baseline tests... (${elapsed}s elapsed)`);
        }
      }
      if (options.onProgress && baselineDispatched && extrasReady && totalExpected > 0) {
        const sessionComplete = current.some(event => event.complete === true);
        const doneEvents = current.filter(event => event.id !== undefined || event.extra !== undefined).length;
        let latestProgress = 0;
        for (const event of current) {
          if (typeof event.progress?.completed === 'number' && event.progress.completed > latestProgress) {
            latestProgress = event.progress.completed;
          }
        }
        const provisionalCap = Math.max(0, totalExpected - 1);
        const done = Math.min(totalExpected, Math.max(doneEvents, Math.min(latestProgress, provisionalCap)));
        if (done > lastDone && done > 0) {
          lastDone = done;
          lastReportAt = now;
          options.onProgress(`Mutants: ${done}/${totalExpected} completed`);
        } else if (!sessionComplete && now - lastReportAt >= progressIntervalMs) {
          lastReportAt = now;
          const elapsed = Math.max(1, Math.round((now - baselineDoneAt) / 1000));
          options.onProgress(`Mutants: ${Math.max(0, done)}/${totalExpected} completed (${elapsed}s elapsed)`);
        }
      }
    };

    const pollTimer = setInterval(pollSession, 40);
    pollTimer.unref?.();
    options.onProgress?.('Running baseline tests...');

    let run;
    try {
      run = await supervisePlaywrightSession(workspace, temp, manifest, limit, sessionAbort.signal);
    } finally {
      clearInterval(pollTimer);
      finished = true;
      options.signal?.removeEventListener('abort', onAbort);
      terminateRecordedPids(pidsFile);
    }
    if (extrasError) throw extrasError;

    const events = readJsonlEvents(output);
    const unsupported = events.find(event => event.unsupportedSession)?.unsupportedSession;
    if (unsupported) {
      return { ...report, evaluation: 'unsupported_session', unsupportedReason: unsupported };
    }

    const error = events.findLast(event => event.error)?.error ?? run.error?.message ??
      (run.stderr?.trim() || `Playwright session stopped (exit ${run.status ?? run.signal})`);
    const baseEvent = events.find(event => event.baseline !== undefined);
    const baseline = baseEvent?.baseline ?? { status: 'error', output: error, errors: [error] };
    if (baseline.status !== 'passed') {
      return { ...report, evaluation: 'baseline_error', baseline };
    }

    const results = new Map(events.filter(event => event.id !== undefined).map(event => [event.id, event]));
    const completed = run.status === 0 && events.at(-1)?.complete === true;
    const observed = events.find(event => event.observed)?.observed ?? {};
    const places = new Map(prepared.map(mutant => [mutant.id, mutant]));
    const expressionsOf = (entries, own, plain) => {
      const seen = new Map();
      for (const { id, test } of entries ?? []) {
        const { location, original } = places.get(id) ?? {};
        if (!location || (location.file === own.file && own.start === location.start && location.end === own.end)) continue;
        if (plain && location.file === own.file && own.start <= location.start && location.end <= own.end) continue;
        seen.set(`${test}:${location.file}:${location.start}:${location.end}`, {
          ...(test === undefined ? {} : { test }),
          location: { file: location.file, line: location.line, column: location.column },
          expression: original,
        });
      }
      return [...seen.values()].slice(0, 3);
    };
    const withEffects = (gap, mutant) => {
      if (!gap || !mutant.effects) return gap;
      const plain = mutant.targeted?.operator === 'await' || mutant.targeted?.operator === 'cleanup';
      const nowRuns = expressionsOf(mutant.effects.now, mutant.location, plain);
      const noLongerRuns = expressionsOf(mutant.effects.gone, mutant.location, plain);
      return nowRuns.length || noLongerRuns.length ? { ...gap, effects: { nowRuns, noLongerRuns } } : gap;
    };

    const judged = mutants.map(mutant => {
      const cached = cachedById.get(mutant.id);
      if (cached) {
        const { diagnostic: _diag, ...outcome } = cached;
        return { ...mutant, ...outcome, id: mutant.id, evidence: outcome.evidence ?? 'checkpoint', _cachedDiagnostic: cached.diagnostic };
      }
      const rawResult = results.get(mutant.id) ?? (mutant.sharedWith ? results.get(mutant.sharedWith) : undefined);
      const result = rawResult ? { ...rawResult, id: mutant.id } : undefined;
      if (result?.status === 'ignored') return { ...mutant, ...result };
      if (result) {
        return { ...mutant, ...result, evidence: result.evidence ?? (result.status === 'unreached' ? 'coverage' : 'reexecuted') };
      }
      return mutant.status ? mutant : { ...mutant, status: 'unevaluated', statusReason: error || 'Playwright session ended early' };
    });

    const diagnostics = [];
    for (const mutant of judged) {
      const gap = mutant._cachedDiagnostic ??
        withEffects(targetedGap(mutant, observed[mutant.id]) ?? fullBuiltinGap(mutant, observed[mutant.id]), mutant);
      if (gap) diagnostics.push(gap);
      if (ckpt && !cachedById.has(mutant.id) && (results.has(mutant.id) || (mutant.sharedWith && results.has(mutant.sharedWith)))) {
        ckpt.record(checkpointKeyForTrial(mutant), mutant, gap ?? undefined);
      }
    }

    return {
      ...report,
      baseline: { status: 'passed', tests: baseline.tests.length },
      baselineSnapshot: baseline,
      baselineEvent: baseEvent,
      evaluation: completed ? 'evaluated' : 'incomplete',
      trials: events.find(event => event.trials)?.trials,
      extras: events.filter(event => event.extra !== undefined),
      mutants: judged.map(({ targeted: _rule, fullDiagnostic: _fd, effects: _effects, _cachedDiagnostic: _cd, ...mutant }) => mutant),
      diagnostics,
    };
  }, { exclude: options['copy-exclude'], onProgress: options.onProgress });
}
