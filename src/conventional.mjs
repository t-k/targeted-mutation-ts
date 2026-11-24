import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { targetedGap } from './targeted-gaps.mjs';
import { checkpointKeyForTrial } from './checkpoint.mjs';
import { candidateKey } from './shard.mjs';
import { selectScope } from './scope.mjs';
import { inside, runnerPackage, withCopy } from './vitest.mjs';

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
      env: { ...process.env, CI: 'true', VITEST: '1', NODE_ENV: 'test' },
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

export async function analyzeConventional(project, files, options) {
  const root = realpathSync(project);
  const profile = options.mutators ?? 'targeted';
  const prefix = '.tmt-session-' + randomUUID();
  const targets = selectScope(root, files, options).map(subject => ({
    ...subject, input: readFileSync(inside(root, subject.file)),
  }));
  const originals = new Map(targets.map(({ file, input }) => [file, input]));
  const awaitsExtras = options.extras !== undefined;
  const { sources, mutants: prepared } = prepareBuiltinSwitches(targets, {
    dialect: options.dialect,
    shifts: awaitsExtras,
    ...(profile === 'targeted' ? { keep: targetedOrBoundary, targeted: true } : {}),
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
  if (!mutants.length) return report;
  if (!runnable.length) {
    return {
      ...report,
      evaluation: 'evaluated',
      mutants: mutants.map(({ targeted: _rule, ...mutant }) => {
        const cached = cachedById.get(mutant.id);
        return cached ? { ...mutant, ...cached, evidence: cached.evidence ?? 'checkpoint' } : mutant;
      }),
    };
  }

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
    writeFileSync(manifest, JSON.stringify({
      workspace, setup, workerRunner, output, temporary: temp, awaitsExtras,
      mutants: runnable.map(({ id, parametric, targeted }) => ({
        id,
        ...(parametric ? { parametric } : {}),
        ...(targeted?.evidence ? { evidence: true } : {}),
        ...(targeted?.operator === 'idx0' ? { sequenceIndex: true } : {}),
        ...(targeted ? { effects: true } : {}),
      })),
      isolatedTrials: options['isolated-trials'] === true,
      concurrency: options.concurrency ?? Math.max(1, availableParallelism() - 1),
      verifyTrials: options['verify-trials'] ?? 0,
      ...(options.timeout ? { runTimeout: options.timeout * 1000 } : {}),
      config: options.config === undefined ? undefined : inside(workspace, options.config),
      files: [...new Set((options.test ?? []).map(file => inside(workspace, file)))],
    }));
    const limit = 75_000 + (options.timeout ? options.timeout * 1000 : 60_000) * runnable.length;
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
    let run;
    try {
      run = await superviseSession(workspace, temp, manifest, limit, sessionAbort.signal);
    } finally {
      finished = true;
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (extrasError) throw extrasError;
    const events = readEvents(output);
    const error = events.findLast(event => event.error)?.error ?? run.error?.message ??
      (run.stderr?.trim() || `Vitest session stopped (exit ${run.status ?? run.signal})`);
    const baseline = events.find(event => event.baseline)?.baseline ?? { status: 'error', output: error };
    if (baseline.status !== 'passed') return { ...report, evaluation: 'baseline_error', baseline };
    const results = new Map(events.filter(event => event.id !== undefined).map(event => [event.id, event]));
    const completed = run.status === 0 && events.at(-1)?.complete === true;
    const observed = events.find(event => event.observed)?.observed ?? {};
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
    const judged = mutants.map(mutant => {
      const cached = cachedById.get(mutant.id);
      if (cached) return { ...mutant, ...cached, evidence: cached.evidence ?? 'checkpoint' };
      const result = results.get(mutant.id);
      // An edit the session left out was not run.
      if (result?.status === 'ignored') return { ...mutant, ...result };
      if (result) {
        const entry = { ...mutant, ...result, evidence: result.evidence ?? (result.status === 'unreached' ? 'coverage' : 'reexecuted') };
        if (ckpt) ckpt.record(checkpointKeyForTrial(mutant), entry);
        return entry;
      }
      return mutant.status ? mutant : { ...mutant, status: 'unevaluated', statusReason: error || 'Mutation session ended early' };
    });
    return {
      ...report, baseline, evaluation: completed ? 'evaluated' : 'incomplete', trials: events.find(event => event.trials)?.trials,
      ...(awaitsExtras ? { extras: events.filter(event => event.extra !== undefined) } : {}),
      mutants: judged.map(({ targeted: _rule, effects: _effects, ...mutant }) => mutant),
      diagnostics: judged.flatMap(mutant => withEffects(targetedGap(mutant, observed[mutant.id]), mutant) ?? []),
    };
  }, { exclude: options['copy-exclude'] });
}
