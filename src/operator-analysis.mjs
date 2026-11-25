import { readFileSync, realpathSync } from 'node:fs';
import { analyze, baselineRunSymbol, completeAnalysis, prepareAnalysis } from './analysis.mjs';
import { checkpointKeyForTrial, computeCampaignContext, openCheckpoint } from './checkpoint.mjs';
import { analyzeConventional } from './conventional.mjs';
import { suppressEnclosingDiagnostics } from './enclosing-suppression.mjs';
import { selectScope } from './scope.mjs';
import { computeShardSelection } from './shard.mjs';
import { inside } from './vitest.mjs';

const order = (a, b) => a.location.file.localeCompare(b.location.file) || a.location.start - b.location.start ||
  b.location.end - a.location.end;

function fromSession(mutant, profile) {
  const { source: _source, operatorSwap: _swap, ...reported } = mutant;
  if (profile === 'full') return reported;
  // A targeted edit replaces a whole expression, so the report keeps the text it replaced.
  return { site: reported.id, rule: reported.mutatorName, ...reported, id: undefined, mutatorName: undefined };
}

const definitive = new Set(['killed', 'survived', 'timeout', 'unreached']);

// How far a threshold or tightening trial moves the right side of its comparison, or nothing for other trials.
function shiftOf(trial) {
  if (trial.source || trial.rule === trial.site.rule) return undefined;
  const shift = trial.adjustment ?? (trial.rule === 'comparison-threshold/v1' ? Number(trial.replacement) - trial.threshold?.meta.threshold : undefined);
  return Number.isSafeInteger(shift) && shift !== 0 ? shift : undefined;
}
const shiftKey = (trial, shift) => `${trial.site.location.file}:${(trial.site.operatorEdit ?? trial.site.edit)[0]}:${shift}`;

// The trials the session can run through a comparison's shift switch, without the ones a recorded run already decided.
export function shiftTrials(prepared) {
  const listed = new Map();
  for (const [index, trial] of (prepared.trials ?? []).entries()) {
    const shift = shiftOf(trial);
    if (shift === undefined || prepared.skips?.has(index)) continue;
    listed.set(shiftKey(trial, shift), { file: trial.site.location.file, at: (trial.site.operatorEdit ?? trial.site.edit)[0], shift });
  }
  return [...listed.values()];
}

// A comparison boundary is the same edit in both parts, so the session's run of it answers the focused trial.
// A threshold or tightening trial is answered by the extra trial the session ran for the same comparison and shift.
function sessionVerdicts(session, extras = []) {
  const shifted = new Map(extras.map((extra, index) => [`${extra.file}:${extra.at}:${extra.shift}`,
    (session.extras ?? []).find(result => result.extra === index)]));
  const swaps = new Map(session.mutants.filter(mutant => mutant.operatorSwap && definitive.has(mutant.status))
    .map(mutant => [`${mutant.location.file}:${mutant.operatorSwap.join(':')}`, mutant]));
  return trial => {
    const shift = shiftOf(trial);
    const mutant = shift !== undefined ? shifted.get(shiftKey(trial, shift))
      : trial.rule !== trial.site.rule || trial.source ? undefined
        : swaps.get(`${trial.site.location.file}:${trial.edit[0]}:${trial.replacement}`);
    if (mutant && !definitive.has(mutant.status)) return undefined;
    // The focused analysis decides between unreached and survived from its own recorded comparisons.
    return mutant && { status: mutant.status === 'unreached' ? 'survived' : mutant.status, tests: mutant.tests };
  };
}

function carryBaseline(target, source) {
  if (source?.[baselineRunSymbol]) {
    Object.defineProperty(target, baselineRunSymbol, { value: source[baselineRunSymbol], enumerable: false });
  }
  return target;
}

// Starts the session, prepares the focused analysis while it runs, and waits for both.
// `ended` holds the focused report when that analysis finished in its preparation.
async function besideSession(project, files, options, run, profile, stopsSession) {
  const stop = new AbortController();
  let listExtras;
  const extras = new Promise(resolveList => { listExtras = resolveList; });
  const started = run.analyzeConventional(project, files, {
    mutators: profile, lines: options.lines, since: options.since, config: options.config, test: options.test,
    'copy-exclude': options['copy-exclude'], dialect: options.dialect, 'isolated-trials': options['isolated-trials'],
    concurrency: options.concurrency, 'verify-trials': options['verify-trials'], timeout: options.timeout, signal: stop.signal, extras,
    ...(options.shardKeys ? { shardKeys: options.shardKeys } : {}),
    ...(options.checkpointStore ? { checkpointStore: options.checkpointStore } : {}),
    ...(options['exclude-rule'] ? { 'exclude-rule': options['exclude-rule'] } : {}),
    ...(options['type-check'] ? { 'type-check': options['type-check'] } : {}),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
    ...(options.onTypeCheckWarning ? { onTypeCheckWarning: options.onTypeCheckWarning } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options['baseline-timeout'] !== undefined ? { 'baseline-timeout': options['baseline-timeout'] } : {}),
    ...(options['baseline-workers'] !== undefined ? { 'baseline-workers': options['baseline-workers'] } : {}),
    ...(options.testSpecs?.length ? { testSpecs: options.testSpecs } : {}),
    ...(options.reusableCopy ? { reusableCopy: options.reusableCopy } : {}),
    ...(options.progressIntervalMs !== undefined ? { progressIntervalMs: options.progressIntervalMs } : {}),
  }).then(report => ({ report }), error => ({ error }));
  let prepared;
  try {
    prepared = run.prepareAnalysis(project, files, { ...options, mutators: undefined, traceIsBaseline: true });
  } catch (error) {
    listExtras([]);
    stop.abort();
    await started;
    throw error;
  }
  // Without planned trials the focused analysis ended in its preparation.
  const ended = prepared.trials ? null : prepared.report;
  const listed = shiftTrials(prepared);
  listExtras(listed);
  if (ended && stopsSession(ended)) {
    stop.abort();
    await started;
    return { prepared, ended, stopped: true, extras: listed };
  }
  return { prepared, ended, extras: listed, ...await started };
}

// Vitest (without --audit): built-in mutations run in one switched session with per-test coverage while
// comparison tracing prepares boundaries and thresholds, and the session's verdicts answer shared edits.
// Playwright, --audit, and Vitest setups the session cannot drive rewrite the source for each mutation instead.
export async function analyzeOperators(project, files, options, run = { analyze, prepareAnalysis, completeAnalysis, analyzeConventional }) {
  const profile = options.mutators ?? 'targeted';
  const shardSelection = options.shard ? computeShardSelection(project, files, { ...options, mutators: profile }) : null;
  let checkpointStore = null;
  if (options.checkpoint) {
    const root = realpathSync(project);
    const targets = selectScope(root, files, options).map(subject => ({
      ...subject, input: readFileSync(inside(root, subject.file)),
    }));
    const context = computeCampaignContext(targets, { ...options, mutators: profile }, root);
    checkpointStore = openCheckpoint(options.checkpoint, context, { mutators: profile });
  }
  const runOptions = {
    ...options,
    ...(shardSelection ? { shardKeys: shardSelection.keys } : {}),
    ...(checkpointStore ? { checkpointStore } : {}),
  };
  const finalize = report => {
    let out = shardSelection?.meta ? { ...report, shard: shardSelection.meta } : report;
    if (checkpointStore) {
      if (out.evaluation === 'evaluated') checkpointStore.complete();
      out = { ...out, checkpoint: checkpointStore.summary() };
    }
    return out;
  };
  const rewriting = () => {
    const out = run.analyze(project, files, { ...runOptions, mutators: profile });
    return carryBaseline(finalize({ ...out, mutators: profile, operatorExecution: 'source-rewrite' }), out);
  };
  if (runOptions.runner === 'playwright' || runOptions.audit) return rewriting();
  const { prepared, ended, stopped, extras, report: session, error } = await besideSession(project, files, runOptions, run, profile,
    report => report.evaluation === 'baseline_error' || report.extraction.some(file => file.path === 'diagnostic'));
  if (stopped) return carryBaseline(finalize({ ...ended, mutators: profile }), ended);
  if (error) throw error;
  if (session.evaluation === 'baseline_error') return rewriting();
  const baseSettled = sessionVerdicts(session, extras);
  const settled = checkpointStore
    ? trial => checkpointStore.get(checkpointKeyForTrial(trial)) ?? baseSettled(trial)
    : baseSettled;
  const completed = ended ?? run.completeAnalysis(prepared, settled);
  if (checkpointStore) {
    for (const mutant of completed.mutants ?? []) {
      checkpointStore.record(checkpointKeyForTrial(mutant), mutant);
    }
  }
  const focused = carryBaseline({ ...completed, mutators: profile }, completed);
  if (session.evaluation === 'no_sites') return carryBaseline(finalize({ ...focused, operatorExecution: 'session' }), focused);
  // A comparison boundary appears in both parts. The focused result carries the missing input, so it is the one kept.
  const boundaries = new Set(focused.mutants.map(mutant => `${mutant.location.file}:${mutant.edit[0]}:${mutant.replacement}`));
  const added = session.mutants.filter(mutant => !(mutant.operatorSwap &&
    boundaries.has(`${mutant.location.file}:${mutant.operatorSwap.join(':')}`)));
  return carryBaseline(finalize({
    ...focused,
    operatorExecution: 'session',
    trials: session.trials,
    baseline: focused.baseline ?? session.baseline,
    evaluation: session.evaluation === 'incomplete' || focused.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: [...focused.mutants, ...added.map(mutant => fromSession(mutant, profile))].sort(order),
    diagnostics: suppressEnclosingDiagnostics([...focused.diagnostics, ...(session.diagnostics ?? [])]),
  }), focused);
}
