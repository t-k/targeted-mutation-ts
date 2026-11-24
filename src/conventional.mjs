import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, renameSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byteOffsets } from './extract.mjs';
import { collectComparisons } from './analysis.mjs';
import { boundarySwap, prepareBuiltinSwitches, targetedOrBoundary } from './builtin-switches.mjs';
import { targetedGap } from './targeted-gaps.mjs';
import { prepareOperatorSwitches } from './operator-switches.mjs';
import { selectScope } from './scope.mjs';
import { inside, resolveOptional, runnerPackage, withCopy } from './vitest.mjs';

const logger = { debug() {}, info() {}, warn() {}, isDebugEnabled: () => false };
const supervisor = fileURLToPath(new URL('./runner-process.mjs', import.meta.url));
const session = fileURLToPath(new URL('./standard-session.mjs', import.meta.url));
const setupSource = new URL('./standard-setup.mjs', import.meta.url);
const runnerSource = new URL('./standard-runner.mjs', import.meta.url);
const compatibilityPackage = '@stryker-mutator/instrumenter';
const compatibilityVersion = '10.1.1';
const toolRequire = createRequire(import.meta.url);

function compatibilityEntry(root) {
  const id = compatibilityPackage + '/package.json';
  const projectRequire = root === undefined ? null : createRequire(resolve(root, 'package.json'));
  const projectManifest = projectRequire && resolveOptional(projectRequire, id);
  const manifest = projectManifest ?? resolveOptional(toolRequire, id);
  const version = manifest && JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (version !== compatibilityVersion) {
    const found = version ? ` (found ${version})` : '';
    throw new Error(`Standard and all profiles require ${compatibilityPackage}@${compatibilityVersion}${found}. Install it in the project or its workspace.`);
  }
  return (projectManifest ? projectRequire : toolRequire).resolve(compatibilityPackage);
}

function lineOffsets(text) {
  const starts = [0];
  for (const newline of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) starts.push(newline.index + newline[0].length);
  return starts;
}

function mutationRanges(starts, selected) {
  const ranges = [];
  for (let line = 0; line < starts.length; line++) {
    if (!selected(line + 1)) continue;
    const previous = ranges.at(-1);
    if (previous?.end.line === line) previous.end.line++;
    else ranges.push({ start: { line, column: 0 }, end: { line: line + 1, column: 0 } });
  }
  return ranges.length === 1 && ranges[0].start.line === 0 && ranges[0].end.line === starts.length ? true : ranges;
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  const input = readFileSync(path, 'utf8');
  return input.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}

export async function prepareConventional(subjects, print, entry = compatibilityEntry()) {
  const inputs = new Map();
  const sources = [];
  for (const { file, input, selected } of subjects) {
    if (!isUtf8(input)) throw new Error(`Invalid UTF-8 in ${file}`);
    const content = input.toString();
    const starts = lineOffsets(content);
    const mutate = mutationRanges(starts, selected);
    if (Array.isArray(mutate) && mutate.length === 0) continue;
    inputs.set(file, { input, starts, bytes: byteOffsets(content) });
    sources.push({ name: file, content, mutate });
  }

  const printSource = print ? source => print(source, inputs.get(source.originFileName)) : undefined;
  const { Instrumenter } = await import(pathToFileURL(entry).href);
  const instrumented = await new Instrumenter(logger, undefined, printSource).instrument(sources, {
    excludedMutations: [], ignorers: [], plugins: null,
  });
  const mutants = instrumented.mutants.map(mutant => {
    const { input, starts, bytes } = inputs.get(mutant.fileName);
    const { start, end } = mutant.location;
    const edit = [bytes[starts[start.line] + start.column], bytes[starts[end.line] + end.column]];
    if (edit.some(offset => offset === undefined) || edit[0] > edit[1]) {
      throw new Error(`Invalid mutation span in ${mutant.fileName}`);
    }
    return {
      id: mutant.id, mutatorName: mutant.mutatorName,
      location: { file: mutant.fileName, line: start.line + 1, column: start.column + 1, start: edit[0], end: edit[1] },
      edit, original: input.subarray(...edit).toString(), replacement: mutant.replacement,
      ...(mutant.status === 'Ignored' ? { status: 'ignored', statusReason: mutant.statusReason } : {}),
    };
  });
  return { sources: instrumented.files.map(({ name, content }) => ({ file: name, output: content })), mutants };
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
  const combined = options.mutators === 'all';
  // The built-in switches use the same session and need no instrumenter package.
  // `boundaries` is the internal profile that runs only the swaps the focused analysis asks about.
  const builtIn = ['operators', 'full', 'boundaries', 'targeted'].includes(options.mutators);
  const entry = builtIn ? null : compatibilityEntry(root);
  const prefix = '.tmt-session-' + randomUUID();
  const runtime = prefix + '-focus.mjs';
  const targets = selectScope(root, files, options).map(subject => ({
    ...subject, input: readFileSync(inside(root, subject.file)),
  }));
  const originals = new Map(targets.map(({ file, input }) => [file, input]));
  const preparedFocused = [];
  const comparison = combined ? collectComparisons(root, files, options) : null;
  const byFile = new Map(comparison?.subjects.map(({ file, sites }) => [file, sites]));
  const focus = combined ? await import('./focused-switch.mjs') : null;
  const require = combined ? createRequire(entry) : null;
  const babel = require && { types: require('@babel/core').types, generate: require('@babel/generator').generate };
  const prepareBuiltIn = options.mutators === 'operators' ? prepareOperatorSwitches : prepareBuiltinSwitches;
  const awaitsExtras = builtIn && options.mutators !== 'operators' && options.extras !== undefined;
  const { sources, mutants: prepared } = builtIn ? prepareBuiltIn(targets, { dialect: options.dialect, shifts: awaitsExtras,
    ...(options.mutators === 'boundaries' ? { keep: boundarySwap } : options.mutators === 'targeted' ? { keep: targetedOrBoundary, targeted: true } : {}) }) : await prepareConventional(targets, focus &&
    ((source, { starts, bytes }) => focus.printWithFocusedSwitches(
      source, starts, bytes, byFile.get(source.originFileName) ?? [], runtime, preparedFocused, babel,
    )), entry);
  const report = {
    schemaVersion: 1, runner: 'vitest', mutators: options.mutators,
    extraction: comparison?.extraction ?? [], mutants: [], diagnostics: [], evaluation: 'no_sites',
    selection: { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] },
  };
  // Shift switches belong to the session and not to the report.
  const mutants = prepared.filter(mutant => !mutant.parametric);
  const runnable = prepared.filter(mutant => mutant.status === undefined);
  const focused = focus?.eligibleFocusedSites(runnable, preparedFocused) ?? [];
  if (!mutants.length && !focused.length) return report;
  if (!runnable.length && !focused.length) return { ...report, evaluation: 'evaluated', mutants: mutants.map(({ targeted: _rule, ...mutant }) => mutant) };

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
    if (preparedFocused.length) copyFileSync(new URL('./focused-switch-runtime.mjs', import.meta.url), resolve(workspace, runtime));
    const manifest = resolve(temp, 'mutation-session.json');
    const output = resolve(temp, 'mutation-session.jsonl');
    writeFileSync(manifest, JSON.stringify({
      workspace, setup, workerRunner, output, temporary: temp, awaitsExtras,
      mutants: runnable.map(({ id, parametric, targeted }) => ({ id, ...(parametric ? { parametric } : {}), ...(targeted?.evidence ? { evidence: true } : {}) })),
      focused: focused.map(({ id }) => ({ id })), isolatedTrials: options['isolated-trials'] === true,
      concurrency: options.concurrency ?? Math.max(1, availableParallelism() - 1), verifyTrials: options['verify-trials'] ?? 0,
      ...(options.timeout ? { runTimeout: options.timeout * 1000 } : {}),
      replay: options.deterministic ? focus.comparisonReplays(runnable, focused, originals) : [],
      config: options.config === undefined ? undefined : inside(workspace, options.config),
      files: [...new Set((options.test ?? []).map(file => inside(workspace, file)))],
    }));
    const limit = 75_000 + (options.timeout ? options.timeout * 1000 : 60_000) * (runnable.length + focused.length);
    // The focused analysis names its threshold edits once it has recorded the comparisons. The session waits for the list.
    const extras = resolve(temp, 'extras.json');
    if (awaitsExtras) {
      Promise.resolve(options.extras).then(list => list ?? [], () => []).then(list => {
        // Written beside its final name and moved, so the session never reads half a list.
        writeFileSync(extras + '.part', JSON.stringify(list));
        renameSync(extras + '.part', extras);
      });
    }
    const run = await superviseSession(workspace, temp, manifest, limit, options.signal);
    const events = readEvents(output);
    const error = events.findLast(event => event.error)?.error ?? run.error?.message ??
      (run.stderr?.trim() || `Vitest session stopped (exit ${run.status ?? run.signal})`);
    const baseline = events.find(event => event.baseline)?.baseline ?? { status: 'error', output: error };
    if (baseline.status !== 'passed') return { ...report, evaluation: 'baseline_error', baseline };
    const results = new Map(events.filter(event => event.id !== undefined).map(event => [event.id, event]));
    const completed = run.status === 0 && events.at(-1)?.complete === true;
    const trace = events.find(event => event.focusedTrace)?.focusedTrace;
    const targeted = focused.map(entry => focus.focusedResult(entry, trace, results, originals)).filter(Boolean);
    const observed = events.find(event => event.observed)?.observed ?? {};
    const judged = mutants.map(mutant => {
      const result = results.get(mutant.id);
      if (result) return { ...mutant, ...result, evidence: result.evidence ?? (result.status === 'unreached' ? 'coverage' : 'reexecuted') };
      return mutant.status ? mutant : { ...mutant, status: 'unevaluated', statusReason: error || 'Mutation session ended early' };
    });
    return {
      ...report, baseline, evaluation: completed ? 'evaluated' : 'incomplete', trials: events.find(event => event.trials)?.trials,
      ...(awaitsExtras ? { extras: events.filter(event => event.extra !== undefined) } : {}),
      mutants: [...judged.map(({ targeted: _rule, ...mutant }) => mutant), ...targeted.map(entry => entry.mutant)],
      diagnostics: [...judged.flatMap(mutant => targetedGap(mutant, observed[mutant.id]) ?? []),
        ...targeted.flatMap(entry => entry.diagnosis ? [entry.diagnosis] : [])],
    };
  }, { exclude: options['copy-exclude'] });
}
