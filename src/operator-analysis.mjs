import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyze, analyzeNodeAsync, baselineRunSymbol, completeAnalysis, prepareAnalysis, prepareAnalysisFromTrace, verdict } from './analysis.mjs';
import { checkpointKeyForTrial, computeCampaignContext, openCheckpoint } from './checkpoint.mjs';
import { analyzeConventional } from './conventional.mjs';
import { suppressEnclosingDiagnostics } from './enclosing-suppression.mjs';
import { comparisonRecordsToTrace } from './playwright-bridge.mjs';
import { analyzePlaywrightSession } from './playwright.mjs';
import { selectScope } from './scope.mjs';
import { computeShardSelection } from './shard.mjs';
import { canonicalPath, inside } from './vitest.mjs';

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
    return mutant && {
      status: mutant.status === 'unreached' ? 'survived' : mutant.status,
      tests: mutant.tests,
      ...(mutant.reachedTests?.length ? { reachedTests: mutant.reachedTests } : {}),
      ...(mutant.statusReason ? { statusReason: mutant.statusReason } : {}),
    };
  };
}

function carryBaseline(target, source) {
  if (source?.[baselineRunSymbol]) {
    Object.defineProperty(target, baselineRunSymbol, { value: source[baselineRunSymbol], enumerable: false, configurable: true });
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

const RELATIONAL_COMPLEMENT = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' };

function relationalComplementDiagnostics(prepared, profile, sessionMutants, existingDiagnostics) {
  if (profile !== 'full' || !prepared?.subjects?.length || !Array.isArray(prepared?.trace)) return [];
  const passedTestsByIdentity = new Map(
    (prepared.baseline?.tests ?? [])
      .filter(test => test.status === 'passed')
      .map(test => [JSON.stringify([test.project ?? '', test.file ?? '', test.id ?? test.name ?? '']), test]),
  );
  const siteBySwapKey = new Map();
  for (const subject of prepared.subjects) {
    for (const site of subject.sites ?? []) {
      const comp = RELATIONAL_COMPLEMENT[site.operator];
      if (!comp || site.unobserved) continue;
      const opAt = (site.operatorEdit ?? site.edit)[0];
      siteBySwapKey.set(`${subject.file}:${opAt}:${comp}`, site);
    }
  }
  if (!siteBySwapKey.size) return [];
  const rowsBySite = new Map();
  for (const row of prepared.trace) {
    if (typeof row?.site === 'string' && row.identity && Array.isArray(row.operands) &&
        row.operands.length === 2 && row.operands.every(Number.isSafeInteger)) {
      let list = rowsBySite.get(row.site);
      if (!list) rowsBySite.set(row.site, list = []);
      list.push(row);
    }
  }
  const existingSites = new Set(existingDiagnostics.map(gap => gap.site));
  const out = [];
  for (const mutant of sessionMutants ?? []) {
    if (mutant.status !== 'survived' || mutant.mutatorName !== 'EqualityOperator' || !mutant.operatorSwap || existingSites.has(mutant.id)) {
      continue;
    }
    const site = siteBySwapKey.get(`${mutant.location.file}:${mutant.operatorSwap[0]}:${mutant.operatorSwap[1]}`);
    if (!site) continue;
    const rows = rowsBySite.get(site.id);
    if (!rows?.length) continue;
    const testsMap = new Map();
    let examplePair = null;
    for (const row of rows) {
      const idKey = JSON.stringify([row.identity.project ?? '', row.identity.file ?? '', row.identity.id ?? row.identity.name ?? '']);
      const matchedTest = passedTestsByIdentity.get(idKey);
      if (!matchedTest) continue;
      if (!examplePair) examplePair = row.operands;
      if (!testsMap.has(idKey)) {
        testsMap.set(idKey, {
          ...(matchedTest.id !== undefined ? { id: matchedTest.id } : {}),
          project: matchedTest.project,
          file: matchedTest.file,
          name: matchedTest.name,
        });
      }
    }
    if (!testsMap.size) continue;
    existingSites.add(mutant.id);
    out.push({
      kind: 'ASSERTION GAP',
      site: mutant.id,
      location: mutant.location,
      rule: mutant.mutatorName,
      operator: site.operator,
      tests: [...testsMap.values()],
      ...(examplePair ? { example: { operands: [String(examplePair[0]), String(examplePair[1])] } } : {}),
      mutations: [{
        rule: mutant.mutatorName,
        edit: mutant.edit,
        replacement: mutant.replacement,
        evidence: mutant.evidence ?? 'reexecuted',
        ...(mutant.original !== undefined ? { original: mutant.original } : {}),
      }],
    });
  }
  return out;
}

function attachPlaywrightSpecWitnesses(prepared, diagnostics, allMutants) {
  const pwSpecs = prepared?.specification?.playwright;
  if (!Array.isArray(pwSpecs) || !pwSpecs.length || !prepared?.attempt) return { diagnostics, plainBaseline: null };

  let plainBaseline = null;
  const ensurePlainBaseline = () => {
    if (!plainBaseline) plainBaseline = prepared.attempt({ isBaseline: true });
    return plainBaseline;
  };

  // Ensure surviving mutants matched by `specification.playwright` that lacked an operand-level diagnostic
  // (for example non-integer comparisons) still receive a `SURVIVED` witness diagnostic entry.
  const diagnosedSites = new Set(diagnostics.map(gap => gap.site));
  const seededDiagnostics = [...diagnostics];
  for (const mutant of allMutants) {
    const key = mutant.site ?? mutant.id;
    if (mutant.status !== 'survived' || diagnosedSites.has(key)) continue;
    const rule = mutant.rule ?? mutant.mutatorName;
    const hasSpec = pwSpecs.some(entry =>
      entry.file === mutant.location?.file &&
      (entry.line === undefined || entry.line === mutant.location?.line) &&
      entry.rule === rule &&
      (entry.operator === undefined || mutant.operator === undefined || entry.operator === mutant.operator));
    if (hasSpec) {
      diagnosedSites.add(key);
      seededDiagnostics.push({
        kind: 'SURVIVED',
        site: key,
        location: mutant.location,
        rule,
        ...(mutant.operator ? { operator: mutant.operator } : {}),
        mutations: [{ rule, edit: mutant.edit, replacement: mutant.replacement, evidence: mutant.evidence ?? 'reexecuted' }],
      });
    }
  }

  const out = seededDiagnostics.map(gap => {
    const mutant = allMutants.find(m => (m.site ?? m.id) === gap.site);
    const rule = gap.rule ?? mutant?.rule ?? mutant?.mutatorName ?? gap.mutations?.[0]?.rule;
    const operator = gap.operator ?? mutant?.operator;
    const match = pwSpecs.find(entry => {
      if (entry.file !== gap.location?.file) return false;
      if (entry.line !== undefined && entry.line !== gap.location?.line) return false;
      if (entry.rule === rule) {
        return entry.operator === undefined || operator === undefined || entry.operator === operator;
      }
      return entry.rule === 'jsx-disabled-drop-left/v1' &&
        rule === 'ignored-operand/v1' &&
        entry.operator === '||' &&
        String(gap.mutations?.[0]?.replacement ?? mutant?.replacement ?? '').startsWith('(');
    });
    if (!match?.witness || typeof match.requirement !== 'string') return gap;

    const base = ensurePlainBaseline();
    const passedTest = base.tests?.find(t => t.status === 'passed');
    if (base.status !== 'passed' || !passedTest) {
      return {
        ...gap,
        requirement: match.requirement,
        suggestedTestFile: match.witness,
        verification: { baselineWithWitness: 'unconfirmed', rewriteWithWitness: 'unconfirmed' },
      };
    }

    const witness = {
      content: match.witness,
      name: 'tmt-witness-' + randomUUID() + '.spec.ts',
      directory: match.witnessDirectory ?? dirname(passedTest.file),
    };
    const edit = gap.mutations?.[0]?.edit ?? mutant?.edit;
    const replacement = gap.mutations?.[0]?.replacement ?? mutant?.replacement;
    const sourceEdit = gap.mutations?.[0]?.source ?? mutant?.source;
    const trial = {
      site: { location: gap.location },
      edit,
      replacement,
      ...(sourceEdit ? { source: sourceEdit } : {}),
    };
    const origRun = prepared.attempt({ witness });
    const mutRun = prepared.attempt({ witness, trial });
    const isWitness = t => t.file === origRun.witnessFile && (!origRun.witnessName || t.name === origRun.witnessName);
    const checkWitness = run => {
      const wit = run.tests?.filter(isWitness);
      const orig = run.tests?.filter(t => !isWitness(t));
      if (!wit?.length || orig.some(t => !['passed', 'skipped'].includes(t.status)) ||
          verdict({ status: 'passed', tests: orig }, base) !== 'survived') return [];
      return wit;
    };
    const passed = checkWitness(origRun);
    const failed = checkWitness(mutRun);
    const baselineAccepted = origRun.status === 'passed' && passed.length > 0 && passed.every(t => t.status === 'passed');
    const matching = baselineAccepted && mutRun.status === 'failed' && failed.length === passed.length &&
      failed.some(t => t.status === 'failed') &&
      verdict({ status: 'failed', tests: failed }, { tests: passed }) === 'killed';
    return {
      ...gap,
      requirement: match.requirement,
      suggestedTestFile: match.witness,
      verification: {
        baselineWithWitness: baselineAccepted ? 'passed' : 'unconfirmed',
        rewriteWithWitness: matching ? 'failed' : 'unconfirmed',
      },
    };
  });
  return { diagnostics: out, plainBaseline };
}

async function runPlaywrightTargetedSession(project, files, runOptions, run, profile, finalize) {
  const prepareFromTraceFn = run.prepareAnalysisFromTrace ?? prepareAnalysisFromTrace;
  const completeFn = run.completeAnalysis ?? completeAnalysis;
  const sessionFn = run.analyzePlaywrightSession ?? analyzePlaywrightSession;

  let prepared = null;
  let extras = [];

  const session = await sessionFn(project, files, {
    ...runOptions,
    mutators: profile,
    onBaselineRecorded(baseEvent) {
      const passedMap = new Map(baseEvent.baseline.tests.filter(t => t.status === 'passed').map(t => [t.id, t]));
      const probePrep = prepareFromTraceFn(project, files, runOptions, {
        baseline: baseEvent.baseline,
        trace: [],
        deterministicStable: baseEvent.deterministicStable,
      });
      const { rows, overflowSites } = comparisonRecordsToTrace(
        baseEvent.comparisonRecords ?? [],
        passedMap,
        probePrep.subjects ?? [],
      );
      prepared = prepareFromTraceFn(project, files, runOptions, {
        baseline: baseEvent.baseline,
        trace: rows,
        overflowSites,
        serverStaticComparisonKeys: baseEvent.serverStaticComparisonKeys,
        deterministicStable: baseEvent.deterministicStable,
        deterministicCoverageByKey: baseEvent.deterministicCoverageByKey,
      });
      extras = shiftTrials(prepared);
      return extras;
    },
  });

  if (session.evaluation === 'unsupported_session') {
    return { unsupportedSession: true, unsupportedReason: session.unsupportedReason };
  }
  if (session.evaluation === 'baseline_error') {
    return finalize({
      schemaVersion: 1,
      runner: 'playwright',
      mutators: profile,
      extraction: [],
      mutants: [],
      diagnostics: [],
      evaluation: 'baseline_error',
      baseline: session.baseline,
      ...(session.selection ? { selection: session.selection } : {}),
    });
  }
  if (session.evaluation === 'no_sites') {
    return finalize({ ...session, operatorExecution: 'session' });
  }

  if (!prepared) {
    prepared = prepareFromTraceFn(project, files, runOptions, {
      baseline: session.baselineSnapshot ?? { status: 'passed', tests: [] },
      trace: [],
    });
  }

  const baseSettled = sessionVerdicts(session, extras);
  const settled = runOptions.checkpointStore
    ? trial => runOptions.checkpointStore.get(checkpointKeyForTrial(trial)) ?? baseSettled(trial)
    : baseSettled;
  const completed = prepared.trials ? completeFn(prepared, settled) : prepared.report;
  if (runOptions.checkpointStore) {
    for (const mutant of completed.mutants ?? []) {
      runOptions.checkpointStore.record(checkpointKeyForTrial(mutant), mutant);
    }
  }
  const focused = carryBaseline({ ...completed, mutators: profile }, completed);
  const boundaries = new Set(focused.mutants.map(mutant => `${mutant.location.file}:${mutant.edit[0]}:${mutant.replacement}`));
  const added = session.mutants.filter(mutant => !(mutant.operatorSwap &&
    boundaries.has(`${mutant.location.file}:${mutant.operatorSwap.join(':')}`)));
  const mergedMutants = [...focused.mutants, ...added.map(mutant => fromSession(mutant, profile))].sort(order);
  const combinedDiagnostics = [...(focused.diagnostics ?? []), ...(session.diagnostics ?? [])];
  const compDiags = relationalComplementDiagnostics(prepared, profile, session.mutants, combinedDiagnostics);
  const { diagnostics: mergedDiagnostics, plainBaseline } = attachPlaywrightSpecWitnesses(
    prepared,
    suppressEnclosingDiagnostics([...combinedDiagnostics, ...compDiags]),
    mergedMutants,
  );
  if (plainBaseline?.status === 'passed') {
    Object.defineProperty(focused, baselineRunSymbol, {
      value: { status: plainBaseline.status, tests: plainBaseline.tests, plain: true },
      enumerable: false,
      configurable: true,
    });
  }

  return carryBaseline(finalize({
    ...focused,
    runner: 'playwright',
    operatorExecution: 'session',
    trials: session.trials,
    ...(session.sessionFailure ? { sessionFailure: session.sessionFailure } : {}),
    baseline: focused.baseline ?? session.baseline,
    evaluation: session.evaluation === 'incomplete' || focused.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: mergedMutants,
    diagnostics: mergedDiagnostics,
  }), focused);
}

function annotatePlaywrightSourceRewriteFallback(report, fallbackReason) {
  if (!fallbackReason) return report;
  const withReason = { ...report, sessionFallbackReason: fallbackReason };
  if (fallbackReason !== 'no-runtime-switch-observations') return withReason;
  const mutants = report.mutants ?? [];
  if (report.evaluation === 'baseline_error' || report.evaluation === 'no_sites' || !mutants.length) {
    return withReason;
  }
  const applicationEstablished = mutants.some(mutant => mutant.status === 'killed');
  if (applicationEstablished) return withReason;
  const unconfirmedSites = new Set();
  const updatedMutants = mutants.map(mutant => {
    if (mutant.status !== 'survived') return mutant;
    const key = mutant.site ?? mutant.id;
    if (key) unconfirmedSites.add(key);
    return {
      ...mutant,
      sourceVerdict: 'survived',
      status: 'unevaluated',
      statusReason: 'No runtime switch observations were recorded and no source-rewrite edit changed test behavior; edits may not have reached the running app',
    };
  });
  if (!unconfirmedSites.size) return withReason;
  const updatedDiagnostics = (report.diagnostics ?? []).filter(gap => !unconfirmedSites.has(gap.site));
  return {
    ...withReason,
    sourceApplication: 'unconfirmed',
    evaluation: 'incomplete',
    mutants: updatedMutants,
    diagnostics: updatedDiagnostics,
  };
}

// Vitest and Playwright (without --audit): built-in mutations and targeted rules run in one switched session
// with per-test coverage and dual-realm comparison/probe recording, falling back to source rewrites when needed.
export async function analyzeOperators(
  project,
  files,
  options,
  run = { analyze, analyzeNodeAsync, analyzePlaywrightSession, prepareAnalysis, prepareAnalysisFromTrace, completeAnalysis, analyzeConventional },
) {
  const profile = options.mutators ?? 'targeted';
  const shardSelection = options.shard ? computeShardSelection(project, files, { ...options, mutators: profile }) : null;
  let checkpointStore = null;
  if (options.checkpoint) {
    const root = canonicalPath(project);
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
  const rewriting = (fallbackReason = undefined) => {
    const out = run.analyze(project, files, { ...runOptions, mutators: profile });
    const annotated = runOptions.runner === 'playwright'
      ? annotatePlaywrightSourceRewriteFallback(out, fallbackReason)
      : out;
    return carryBaseline(finalize({ ...annotated, mutators: profile, operatorExecution: 'source-rewrite' }), out);
  };
  if (runOptions.runner === 'node') {
    const runnerFn = run.analyzeNodeAsync ?? analyzeNodeAsync;
    const out = await runnerFn(project, files, { ...runOptions, mutators: profile });
    return carryBaseline(finalize({ ...out, mutators: profile, operatorExecution: 'source-rewrite' }), out);
  }
  if (runOptions.audit) return rewriting();
  if (runOptions.runner === 'playwright') {
    let fallbackReason;
    if (run.analyzePlaywrightSession) {
      const sessionOut = await runPlaywrightTargetedSession(project, files, runOptions, run, profile, finalize);
      if (sessionOut && !sessionOut.unsupportedSession) return sessionOut;
      fallbackReason = sessionOut?.unsupportedReason;
    }
    return rewriting(fallbackReason);
  }
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
  const combinedDiagnostics = [...focused.diagnostics, ...(session.diagnostics ?? [])];
  const compDiags = relationalComplementDiagnostics(prepared, profile, session.mutants, combinedDiagnostics);
  return carryBaseline(finalize({
    ...focused,
    operatorExecution: 'session',
    trials: session.trials,
    ...(session.sessionFailure ? { sessionFailure: session.sessionFailure } : {}),
    baseline: focused.baseline ?? session.baseline,
    evaluation: session.evaluation === 'incomplete' || focused.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: [...focused.mutants, ...added.map(mutant => fromSession(mutant, profile))].sort(order),
    diagnostics: suppressEnclosingDiagnostics([...combinedDiagnostics, ...compDiags]),
  }), focused);
}
