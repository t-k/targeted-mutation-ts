import { analyze } from './analysis.mjs';
import { analyzeConventional } from './conventional.mjs';

const order = (a, b) => a.location.file.localeCompare(b.location.file) || a.location.start - b.location.start ||
  b.location.end - a.location.end;

function fromSession(mutant, profile) {
  const { source: _source, operatorSwap: _swap, ...reported } = mutant;
  if (profile === 'full') return reported;
  const { id, mutatorName, original, ...rest } = reported;
  return { site: id, rule: mutatorName, operator: original, ...rest };
}

// Vitest: comparison boundaries keep their focused analysis; the built-in mutations run in one switched session with
// per-test coverage. Playwright, and Vitest setups the session cannot drive, rewrite the source for each mutation instead.
export async function analyzeOperators(project, files, options, run = { analyze, analyzeConventional }) {
  const profile = options.mutators;
  const rewriting = () => ({ ...run.analyze(project, files, options), operatorExecution: 'source-rewrite' });
  if (options.runner === 'playwright') return rewriting();
  const focused = { ...run.analyze(project, files, { ...options, mutators: undefined }), mutators: profile };
  if (focused.evaluation === 'baseline_error' || focused.extraction.some(file => file.path === 'diagnostic')) return focused;
  const session = await run.analyzeConventional(project, files, {
    mutators: profile, lines: options.lines, since: options.since, config: options.config, test: options.test,
    'copy-exclude': options['copy-exclude'], dialect: options.dialect,
  });
  if (session.evaluation === 'baseline_error') return rewriting();
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
