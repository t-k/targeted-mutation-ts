import { analyze, completeAnalysis, prepareAnalysis } from './analysis.mjs';
import { analyzeConventional } from './conventional.mjs';

const order = (a, b) => a.location.file.localeCompare(b.location.file) || a.location.start - b.location.start ||
  b.location.end - a.location.end;

function fromSession(mutant, profile) {
  const { source: _source, operatorSwap: _swap, ...reported } = mutant;
  if (profile === 'full') return reported;
  const { id, mutatorName, original, ...rest } = reported;
  return { site: id, rule: mutatorName, operator: original, ...rest };
}

const definitive = new Set(['killed', 'survived', 'timeout', 'unreached']);

// A comparison boundary is the same edit in both parts, so the session's run of it answers the focused trial.
function sessionVerdicts(session) {
  const swaps = new Map(session.mutants.filter(mutant => mutant.operatorSwap && definitive.has(mutant.status))
    .map(mutant => [`${mutant.location.file}:${mutant.operatorSwap.join(':')}`, mutant]));
  return trial => {
    if (trial.rule !== trial.site.rule || trial.source) return undefined;
    const mutant = swaps.get(`${trial.site.location.file}:${trial.edit[0]}:${trial.replacement}`);
    // The focused analysis decides between unreached and survived from its own recorded comparisons.
    return mutant && { status: mutant.status === 'unreached' ? 'survived' : mutant.status, tests: mutant.tests };
  };
}

// Vitest: the built-in mutations run in one switched session with per-test coverage while the focused analysis
// records its comparisons, and the session's verdicts answer the comparison boundaries both parts share.
// Playwright, and Vitest setups the session cannot drive, rewrite the source for each mutation instead.
export async function analyzeOperators(project, files, options, run = { analyze, prepareAnalysis, completeAnalysis, analyzeConventional }) {
  const profile = options.mutators;
  const rewriting = () => ({ ...run.analyze(project, files, options), operatorExecution: 'source-rewrite' });
  if (options.runner === 'playwright') return rewriting();
  const stop = new AbortController();
  const started = run.analyzeConventional(project, files, {
    mutators: profile, lines: options.lines, since: options.since, config: options.config, test: options.test,
    'copy-exclude': options['copy-exclude'], dialect: options.dialect, 'isolated-trials': options['isolated-trials'],
    signal: stop.signal,
  }).then(report => ({ report }), error => ({ error }));
  let prepared;
  try {
    prepared = run.prepareAnalysis(project, files, { ...options, mutators: undefined });
  } catch (error) {
    stop.abort();
    await started;
    throw error;
  }
  // Without planned trials the focused analysis ended in its preparation.
  const early = prepared.trials ? null : { ...prepared.report, mutators: profile };
  if (early && (early.evaluation === 'baseline_error' || early.extraction.some(file => file.path === 'diagnostic'))) {
    stop.abort();
    await started;
    return early;
  }
  const { report: session, error } = await started;
  if (error) throw error;
  if (session.evaluation === 'baseline_error') return rewriting();
  const focused = early ?? { ...run.completeAnalysis(prepared, sessionVerdicts(session)), mutators: profile };
  if (session.evaluation === 'no_sites') return { ...focused, operatorExecution: 'session' };
  // A comparison boundary appears in both parts. The focused result carries the missing input, so it is the one kept.
  const boundaries = new Set(focused.mutants.map(mutant => `${mutant.location.file}:${mutant.edit[0]}:${mutant.replacement}`));
  const added = session.mutants.filter(mutant => !(mutant.operatorSwap &&
    boundaries.has(`${mutant.location.file}:${mutant.operatorSwap.join(':')}`)));
  return {
    ...focused,
    operatorExecution: 'session',
    baseline: focused.baseline ?? session.baseline,
    evaluation: session.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: [...focused.mutants, ...added.map(mutant => fromSession(mutant, profile))].sort(order),
  };
}
