import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { formatSessionFailure } from './cli-output.mjs';
import { fullBuiltinGap, targetedGap } from './targeted-gaps.mjs';
import { checkpointKeyForTrial } from './checkpoint.mjs';
import { candidateKey } from './shard.mjs';
import { selectScope } from './scope.mjs';
import { createTypeContext } from './type-equivalence.mjs';
import { canonicalPath, inside, runnerPackage, withCopy } from './vitest.mjs';

const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const session = fileURLToPath(new URL('./standard-session.mjs', import.meta.url));
const setupSource = new URL('./standard-setup.mjs', import.meta.url);
const runnerSource = new URL('./standard-runner.mjs', import.meta.url);

function readEvents(path) {
  if (!existsSync(path)) return [];
  const input = readFileSync(path, 'utf8');
  return input.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}

// The session runs beside its caller, which may block while it waits for other runs.
function superviseSession(workspace, temp, manifest, limit, signal) {
  const log = resolve(temp, 'mutation-session.stderr');
  const descriptor = openSync(log, 'w');
  return new Promise(settle => {
    const child = spawn(process.execPath, [supervisor, resolve(temp, 'mutation-session.pid'), String(limit), session, manifest], {
      cwd: workspace, stdio: ['ignore', 'ignore', descriptor], timeout: limit + 5_000, signal,
      env: {
        ...process.env, CI: 'true', VITEST: '1', NODE_ENV: 'test',
        VITE_CACHE_DIR: resolve(temp, 'vite-cache'),
        VITEST_FS_MODULE_CACHE: 'false',
        VITEST_FS_MODULE_CACHE_PATH: resolve(temp, 'vitest-fs-cache'),
      },
    });
    const finish = result => {
      closeSync(descriptor);
      const raw = readFileSync(log, 'utf8');
      settle({ ...result, stderr: raw.length > 4 * 1024 * 1024 ? raw.slice(-4 * 1024 * 1024) : raw });
    };
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', (status, stopped) => finish({ status, signal: stopped, error: failure }));
  });
}

export async function analyzeConventional(project, files, options) {
  const root = canonicalPath(project);
  const profile = options.mutators ?? 'targeted';
  const prefix = '.tmt-session-' + randomUUID();
  const targets = selectScope(root, files, options).map(subject => ({
    ...subject, input: readFileSync(inside(root, subject.file)),
  }));
  const originals = new Map(targets.map(({ file, input }) => [file, input]));
  const awaitsExtras = options.extras !== undefined;
  const typeContext = options['type-check']
    ? createTypeContext(root, targets.map(t => t.file), {
      tsconfig: options.tsconfig,
      onWarning: options.onTypeCheckWarning,
      silent: options['type-check'] === 'auto',
    })
    : null;
  const { sources, mutants: prepared } = prepareBuiltinSwitches(targets, {
    dialect: options.dialect,
    shifts: awaitsExtras,
    excludeRules: options['exclude-rule'],
    typeContext,
    targeted: true,
    ...(profile === 'targeted' ? { keep: targetedOrBoundary } : {}),
  });
  const report = {
    schemaVersion: 1, runner: 'vitest', mutators: profile,
    extraction: [], mutants: [], diagnostics: [], evaluation: 'no_sites',
    selection: { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] },
  };
  // Shift switches belong to the session and not to the report.
  const shardKeys = options.shardKeys;
  const inShard = mutant => !shardKeys || mutant.parametric || shardKeys.has(candidateKey({
    location: mutant.location,
    rule: profile === 'full' ? mutant.mutatorName : mutant.mutatorName,
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
  if (!mutants.length) return report;
  if (!sessionRunnable.length) {
    const cachedDiagnostics = [];
    const mapped = mutants.map(({ targeted: _rule, fullDiagnostic: _fd, ...mutant }) => {
      const cached = cachedById.get(mutant.id);
      if (cached?.diagnostic) cachedDiagnostics.push(cached.diagnostic);
      if (!cached) return mutant;
      const { diagnostic: _diag, ...outcome } = cached;
      return { ...mutant, ...outcome, evidence: outcome.evidence ?? 'checkpoint' };
    });
    return {
      ...report,
      evaluation: 'evaluated',
      mutants: mapped,
      diagnostics: cachedDiagnostics,
    };
  }

  // The expressions behind the switches an edit's tests newly reach or no longer reach, without the edit's own.
  const places = new Map(prepared.map(mutant => [mutant.id, mutant]));
  const expressionsOf = (entries, own, plain) => {
    const seen = new Map();
    for (const { id, test } of entries) {
      const { location, original } = places.get(id) ?? {};
      if (!location || (location.file === own.file && own.start === location.start && location.end === own.end)) continue;
      // An edit without a probe is plain text: what stands inside it is evaluated without a switch to show it.
      if (plain && location.file === own.file && own.start <= location.start && location.end <= own.end) continue;
      seen.set(`${test}:${location.file}:${location.start}:${location.end}`, { ...(test === undefined ? {} : { test }),
        location: { file: location.file, line: location.line, column: location.column }, expression: original });
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
  const mutantsBySessionId = new Map();
  for (const mutant of mutants) {
    if (cachedById.has(mutant.id)) continue;
    const sessionKey = mutant.sharedWith && runnableIds.has(mutant.sharedWith) ? mutant.sharedWith : mutant.id;
    let list = mutantsBySessionId.get(sessionKey);
    if (!list) mutantsBySessionId.set(sessionKey, list = []);
    list.push(mutant);
  }
  const persistedSessionIds = new Set();
  let liveObserved = null;
  let liveOutputPath = null;
  let liveSessionFinished = false;
  const syncLiveCheckpoint = currentEvents => {
    if (!ckpt || !currentEvents?.length) return;
    const base = currentEvents.find(event => event.baseline)?.baseline;
    if (base?.status !== 'passed') return;
    if (!liveObserved) {
      liveObserved = currentEvents.find(event => event.observed)?.observed ?? {};
    }
    for (const event of currentEvents) {
      if (event.id === undefined || persistedSessionIds.has(event.id)) continue;
      persistedSessionIds.add(event.id);
      const group = mutantsBySessionId.get(event.id);
      if (!group) continue;
      for (const mutant of group) {
        const result = { ...event, id: mutant.id };
        if (result.status === 'ignored') continue;
        const judgedMutant = {
          ...mutant,
          ...result,
          evidence: result.evidence ?? (result.status === 'unreached' ? 'coverage' : 'reexecuted'),
        };
        const gap = withEffects(
          targetedGap(judgedMutant, liveObserved[judgedMutant.id]) ?? fullBuiltinGap(judgedMutant, liveObserved[judgedMutant.id]),
          judgedMutant,
        );
        ckpt.record(checkpointKeyForTrial(judgedMutant), judgedMutant, gap ?? undefined);
      }
    }
  };

  return withCopy(root, async (workspace, temp) => {
    runnerPackage(workspace, 'vitest');
    for (const { file, output } of sources) {
      const path = inside(workspace, file);
      if (!readFileSync(path).equals(originals.get(file))) throw new Error(`Source changed during analysis: ${file}`);
      writeFileSync(path, output);
    }
    const setup = resolve(workspace, prefix + '-setup.mjs');
    const workerRunner = resolve(workspace, prefix + '-runner.mjs');
    copyFileSync(setupSource, setup);
    copyFileSync(runnerSource, workerRunner);
    const manifest = resolve(temp, 'mutation-session.json');
    const output = resolve(temp, 'mutation-session.jsonl');
    liveOutputPath = output;
    const runTimeoutMs = options.timeout ? options.timeout * 1000 : 60_000;
    const baselineTimeoutMs = options['baseline-timeout'] ? options['baseline-timeout'] * 1000 : runTimeoutMs;
    const totalRunnable = sessionRunnable.filter(mutant => !mutant.parametric).length;
    writeFileSync(manifest, JSON.stringify({
      workspace, setup, workerRunner, output, temporary: temp, awaitsExtras,
      mutants: sessionRunnable.map(({ id, parametric, targeted }) => ({
        id,
        ...(parametric ? { parametric } : {}),
        ...(targeted?.evidence ? { evidence: true } : {}),
        ...(targeted?.operator === 'idx0' ? { sequenceIndex: true } : {}),
        ...(targeted ? { effects: true } : {}),
      })),
      isolatedTrials: options['isolated-trials'] === true,
      concurrency: options.concurrency ?? Math.max(1, availableParallelism() - 1),
      verifyTrials: options['verify-trials'] ?? 0,
      runTimeout: runTimeoutMs,
      baselineTimeout: baselineTimeoutMs,
      ...(options['baseline-workers'] !== undefined ? { baselineWorkers: options['baseline-workers'] } : {}),
      ...(options.progressIntervalMs !== undefined ? { progressIntervalMs: options.progressIntervalMs } : {}),
      config: options.config === undefined ? undefined : inside(workspace, options.config),
      files: [...new Set((options.test ?? []).map(file => inside(workspace, file)))],
      ...(options.testSpecs?.length ? { selectedSpecs: options.testSpecs.map(({ project, file }) => ({ project, file: inside(workspace, file) })) } : {}),
    }));
    const limit = 75_000 + baselineTimeoutMs + (runTimeoutMs + 10_000) * sessionRunnable.length;
    // The focused analysis names its threshold edits once it has recorded the comparisons.
    // Guarded by `finished` so a late resolution never writes after `withCopy` deletes `temp`,
    // while a write error during a live session aborts the child and propagates to the caller.
    const extras = resolve(temp, 'extras.json');
    const sessionAbort = new AbortController();
    const onAbort = () => sessionAbort.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) sessionAbort.abort();
    let finished = false;
    let extrasError = null;
    if (awaitsExtras) {
      Promise.resolve(options.extras).then(list => list ?? [], () => []).then(list => {
        if (finished || sessionAbort.signal.aborted) return;
        try {
          writeFileSync(extras + '.part', JSON.stringify(list));
          renameSync(extras + '.part', extras);
        } catch (writeError) {
          if (!finished && !sessionAbort.signal.aborted) {
            extrasError = writeError;
            sessionAbort.abort();
          }
        }
      });
    }
    let progressTimer = null;
    if (options.onProgress || ckpt) {
      const progressIntervalMs = options.progressIntervalMs ?? 5_000;
      const pollIntervalMs = options.onProgress
        ? Math.min(1_000, Math.max(50, Math.floor(progressIntervalMs / 2)))
        : 200;
      const baselineStartedAt = Date.now();
      let baselineDoneAt = baselineStartedAt;
      let lastReportAt = baselineStartedAt;
      options.onProgress?.('Running baseline tests...');
      let baselineReported = false;
      let lastDone = -1;
      let lastStageKey = '';
      const formatStageSuffix = (stage, trialTimeoutSeconds, elapsed) => {
        const parts = [];
        if (stage === 'isolated') parts.push('isolated fallback');
        else if (stage === 'in-worker') parts.push('in-worker');
        else if (stage) parts.push(stage);
        if (typeof trialTimeoutSeconds === 'number' && trialTimeoutSeconds > 0) {
          parts.push(`${trialTimeoutSeconds}s trial deadline`);
        }
        if (elapsed !== undefined) parts.push(`${elapsed}s elapsed`);
        return parts.length ? ` (${parts.join(', ')})` : '';
      };
      const pollProgress = () => {
        const now = Date.now();
        const current = readEvents(output);
        // Flush any newly settled session verdicts to the durable checkpoint BEFORE emitting
        // isolated-fallback progress so an immediate SIGINT always sees settled warm results.
        syncLiveCheckpoint(current);
        if (!options.onProgress) return;
        if (!baselineReported) {
          const base = current.find(event => event.baseline)?.baseline;
          if (base?.status === 'passed') {
            baselineReported = true;
            baselineDoneAt = now;
            lastReportAt = now;
            options.onProgress(`Baseline passed (${base.tests} tests). Running ${totalRunnable} mutant(s)...`);
          } else if (now - lastReportAt >= progressIntervalMs) {
            lastReportAt = now;
            const elapsed = Math.max(1, Math.round((now - baselineStartedAt) / 1000));
            options.onProgress(`Running baseline tests... (${elapsed}s elapsed)`);
          }
        }
        if (baselineReported && totalRunnable > 0) {
          const sessionComplete = current.some(event => event.complete === true);
          const recordedDone = current.filter(event => event.id !== undefined).length;
          let latestProgress = 0;
          let latestStage;
          let latestTrialTimeoutSeconds;
          for (const event of current) {
            if (typeof event.progress?.completed === 'number' && event.progress.completed > latestProgress) {
              latestProgress = event.progress.completed;
            }
            if (event.progress?.stage !== undefined) {
              latestStage = event.progress.stage;
              latestTrialTimeoutSeconds = event.progress.trialTimeoutSeconds;
            }
          }
          const provisionalCap = Math.max(0, totalRunnable - 1);
          const done = Math.min(totalRunnable, Math.max(recordedDone, Math.min(latestProgress, provisionalCap)));
          const stageKey = `${latestStage ?? ''}:${latestTrialTimeoutSeconds ?? ''}`;
          if ((done > lastDone && done > 0) || (stageKey !== lastStageKey && latestStage === 'isolated')) {
            lastDone = Math.max(lastDone, done);
            lastStageKey = stageKey;
            lastReportAt = now;
            options.onProgress(`Mutants: ${Math.max(0, done)}/${totalRunnable} completed${formatStageSuffix(latestStage, latestTrialTimeoutSeconds)}`);
          } else if (!sessionComplete && now - lastReportAt >= progressIntervalMs) {
            lastReportAt = now;
            const elapsed = Math.max(1, Math.round((now - baselineDoneAt) / 1000));
            options.onProgress(`Mutants: ${Math.max(0, done)}/${totalRunnable} completed${formatStageSuffix(latestStage, latestTrialTimeoutSeconds, elapsed)}`);
          }
        }
      };
      progressTimer = setInterval(pollProgress, pollIntervalMs);
      progressTimer.unref?.();
    }
    let run;
    try {
      run = await superviseSession(workspace, temp, manifest, limit, sessionAbort.signal);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      finished = true;
      liveSessionFinished = true;
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (extrasError) throw extrasError;
    const events = readEvents(output);
    const completed = run.status === 0 && events.at(-1)?.complete === true;
    const sessionFailure = completed ? undefined : formatSessionFailure({ runnerLabel: 'Vitest', events, run });
    const baselineErrorText = events.findLast(event => event.error)?.error ?? run.error?.message ??
      (run.stderr?.trim() || `Vitest session stopped (exit ${run.status ?? run.signal})`);
    const baseline = events.find(event => event.baseline)?.baseline ?? { status: 'error', output: baselineErrorText };
    if (baseline.status !== 'passed') return { ...report, evaluation: 'baseline_error', baseline };
    const results = new Map(events.filter(event => event.id !== undefined).map(event => [event.id, event]));
    const observed = events.find(event => event.observed)?.observed ?? {};
    const judged = mutants.map(mutant => {
      const cached = cachedById.get(mutant.id);
      if (cached) {
        const { diagnostic: _diag, ...outcome } = cached;
        return { ...mutant, ...outcome, id: mutant.id, evidence: outcome.evidence ?? 'checkpoint', _cachedDiagnostic: cached.diagnostic };
      }
      const rawResult = results.get(mutant.id) ?? (mutant.sharedWith ? results.get(mutant.sharedWith) : undefined);
      const result = rawResult ? { ...rawResult, id: mutant.id } : undefined;
      // An edit the session left out was not run.
      if (result?.status === 'ignored') return { ...mutant, ...result };
      if (result) {
        return { ...mutant, ...result, evidence: result.evidence ?? (result.status === 'unreached' ? 'coverage' : 'reexecuted') };
      }
      return mutant.status ? mutant : { ...mutant, status: 'unevaluated', statusReason: sessionFailure?.reason || 'Mutation session ended early' };
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
      ...report, baseline, evaluation: completed ? 'evaluated' : 'incomplete', trials: events.find(event => event.trials)?.trials,
      ...(sessionFailure ? { sessionFailure } : {}),
      ...(awaitsExtras ? { extras: events.filter(event => event.extra !== undefined) } : {}),
      mutants: judged.map(({ targeted: _rule, fullDiagnostic: _fd, effects: _effects, _cachedDiagnostic: _cd, ...mutant }) => mutant),
      diagnostics,
    };
  }, {
    exclude: options['copy-exclude'],
    onProgress: options.onProgress,
    reuseCopy: options.reusableCopy,
    onBeforeCleanup: () => {
      if (!liveSessionFinished && liveOutputPath) syncLiveCheckpoint(readEvents(liveOutputPath));
    },
  });
}
