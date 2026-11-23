export const usage = `Usage: targeted-mutation <command> [options]   (alias: tmts)

Commands:
  analyze [PROJECT] [FILE...]   Run the project's tests against targeted source edits and report test gaps.
  extract FILE                  Print the comparison candidates found in one source file as JSON.
  prototype PROJECT FILE        Run the original threshold experiment on one file.

Scope (analyze):
  --lines FILE:FROM-TO          Limit to a line range. FILE:N selects one line. Repeatable.
  --since REV                   Limit to lines added or changed since a Git revision.
  --copy-exclude PATH           Leave a project path out of the temporary copies. Repeatable.

Profiles (analyze):
  --mutators focused|operators|full|standard|all
                                focused (default) edits comparison boundaries and thresholds.
                                operators adds equality, logical and arithmetic operator swaps.
                                full adds the complete built-in mutation set (the StrykerJS mutators).
                                standard and all use @stryker-mutator/instrumenter@10.1.1 instead.
  --witnesses                   Search for edits that survive and confirm a distinguishing test.
  --spec FILE                   Specification with expected thresholds or witness plans.
  --deterministic               Declare a deterministic suite so recorded comparisons can decide a trial.
  --audit                       Re-run predicted trials against the rewritten source.
  --displace-thresholds         Also try displaced thresholds (Vitest only).
  --concurrency N               Workers that share the mutations of operators, full, standard and all
                                (default: CPU count minus one).
  --isolated-trials             Start a fresh Vitest run for every mutation instead of switching mutations
                                inside a running worker. Slower; for suites that leave state behind.

Runner (analyze):
  --runner vitest|playwright    Test runner (default: vitest).
  --config FILE                 Runner configuration file inside the project.
  --test FILE                   Run only this Vitest file. Repeatable.
  --project NAME                Playwright project. Repeatable.

Output:
  --format text|json            analyze prints text on a terminal and JSON otherwise.
  --mode script|module          extract: parse goal.
  --dialect ts|tsx              extract: source dialect.
  -h, --help                    Show this help.
  -v, --version                 Show the version.`;

export function chooseFormat(requested, terminal) {
  if (requested === undefined) return terminal ? 'text' : 'json';
  if (requested !== 'text' && requested !== 'json') throw new Error('Expected --format text|json');
  return requested;
}

// Test names and runner output come from the analyzed project and can carry terminal control sequences.
const printable = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');
const firstLine = value => printable(value).split('\n').find(line => line.trim())?.trim() ?? '';
const at = location => location ? `${location.file}:${location.line}:${location.column}` : '(unknown location)';

function describeEdit(mutant) {
  const name = mutant.mutatorName ?? mutant.rule ?? 'edit';
  if (mutant.original !== undefined) return `${name}: ${firstLine(mutant.original)} -> ${firstLine(mutant.replacement)}`;
  const operator = String(mutant.replacement).trim();
  if (mutant.operator !== undefined && /^[<>=!&|?+*\/%-]+$/.test(operator)) return `${name}: ${mutant.operator} -> ${operator}`;
  return `${name}: replace with ${firstLine(mutant.replacement)}`;
}

function describeBaseline(baseline = {}) {
  const lines = [`The test suite did not pass before any edit (baseline ${baseline.status ?? 'unknown'}). Fix it and run again.`];
  for (const failed of baseline.failedTests ?? []) {
    lines.push(`  FAILED ${printable(failed.file)} > ${printable(failed.name)}`);
    for (const failure of failed.failures ?? []) lines.push(`    ${firstLine(failure)}`);
  }
  for (const error of baseline.errors ?? []) lines.push(`  ERROR ${firstLine(error)}`);
  if (!baseline.failedTests?.length && !baseline.errors?.length && baseline.output?.trim()) {
    lines.push(...printable(baseline.output).trim().split('\n').slice(-20).map(line => `  ${line}`));
  }
  return lines;
}

function describeGap(gap) {
  const lines = [`${gap.kind ?? 'GAP'} ${at(gap.location)}${gap.rule ? `  ${gap.rule}` : ''}`];
  const witness = gap.witness;
  const inputs = witness?.arguments ?? witness?.operands;
  if (inputs) {
    lines.push(`  ${witness.arguments ? 'arguments' : 'operands'} (${inputs.map(printable).join(', ')}): ` +
      `original ${printable(witness.original)}, edited ${printable(witness.mutant)}`);
  }
  if (gap.suggestedTest) lines.push(`  suggested test: ${printable(gap.suggestedTest)}`);
  if (gap.seed) lines.push(`  based on: ${printable(gap.seed.file)} > ${printable(gap.seed.test)}`);
  if (gap.requirement) lines.push(`  requirement: ${firstLine(gap.requirement)}`);
  if (gap.suggestedTestFile) lines.push(`  suggested test file: ${printable(gap.suggestedTestFile)}`);
  if (gap.verification?.status) lines.push(`  verification: ${printable(gap.verification.status)}`);
  if (gap.verification?.baselineWithWitness) {
    lines.push(`  verification: original ${printable(gap.verification.baselineWithWitness)}, edited ${printable(gap.verification.rewriteWithWitness)}`);
  }
  return lines;
}

export function renderText(report) {
  const lines = [];
  for (const file of report.extraction ?? []) {
    if (file.path !== 'diagnostic') continue;
    lines.push(`SKIPPED ${printable(file.file)}: ${file.reason ?? 'not analyzed'}`);
    for (const diagnostic of file.diagnostics ?? []) lines.push(`  ${firstLine(diagnostic.message)}`);
  }
  if (report.evaluation === 'baseline_error') {
    lines.push(...describeBaseline(report.baseline));
    return lines.join('\n');
  }
  const mutants = report.mutants ?? [];
  for (const mutant of mutants) {
    lines.push(`${at(mutant.location)}  ${mutant.status}  ${describeEdit(mutant)}`);
  }
  const gaps = report.diagnostics ?? [];
  if (gaps.length) lines.push('', 'Test gaps:');
  for (const gap of gaps) lines.push(...describeGap(gap));
  if (lines.length) lines.push('');
  if (report.evaluation === 'no_sites') {
    lines.push('No edit sites in the selected scope.');
    return lines.join('\n');
  }
  const counts = new Map();
  for (const mutant of mutants) counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
  const tally = [...counts].map(([status, count]) => `${count} ${status}`).join(', ') || 'none';
  const tests = report.baseline?.tests;
  const size = Array.isArray(tests) ? tests.length : tests;
  lines.push(`${report.runner}${size === undefined ? '' : `, ${size} baseline tests`}: ` +
    `${mutants.length} edits (${tally}), ${gaps.length} test gaps` +
    (report.evaluation === 'evaluated' ? '' : `, evaluation ${report.evaluation}`));
  return lines.join('\n');
}
