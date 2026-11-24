import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { verdict } from './analysis.mjs';
import { selectScope } from './scope.mjs';
import { failedTests } from './vitest-reporter.mjs';
import { availableParallelism } from 'node:os';
import { inParallel } from './in-parallel.mjs';
import { inside, runVitestAsync, withCopy } from './vitest.mjs';
import { parseSource, discoverWitnessRules } from './witness-rules.mjs';
import { fixtureCalls, witnessProposals } from './witness-fixtures.mjs';
import { prepareContracts, evaluateContracts } from './witness-contracts.mjs';
import { parseSortConstraints } from './witness-order.mjs';
import { discoverySources, discoverContracts } from './witness-discovery.mjs';

const candidateLimit = 32;
const proposalLimit = 4;
const distinct = (rows, name, file) => rows.filter(test => test.name === name && test.file === file);
const key = test => JSON.stringify([test.project, test.file, test.id, test.name]);

export function applyTextEdits(source, edits) {
  let last = source.length;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > last || source.slice(edit.start, edit.end) !== edit.original) {
      throw new Error('A witness source edit no longer matches its snapshot');
    }
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    last = edit.start;
  }
  return source;
}

// One run of the suite in its own copy of the project. Copies are independent, so attempts can run side by side.
function runAttempt(root, options, snapshots, edits = [], append, capture = false) {
  return withCopy(root, async (workspace, temp) => {
    for (const [file, expected] of snapshots) {
      const current = readFileSync(inside(workspace, file));
      if (!isUtf8(current) || current.toString() !== expected) throw new Error(`Source changed during analysis: ${file}`);
    }
    for (const file of new Set([...edits.map(edit => edit.file), ...(append ? [append.file] : [])])) {
      const path = inside(workspace, file);
      const source = readFileSync(path, 'utf8');
      if (source !== snapshots.get(file)) throw new Error(`Source changed during analysis: ${file}`);
      writeFileSync(path, applyTextEdits(source, edits.filter(edit => edit.file === file)));
    }
    if (append) appendFileSync(inside(workspace, append.file), append.source);
    const result = await runVitestAsync(workspace, temp, { product: true, config: options.config, testFiles: options.test,
      ...(options.timeout ? { timeout: options.timeout * 1000 } : {}) });
    if (capture && result.status === 'passed') {
      for (const file of new Set(result.tests.map(test => test.file))) {
        const bytes = readFileSync(inside(workspace, file));
        if (isUtf8(bytes) && !snapshots.has(file)) snapshots.set(file, bytes.toString());
      }
    }
    return result;
  }, { exclude: options['copy-exclude'] });
}

export function isExpectedFailure(run, baseline, target, original, alternate, marker) {
  if (verdict(run, baseline) !== 'killed') return false;
  const failed = run.tests.filter(test => test.status === 'failed');
  if (failed.length !== 1 || key(failed[0]) !== key(target)) return false;
  const [error] = failed[0].assertions ?? [];
  return failed[0].failures.length === 1 && failed[0].assertions?.length === 1 &&
    error.message?.startsWith(marker + ':') &&
    (Object.is(error.actual, alternate) && Object.is(error.expected, original) ||
     error.actual === String(alternate) && error.expected === String(original));
}

async function verifyProposal(attempt, baseline, candidate, proposal, snapshots) {
  const { fixture, rewrite, original, mutant } = proposal;
  const suffix = randomUUID().replaceAll('-', '');
  const marker = 'TMT witness ' + suffix;
  if (rewrite) {
    const target = distinct(baseline.tests, fixture.name, fixture.file)[0];
    const edit = { ...rewrite, file: fixture.file };
    const tagged = { file: fixture.file, start: fixture.expectEnd, end: fixture.expectEnd, original: '', replacement: ', ' + JSON.stringify(marker) };
    const originalRun = await attempt([edit, tagged]);
    if (verdict(originalRun, baseline) !== 'survived') return null;
    const changed = await attempt([candidate.edit, edit, tagged]);
    if (isExpectedFailure(changed, baseline, target, original, mutant, marker)) {
      const source = snapshots.get(edit.file);
      const fixtureEdit = { ...edit, start: Buffer.byteLength(source.slice(0, edit.start)), end: Buffer.byteLength(source.slice(0, edit.end)) };
      return { fixtureEdit, verification: { status: 'confirmed', original: 'passed', rewrite: 'failed' } };
    }
    return null;
  }

  const name = marker;
  const expression = `__tmtCall_${suffix}(${proposal.arguments.map(value => JSON.stringify(value)).join(', ')})${fixture.suffix}`;
  const append = { file: fixture.file, source: `
import { expect as __tmtExpect_${suffix}, it as __tmtIt_${suffix} } from 'vitest';
import { ${candidate.name} as __tmtCall_${suffix} } from ${JSON.stringify(fixture.module)};
__tmtIt_${suffix}(${JSON.stringify(name)}, () => __tmtExpect_${suffix}(${expression}, ${JSON.stringify(marker)}).toBe(${JSON.stringify(original)}));
` };
  return await verifyAppend(attempt, baseline, [candidate.edit], append, marker, original, mutant)
    ? { verification: { status: 'confirmed', original: 'passed', rewrite: 'failed' } } : null;
}

async function verifyAppend(attempt, baseline, edits, append, marker, original, mutant) {
  const originalRun = await attempt([], append);
  if (originalRun.status !== 'passed' || originalRun.tests.length !== baseline.tests.length + 1) return false;
  const [target, extra] = distinct(originalRun.tests, marker, append.file);
  if (!target || extra || target.status !== 'passed' ||
      verdict({ ...originalRun, tests: originalRun.tests.filter(test => test !== target) }, baseline) !== 'survived') return false;
  return isExpectedFailure(await attempt(edits, append), originalRun, target, original, mutant, marker);
}

export async function analyzeWitnesses(project, files, options) {
  const root = realpathSync(project);
  const specification = options.spec ? JSON.parse(readFileSync(inside(root, options.spec), 'utf8')) : {};
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) throw new Error('Expected a witness specification object');
  const constraints = parseSortConstraints(specification).map(entry => {
    const file = resolve(root, entry.file);
    const path = relative(root, existsSync(file) ? inside(root, entry.file) : file);
    if (!path || isAbsolute(entry.file) || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) {
      throw new Error(`Sort constraint must name a project-relative source file: ${entry.file}`);
    }
    return { ...entry, file: path };
  });
  const boundConstraints = new Set();
  const snapshots = new Map();
  const candidates = [];
  const sources = [];
  const extraction = [];
  const selectedFiles = selectScope(root, files, options);
  for (const { file, selected } of selectedFiles) {
    const input = readFileSync(inside(root, file));
    if (!isUtf8(input)) {
      extraction.push({ file, path: 'diagnostic', reason: 'invalid-utf8' });
      continue;
    }
    const source = input.toString();
    const tree = parseSource(file, source);
    snapshots.set(file, source);
    const rules = discoverWitnessRules(tree, constraints.filter(entry => entry.file === file));
    for (const rule of rules) for (const entry of rule.constraints ?? []) boundConstraints.add(entry);
    sources.push(discoverySources(tree, selected, file));
    extraction.push({ file, path: tree.parseDiagnostics.length ? 'diagnostic' : 'typescript' });
    for (const rule of rules) {
      const start = rule.node.getStart(tree);
      const end = rule.node.getEnd();
      const pos = tree.getLineAndCharacterOfPosition(start);
      const last = tree.getLineAndCharacterOfPosition(end - 1).line;
      if (Array.from({ length: last - pos.line + 1 }, (_, index) => pos.line + index + 1).some(line => !selected(line))) continue;
      const edit = { file, start, end, original: source.slice(start, end), replacement: rule.replacement };
      const location = { file, line: pos.line + 1, column: pos.character + 1,
        start: Buffer.byteLength(source.slice(0, start)), end: Buffer.byteLength(source.slice(0, end)) };
      const id = createHash('sha256').update(JSON.stringify([file, source, start, rule.rule, rule.replacement])).digest('hex');
      candidates.push({ ...rule, id, edit, location });
    }
  }
  const selectedPaths = new Set(selectedFiles.map(({ file }) => file));
  const unmatched = constraints.find(entry => selectedPaths.has(entry.file) && !boundConstraints.has(entry));
  if (unmatched) throw new Error(`Sort constraints do not match a supported export: ${unmatched.file} / ${unmatched.function}`);

  const witnessSearch = { candidates: candidates.length, matched: 0, unmatched: candidates.length ? null : 0, evaluated: 0, omitted: 0 };
  const report = { schemaVersion: 1, runner: 'vitest', profile: 'witnesses', extraction, witnessSearch,
    mutants: [], diagnostics: [], evaluation: 'no_sites' };
  if (options.config || options.test?.length || options['copy-exclude']?.length) {
    report.selection = { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] };
  }
  const selection = new Map(selectedFiles.map(({ file, selected }) => [file, selected]));
  const plans = Object.hasOwn(specification, 'witnessPlans') ? prepareContracts(specification, selection, snapshots) : [];
  const discoveryPossible = sources.some(source => source.stores.length) ||
    ['encoder', 'decoder'].every(kind => sources.some(source => source.endpoints.some(endpoint => endpoint.kind === kind)));
  if ((!candidates.length && !plans.length && !discoveryPossible) || extraction.some(entry => entry.path === 'diagnostic')) return report;
  const attempt = (edits, append) => runAttempt(root, options, snapshots, edits, append);
  const baseline = await runAttempt(root, options, snapshots, [], undefined, true);
  // Each candidate, and each contract after them, is tried in copies of its own, several at a time.
  // The report keeps the candidates' order whatever order they finish in.
  const concurrency = options.concurrency ?? Math.max(1, Math.min(8, availableParallelism() - 1));
  if (baseline.status !== 'passed') return { ...report, evaluation: 'baseline_error',
    baseline: { status: baseline.status, errors: baseline.errors, output: baseline.output, failedTests: failedTests(baseline) } };
  report.baseline = { status: 'passed', tests: baseline.tests.length };
  const testFiles = new Set(baseline.tests.map(test => test.file));
  const fixtureSources = [...testFiles].flatMap(file => {
    const source = snapshots.get(file);
    if (source === undefined) return [];
    return [{ file, tree: parseSource(file, source) }];
  });
  const prepared = candidates.filter(candidate => !testFiles.has(candidate.location.file)).flatMap(candidate => {
    const fixtures = fixtureSources.flatMap(({ tree, file }) => fixtureCalls(tree, file, candidate, candidate.location.file, root))
      .filter(fixture => {
        const keys = distinct(baseline.tests, fixture.name, fixture.file);
        return keys.length === 1 && keys[0].status === 'passed' && !keys[0].retry && !keys[0].repeats;
      });
    if (fixtures.length) witnessSearch.matched++;
    const proposals = witnessProposals(candidate, fixtures);
    return proposals.length ? [{ candidate, fixtures, proposals }] : [];
  });
  report.evaluation = 'evaluated';
  witnessSearch.unmatched = candidates.length - witnessSearch.matched;
  witnessSearch.evaluated = Math.min(prepared.length, candidateLimit);
  witnessSearch.omitted = Math.max(0, prepared.length - candidateLimit);

  const tried = await inParallel(prepared.slice(0, candidateLimit), concurrency, async ({ candidate, fixtures, proposals }) => {
    const { id, location, rule, edit } = candidate;
    const outcome = verdict(await attempt([edit]), baseline);
    const mutant = { id, location, rule, edit: [location.start, location.end], original: edit.original,
      replacement: edit.replacement, status: outcome, evidence: 'reexecuted' };
    if (outcome !== 'survived') return { mutant };
    for (const proposal of proposals.slice(0, proposalLimit)) {
      const verified = await verifyProposal(attempt, baseline, candidate, proposal, snapshots);
      if (!verified) continue;
      const { fixture, original, mutant: changed } = proposal;
      return { mutant, diagnostic: {
        kind: 'INPUT GAP', site: id, rule, location,
        witness: { arguments: proposal.arguments, original, mutant: changed, expectation: 'original' },
        observedOutcomes: candidate.outcome ? [...new Set(fixtures
          .map(seed => candidate.outcome(seed.args.map(arg => arg.value), seed.expected)).filter(Boolean))].sort() : undefined,
        seed: { file: fixture.file, test: fixture.name },
        suggestedTest: `expect(${fixture.bindingName}(${proposal.arguments.map(value => JSON.stringify(value)).join(', ')})${fixture.suffix}).toBe(${JSON.stringify(original)})`,
        constraints: candidate.constraints,
        ...verified,
      } };
    }
    return { mutant };
  });
  for (const { mutant, diagnostic } of tried) {
    report.mutants.push(mutant);
    if (diagnostic) report.diagnostics.push(diagnostic);
  }
  const automatic = discoverContracts(fixtureSources, baseline, sources, { project: root }).filter(plan => !plans.some(explicit =>
    explicit.testFile === plan.testFile && explicit.seedTest === plan.seedTest &&
    explicit.edits.length === plan.edits.length && explicit.edits.every(edit => plan.edits.some(other =>
      edit.file === other.file && edit.line === other.line && edit.original === other.original && edit.replacement === other.replacement))));
  const discovered = prepareContracts({ witnessPlans: automatic }, selection, snapshots, { discovered: true });
  await evaluateContracts([...plans, ...discovered], attempt, baseline, snapshots, verifyAppend, report, concurrency);
  // A trial the runner could not finish is neither a kill nor a survivor.
  if (report.mutants.some(mutant => mutant.status === 'error')) report.evaluation = 'incomplete';
  return report;
}
