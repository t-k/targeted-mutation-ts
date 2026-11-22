import { analyze } from './analysis.mjs';
import { analyzeConventional } from './conventional.mjs';

const order = (a, b) => a.location.file.localeCompare(b.location.file) || a.location.start - b.location.start;

function fromSession(mutant) {
  const { id, mutatorName, original, ...rest } = mutant;
  return { site: id, rule: mutatorName, operator: original, ...rest };
}

// Vitest: comparison edits keep their focused analysis; operator swaps run in one switched session with per-test coverage.
// Playwright, and Vitest setups the session cannot drive, rewrite the source for each operator edit instead.
export async function analyzeOperators(project, files, options, run = { analyze, analyzeConventional }) {
  const rewriting = () => ({ ...run.analyze(project, files, options), operatorExecution: 'source-rewrite' });
  if (options.runner === 'playwright') return rewriting();
  const focused = { ...run.analyze(project, files, { ...options, mutators: undefined }), mutators: 'operators' };
  if (focused.evaluation === 'baseline_error' || focused.extraction.some(file => file.path === 'diagnostic')) return focused;
  const session = await run.analyzeConventional(project, files, {
    mutators: 'operators', lines: options.lines, since: options.since, config: options.config, test: options.test,
    'copy-exclude': options['copy-exclude'], dialect: options.dialect,
  });
  if (session.evaluation === 'baseline_error') return rewriting();
  if (session.evaluation === 'no_sites') return { ...focused, operatorExecution: 'session' };
  return {
    ...focused,
    operatorExecution: 'session',
    baseline: focused.baseline ?? session.baseline,
    evaluation: session.evaluation === 'incomplete' ? 'incomplete' : 'evaluated',
    mutants: [...focused.mutants, ...session.mutants.map(fromSession)].sort(order),
  };
}
