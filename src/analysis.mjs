import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { byteLocations, byteOffsets, extract, sourceDialect } from './extract.mjs';
import { comparisonThresholdSites } from './prototype.mjs';
import { thresholdGaps } from './threshold.mjs';
import { shiftedReplacement, tightenComparison } from './displacement.mjs';
import { failedTests } from './vitest-reporter.mjs';
import { inside, runVitest, runVitestAsync, withCopy } from './vitest.mjs';
import { createProbePreloadCheck, freshProbeBinding, instrument, installProbe, rewrite } from './probe.mjs';
import { runPlaywright } from './playwright.mjs';
import { selectScope } from './scope.mjs';
import { checkReplay } from './lean-replay.mjs';
import { ignoredSwaps, renderBuiltinSwitches } from './builtin-switches.mjs';
import { inspectTrace, pendingTraceDirectory, sameObservations } from './trace-buffer.mjs';

export const baselineRunSymbol = Symbol.for('targeted-mutation-ts/baseline-run');

const sha = source => createHash('sha256').update(source).digest('hex');
const identity = test => JSON.stringify([test.project, test.file, test.id]);
const testcase = ({ id, project, file, name }) => ({ id, project, file, name });
const literalKey = { '<': 'ltLiteral', '<=': 'leLiteral', '>': 'gtLiteral', '>=': 'geLiteral' };

function compare(operator, left, right) {
  switch (operator) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
  }
}

// The Playwright extraction reports a logical operator with an operand-dropping edit (`jsx-disabled-drop-left/v1`).
// The complete built-in set as plain source edits, for runners that cannot use runtime switches.
// A comparison boundary or JSX disabled left-drop that the focused analysis already edits is left to it.
function builtInSites(comparisons, input, file, dialect, selected, options = {}) {
  const focused = new Set(comparisons.map(candidate => `${candidate.edit[0]}:${candidate.replacement}`));
  const droppedLeft = new Set(comparisons.filter(candidate => candidate.rule === 'jsx-disabled-drop-left/v1')
    .map(candidate => `${candidate.edit[0]}:${candidate.edit[1]}`));
  return renderBuiltinSwitches(input, file, selected, { dialect, ...options }).mutants
    .filter(mutant => mutant.status === undefined &&
      !(mutant.operatorSwap && focused.has(mutant.operatorSwap.join(':'))) &&
      !(mutant.targeted?.form === 'left' && droppedLeft.has(`${mutant.edit[0]}:${mutant.edit[1]}`)))
    .map(mutant => ({ rule: mutant.mutatorName, original: mutant.original, replacement: mutant.replacement, edit: mutant.edit,
      left: [mutant.edit[0], mutant.edit[0]], right: [mutant.edit[1], mutant.edit[1]], source: mutant.source, unobserved: true }));
}

function withProfileSites(comparisons, input, file, { mutators, dialect }, selected) {
  const start = candidate => (candidate.operatorEdit ?? candidate.edit)[0];
  // Without a session nothing is recorded, so the targeted or full edits run as plain source edits.
  const added = mutators === 'full' ? builtInSites(comparisons, input, file, dialect, selected)
    : mutators === 'targeted' ? builtInSites(comparisons, input, file, dialect, selected, { targeted: true, keep: mutation => mutation.targeted !== undefined })
      : [];
  return added.length ? [...comparisons, ...added].sort((a, b) => start(a) - start(b)) : comparisons;
}

export function collectComparisons(root, files, options) {
  const subjects = [];
  const extraction = [];
  for (const { file, selected } of selectScope(root, files, options)) {
    const input = readFileSync(inside(root, file));
    const { path, fallback, reason, candidates: comparisons, diagnostics } = extract(input, { file, mode: options.mode, dialect: options.dialect, logical: options.runner === 'playwright' });
    extraction.push({ file, path, reason, diagnostics, ...(fallback === undefined ? {} : { fallback }) });
    if (path === 'diagnostic') continue;
    // A boundary under a `// Stryker disable` comment is not edited by any profile.
    const disabled = ignoredSwaps(input, file, { dialect: options.dialect });
    const kept = disabled.size ? comparisons.filter(candidate => !disabled.has(`${candidate.edit[0]}:${candidate.replacement}`)) : comparisons;
    if (kept.length !== comparisons.length) extraction.at(-1).ignored = comparisons.length - kept.length;
    const candidates = ['targeted', 'full'].includes(options.mutators) ? withProfileSites(kept, input, file, options, selected) : kept;
    const positions = byteLocations(input, candidates.map(candidate => (candidate.operatorEdit ?? candidate.edit)[0]));
    // A comparison is in scope when any line from its left operand to its right operand is: a threshold on its
    // own line belongs to the comparison whose operator is on the line above.
    const reach = candidates.map(candidate => {
      const [start, end] = candidate.operatorEdit ?? candidate.edit;
      return [Math.min(start, candidate.left?.[0] ?? start), Math.max(start, (candidate.right?.[1] ?? end) - 1)];
    });
    // The lookup takes offsets in ascending order, and nested comparisons overlap.
    const offsets = [...new Set(reach.flat())].sort((a, b) => a - b);
    const located = byteLocations(input, offsets);
    const lineAt = new Map(offsets.map((offset, index) => [offset, located[index * 2]]));
    let digest;
    const sites = candidates.flatMap((candidate, index) => {
      const [start, end] = candidate.operatorEdit ?? candidate.edit;
      const location = { file, line: positions[index * 2], column: positions[index * 2 + 1], start, end };
      let inScope = false;
      for (let line = lineAt.get(reach[index][0]); line <= lineAt.get(reach[index][1]) && !inScope; line++) inScope = selected(line);
      if (!inScope) return [];
      digest ??= sha(input);
      return [{ ...candidate, location, id: sha(JSON.stringify([
        file, digest, options.mode ?? 'module', options.dialect ?? sourceDialect(file),
        candidate,
      ])) }];
    });
    if (sites.length) subjects.push({ file, input, sites, digest });
  }
  return { subjects, extraction };
}

export function verdict(run, baseline) {
  if (!['passed', 'failed'].includes(run.status)) return run.status;
  const baselineTests = new Map(baseline.tests.map(test => [identity(test), test]));
  if (run.tests.length !== baselineTests.size || run.tests.some(test => {
    const original = baselineTests.get(identity(test));
    return !original || original.name !== test.name || original.browser !== test.browser ||
      (original.status === 'passed' ? !['failed', 'passed'].includes(test.status) : original.status !== test.status);
  })) return 'unstable';
  return run.status === 'passed' ? 'survived' : 'killed';
}

function makeAttempt(root, subjects, runner, copyExclude, probeChecks, settings = {}) {
  const { tracing = false, activate, trial, witness, coverageSites, synchronousTrace, collect } = settings;
  const attempt = withCopy(root, (workspace, temp) => {
    const trace = tracing ? resolve(temp, 'trace.jsonl') : undefined;
    if (trace) mkdirSync(pendingTraceDirectory(trace));
    const files = subjects.map(subject => ({ subject, file: inside(workspace, subject.file) }));
    const preloaded = tracing ? new Set(files.filter(({ file, subject }) => probeChecks.get(subject)(workspace, file))) : null;
    const binding = preloaded?.size ? freshProbeBinding([...preloaded].map(({ subject }) => subject.input)) : undefined;
    const probePreload = tracing ? installProbe(workspace, binding) : undefined;
    for (const entry of files) {
      const { subject, file } = entry;
      if (sha(readFileSync(file)) !== subject.digest) throw new Error(`Source changed during analysis: ${subject.file}`);
      const observable = tracing ? subject.sites.filter(site => !site.unobserved) : [];
      if (observable.length) writeFileSync(file, instrument(workspace, subject.file, subject.input, observable,
        preloaded.has(entry) ? binding : undefined, coverageSites));
      else if (!tracing && trial?.site.location.file === subject.file) writeFileSync(file, rewrite(subject.input, trial.source?.edit ?? trial.edit, trial.source?.replacement ?? trial.replacement));
    }
    let witnessFile;
    if (witness?.rewrite) {
      // A test file with one of its calls wrapped, to record what the call gives where the test makes it.
      writeFileSync(inside(workspace, witness.rewrite.file), witness.rewrite.content);
    } else if (witness?.appendTo) {
      const path = inside(workspace, witness.appendTo);
      appendFileSync(path, witness.source);
      witnessFile = relative(workspace, path);
    } else if (witness) {
      const folder = inside(workspace, witness.directory);
      const path = resolve(folder, witness.name);
      writeFileSync(path, readFileSync(inside(workspace, witness.content)), { flag: 'wx' });
      witnessFile = relative(workspace, path);
    }
    const result = runner(workspace, temp, { trace, active: activate, product: true, probePreload, synchronousTrace });
    if (!tracing && collect) {
      const path = resolve(workspace, collect);
      return { ...result, collected: existsSync(path) ? readFileSync(path, 'utf8') : '' };
    }
    if (!tracing) return { ...result, witnessFile, witnessName: witness?.testName };
    const { rows, overlap } = inspectTrace(trace);
    return { ...result, trace: rows, overlap, synchronousTrace };
  }, { exclude: copyExclude });
  if (attempt.overlap && !synchronousTrace && ['passed', 'failed'].includes(attempt.status)) {
    return makeAttempt(root, subjects, runner, copyExclude, probeChecks, { ...settings, synchronousTrace: true });
  }
  return attempt;
}

// Runs of the suite against plain source edits, for analyses that record nothing: `attempt()` is the baseline
// and `attempt({ trial })` one edit, each in a fresh copy of the project.
export function sourceTrials(root, subjects, options) {
  const runner = options.runner === 'playwright'
    ? (workspace, temp) => runPlaywright(workspace, temp, { config: options.config, projects: options.project, original: root,
      tests: options.test, ...(options.timeout ? { timeout: options.timeout * 1000 } : {}) })
    : (workspace, temp, settings) => runVitest(workspace, temp, {
      ...settings, config: options.config, testFiles: options.test, ...(options.timeout ? { timeout: options.timeout * 1000 } : {}) });
  return settings => makeAttempt(root, subjects, runner, options['copy-exclude'], new Map(), settings);
}

// Asynchronous Vitest plain-source runs, so independent witness checks can run side by side.
export function sourceTrialsAsync(root, subjects, options) {
  const runner = (workspace, temp, settings) => runVitestAsync(workspace, temp, {
    ...settings, config: options.config, testFiles: options.test, ...(options.timeout ? { timeout: options.timeout * 1000 } : {}) });
  return settings => withCopy(root, async (workspace, temp) => {
    const { trial, witness, collect } = settings ?? {};
    for (const subject of subjects) {
      const file = inside(workspace, subject.file);
      if (sha(readFileSync(file)) !== subject.digest) throw new Error(`Source changed during analysis: ${subject.file}`);
      if (trial?.site.location.file === subject.file) writeFileSync(file, rewrite(subject.input, trial.source?.edit ?? trial.edit, trial.source?.replacement ?? trial.replacement));
    }
    if (witness?.rewrite) writeFileSync(inside(workspace, witness.rewrite.file), witness.rewrite.content);
    const result = await runner(workspace, temp, { product: true });
    if (collect) {
      const path = resolve(workspace, collect);
      return { ...result, collected: existsSync(path) ? readFileSync(path, 'utf8') : '' };
    }
    return result;
  }, { exclude: options['copy-exclude'] });
}

function indexObservations(trace, baseline) {
  const tests = new Map(baseline.tests.filter(test => test.status === 'passed').map(test => [identity(test), test]));
  const bySite = new Map();
  const loaded = new Set();
  for (const row of trace ?? []) {
    if (typeof row?.site === 'string') {
      let rows = bySite.get(row.site);
      if (!rows) bySite.set(row.site, rows = []);
      rows.push(row);
    }
    if (Array.isArray(row?.loaded)) for (const site of row.loaded) loaded.add(site);
  }
  return { tests, bySite, loaded };
}

function matchObservations(site, { tests, bySite, loaded }) {
  const rows = bySite.get(site.id) ?? [];
  const observed = new Map();
  let complete = rows.length > 0;
  for (const row of rows) {
    const key = row.identity ? identity(row.identity) : null;
    if (!tests.has(key) || !Array.isArray(row.operands) || row.operands.length !== 2 ||
        !row.operands.every(Number.isSafeInteger) || row.operator !== site.operator ||
        compare(site.operator, ...row.operands) !== row.result) {
      complete = false;
    } else {
      if (!observed.has(key)) observed.set(key, []);
      observed.get(key).push(row.operands);
    }
  }
  return { observed, rows, complete, tests, loaded: loaded.has(site.id) };
}

function thresholdLookup(subject) {
  let offsets;
  let byOperator;
  return site => {
    if (!byOperator) {
      const source = subject.input.toString();
      offsets = byteOffsets(source);
      byOperator = new Map();
      for (const { operator, ...entry } of comparisonThresholdSites(source, subject.file)) {
        let entries = byOperator.get(operator);
        if (!entries) byOperator.set(operator, entries = new Map());
        const left = offsets[entry.from];
        if (!entries.has(left)) entries.set(left, entry);
      }
    }
    const entry = byOperator.get(site.operator)?.get(site.left[0]);
    if (entry && offsets[entry.literalFrom] === site.right[0] && offsets[entry.literalTo] === site.right[1]) return entry;
    return null;
  };
}

function callableThreshold(subject, site, observations, specification, lookupThreshold) {
  if (!observations.complete ||
      !/^-?\s*\d+$/.test(subject.input.subarray(...site.right).toString())) return null;
  const meta = lookupThreshold(site);
  if (!meta || observations.rows.some(row => row.operands[1] !== meta.threshold)) return null;
  const contract = Object.hasOwn(specification, meta.functionName) ? specification[meta.functionName] : null;
  const specified = contract?.operator === site.operator && contract.threshold === meta.threshold &&
    typeof contract.rationale === 'string' && contract.rationale.trim().length > 0;
  const inputs = observations.rows.map(row => row.operands[0]);
  return { meta, gap: null, specified, inputs, contract };
}

function constantThreshold(site, observation, callable) {
  if (!observation.complete || !observation.rows.length || !['<', '<=', '>', '>='].includes(site.operator)) return null;
  const value = observation.rows[0].operands[1];
  if (observation.rows.some(row => row.operands[1] !== value)) return null;
  const inputs = observation.rows.map(row => row.operands[0]);
  return {
    operator: site.operator,
    value,
    inputs,
    min: callable?.specified ? callable.contract.min : undefined,
    max: callable?.specified ? callable.contract.max : undefined,
    gap: null,
  };
}

const isBoundaryEquivalentShift = (operator, threshold, alternate) =>
  (operator === '>=' || operator === '<') ? alternate === threshold + 1 : alternate === threshold - 1;

export function planFocusedTrials(subjects, trace, baseline, specification, displaceThresholds) {
  const sites = [];
  const thresholdRequests = [];
  const observations = indexObservations(trace, baseline);
  for (const subject of subjects) {
    const lookupThreshold = thresholdLookup(subject);
    for (const site of subject.sites) {
      const observation = matchObservations(site, observations);
      const tightened = tightenComparison(subject.input, site, observation, displaceThresholds);
      const callable = callableThreshold(subject, site, observation, specification, lookupThreshold);
      const constant = constantThreshold(site, observation, callable);
      if (constant) thresholdRequests.push(constant);
      sites.push({ subject, site, observation, tightened, callable, constant });
    }
  }
  const gaps = thresholdGaps(thresholdRequests.map(({ operator, value, inputs, min, max }) => ({
    operator, threshold: value, observations: inputs, min, max,
  })));
  thresholdRequests.forEach((entry, index) => { entry.gap = gaps[index]; });

  const trials = [];
  for (const { subject, site, observation, tightened, callable, constant } of sites) {
    if (callable && constant) callable.gap = constant.gap;
    const boundary = {
      site, edit: site.edit, replacement: site.replacement, source: site.source, rule: site.rule,
      observation, threshold: callable, thresholdGap: constant?.gap ?? null,
    };
    trials.push(boundary);
    let thresholdAdjustment;
    if (constant?.gap) {
      const { alternate } = constant.gap;
      const rhsText = subject.input.subarray(...site.right).toString();
      const isLiteral = /^-?\s*\d+$/.test(rhsText) && Number(rhsText.replace(/\s+/g, '')) === constant.value;
      if (isLiteral && isBoundaryEquivalentShift(site.operator, constant.value, alternate)) {
        boundary.equivalentOnSafeIntegers = [`${site.operator} ${alternate}`];
      } else {
        thresholdAdjustment = alternate - constant.value;
        const replacement = isLiteral ? String(alternate) : shiftedReplacement(subject.input, site, thresholdAdjustment);
        trials.push({
          site, edit: site.right, replacement, rule: 'comparison-threshold/v1', observation,
          adjustment: thresholdAdjustment, thresholdValue: constant.value, isLiteralThreshold: isLiteral,
          thresholdGap: constant.gap, threshold: callable,
        });
      }
    }
    if (tightened && tightened.adjustment !== thresholdAdjustment) trials.push({ ...tightened, threshold: callable });
  }
  return trials;
}

function sitesForIndependentCoverage(subjects, trace, baseline) {
  const index = indexObservations(trace, baseline);
  const sites = new Set();
  for (const { sites: candidates } of subjects) {
    for (const site of candidates) {
      const observation = matchObservations(site, index);
      if (observation.complete && observation.observed.size < index.tests.size) sites.add(site.id);
    }
  }
  return sites;
}

function indexFocusedCoverage(trace, sites) {
  const coverage = new Map();
  for (const row of trace) {
    if (!sites.has(row?.hit)) continue;
    let counts = coverage.get(row.hit);
    if (!counts) coverage.set(row.hit, counts = new Map());
    const key = row.identity ? identity(row.identity) : null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return coverage;
}

export function matchesFocusedCoverage(observed, counts) {
  if (!observed.size || counts?.size !== observed.size) return false;
  for (const [test, hits] of counts) {
    if (observed.get(test)?.length !== hits) return false;
  }
  return true;
}

function leanSkips(trials, baseline, deterministic, coverage) {
  if (!deterministic || baseline.tests.some(test => test.retry || test.repeats || test.concurrent)) return new Set();
  const requests = [];
  const indices = [];
  for (const [index, trial] of trials.entries()) {
    const { site, rule, observation } = trial;
    if (!observation.complete) continue;
    if (observation.observed.size !== observation.tests.size &&
        !matchesFocusedCoverage(observation.observed, coverage.get(site.id))) continue;
    const literal = rule === 'comparison-threshold/v1' && trial.isLiteralThreshold === true;
    if (!literal && rule !== site.rule) continue;
    indices.push(index);
    requests.push({
      candidate: site.id, traceCandidate: site.id, complete: true, deterministic,
      original: site.operator,
      replacement: literal ? { [literalKey[site.operator]]: Number(trial.replacement) } : trial.replacement,
      observations: observation.rows.map(row => row.operands),
    });
  }
  const accepted = checkReplay(requests);
  return new Set(indices.filter((_, position) => accepted?.[position] === true));
}

function diagnose(trial, result) {
  if (result.status !== 'survived' || !trial.observation.complete) return null;
  const { site, threshold, observation } = trial;
  function values(lhs, rhs) {
    const original = compare(site.operator, lhs, rhs);
    const mutant = trial.adjustment !== undefined ? compare(site.operator, lhs, rhs + trial.adjustment)
      : compare(trial.replacement, lhs, rhs);
    return { original, mutant };
  }
  const differs = ([lhs, rhs]) => {
    const { original, mutant } = values(lhs, rhs);
    return original !== mutant;
  };
  const tests = [...observation.observed].filter(([, operands]) => operands.some(differs))
    .map(([key]) => testcase(observation.tests.get(key)));
  if (tests.length) {
    const example = trial.adjustment !== undefined ? observation.rows.find(row => differs(row.operands)).operands : undefined;
    return { kind: 'ASSERTION GAP', site: site.id, location: site.location, tests,
      example: example && { operands: example, ...values(...example) } };
  }
  const binary = observation.rows[0]?.operands;
  if (!binary) return null;
  const gap = trial.rule === 'comparison-threshold/v1' ? trial.thresholdGap : null;
  const input = gap?.witness ?? binary[1] + (trial.adjustment ?? 0);
  const comparison = values(input, binary[1]);
  const expected = gap?.expected ?? comparison.original;
  const mutant = gap?.mutant ?? comparison.mutant;
  const constantThreshold = threshold && threshold.meta.threshold === binary[1];
  const specified = constantThreshold && threshold.specified &&
    input >= (threshold.contract.min ?? Number.MIN_SAFE_INTEGER) && input <= (threshold.contract.max ?? Number.MAX_SAFE_INTEGER);
  return {
    kind: 'INPUT GAP', site: site.id, location: site.location,
    witness: {
      input: constantThreshold ? input : undefined, operands: [input, binary[1]], original: expected, mutant,
      expectation: specified ? 'specification' : constantThreshold ? 'original' : 'hypothetical-operands',
    },
    observedInputs: constantThreshold ? [...new Set(threshold.inputs)].sort((a, b) => a - b) : undefined,
    suggestedTest: constantThreshold ? `expect(${threshold.meta.functionName}(${input})).toBe(${expected})` : undefined,
    feasibleThresholds: gap?.interval ?? trial.thresholdGap?.interval ?? (constantThreshold ? threshold.gap?.interval : undefined),
  };
}

function verifyVitestWitness(root, attempt, baseline, trial, gap) {
  const testFile = baseline.tests.find(test => test.status === 'passed').file;
  try {
    inside(root, testFile);
  } catch {
    return { baselineWithWitness: 'unconfirmed', rewriteWithWitness: 'unconfirmed' };
  }
  const target = relative(dirname(testFile), trial.site.location.file).split(sep).join('/');
  const modulePath = target.startsWith('../') ? target : './' + target;
  const key = trial.site.id.slice(0, 20);
  const testName = 'TMT generated threshold witness ' + key;
  const { functionName } = trial.threshold.meta;
  const { input, original } = gap.witness;
  const witness = {
    appendTo: testFile, testName,
    source: `
import { expect as __tmtExpect_${key}, it as __tmtIt_${key} } from 'vitest';
import { ${functionName} as __tmtSubject_${key} } from ${JSON.stringify(modulePath)};
__tmtIt_${key}(${JSON.stringify(testName)}, () => __tmtExpect_${key}(__tmtSubject_${key}(${input})).toBe(${original}));
`,
  };
  const originalRun = attempt({ witness });
  const changedRun = attempt({ witness, trial });
  return verifyWitnessRuns(baseline, originalRun, changedRun);
}

function playwrightSummary(run) {
  return { attempt: run.attempt, runnerPid: run.runnerPid, serverPid: run.serverPid, status: run.status,
    tests: run.tests?.map(test => ({ ...testcase(test), browser: test.browser, worker: test.worker, status: test.status })) };
}

function witnessCases(baseline, run) {
  const isWitness = test => test.file === run.witnessFile && (!run.witnessName || test.name === run.witnessName);
  const witnesses = run.tests?.filter(isWitness);
  const original = run.tests?.filter(test => !isWitness(test));
  if (!witnesses?.length || original.some(test => !['passed', 'skipped'].includes(test.status)) ||
      verdict({ status: 'passed', tests: original }, baseline) !== 'survived') return [];
  return witnesses;
}

function verifyWitnessRuns(baseline, original, changed) {
  const passed = witnessCases(baseline, original);
  const failed = witnessCases(baseline, changed);
  const baselineAccepted = original.status === 'passed' && passed.length > 0 && passed.every(test => test.status === 'passed');
  const matching = baselineAccepted && changed.status === 'failed' && failed.length === passed.length &&
    failed.some(test => test.status === 'failed') &&
    verdict({ status: 'failed', tests: failed }, { tests: passed }) === 'killed';
  return {
    baselineWithWitness: baselineAccepted ? 'passed' : 'unconfirmed',
    rewriteWithWitness: matching ? 'failed' : 'unconfirmed',
  };
}

function analyzePlaywright(root, subjects, report, options, specification) {
  const runner = (workspace, temp) => runPlaywright(workspace, temp, { config: options.config, projects: options.project, original: root,
    tests: options.test, ...(options.timeout ? { timeout: options.timeout * 1000 } : {}) });
  const probeChecks = new Map(subjects.map(subject => [subject, createProbePreloadCheck(subject.input)]));
  const attempt = settings => makeAttempt(root, subjects, runner, options['copy-exclude'], probeChecks, settings);
  const baseline = attempt();
  report.baseline = playwrightSummary(baseline);
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error',
      baseline: { ...report.baseline, output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline) } };
  }

  report.evaluation = 'evaluated';
  Object.defineProperty(report, baselineRunSymbol, { value: { status: baseline.status, tests: baseline.tests, plain: true }, enumerable: false });
  report.instrumented = { status: 'unavailable', reason: 'browser-observations-unavailable' };
  for (const subject of subjects) {
    for (const site of subject.sites) {
      const trial = { site, edit: site.edit, replacement: site.replacement, source: site.source };
      const mutant = attempt({ trial });
      const result = {
        site: site.id, location: site.location, rule: site.rule, operator: site.operator, original: site.original, edit: site.edit,
        replacement: site.replacement, status: verdict(mutant, baseline), evidence: 'reexecuted', run: playwrightSummary(mutant),
      };
      if (result.status === 'killed') result.tests = mutant.tests.filter(test => test.status === 'failed').map(testcase);
      if (options.audit) {
        const replay = attempt({ trial });
        const replayed = verdict(replay, baseline);
        const agrees = ['killed', 'survived'].includes(replayed) && replayed === result.status;
        result.audit = { status: agrees ? 'agreed' : 'mismatch', source: replayed, run: playwrightSummary(replay) };
        if (!agrees && ['killed', 'survived'].includes(result.status)) result.status = 'unstable';
      }
      report.mutants.push(result);
      if (result.status === 'error') report.evaluation = 'incomplete';

      const match = Array.isArray(specification.playwright) && specification.playwright.find(entry =>
        entry.file === subject.file && entry.operator === site.operator && entry.rule === site.rule &&
        (entry.line === undefined || entry.line === site.location.line));
      if (result.status === 'survived' && match?.witness && typeof match.requirement === 'string') {
        const witness = {
          content: match.witness, name: 'tmt-witness-' + randomUUID() + '.spec.ts',
          directory: match.witnessDirectory ?? dirname(baseline.tests.find(test => test.status === 'passed').file),
        };
        const original = attempt({ witness });
        const changed = attempt({ witness, trial });
        report.diagnostics.push({
          kind: 'SURVIVED', site: site.id, location: site.location, requirement: match.requirement, suggestedTestFile: match.witness,
          verification: verifyWitnessRuns(baseline, original, changed),
        });
      }
    }
  }
  return report;
}

function definitive(status) {
  return status === 'killed' || status === 'survived';
}

export function focusedAuditStatus(source, probe, predicted, status) {
  if (!definitive(source)) return 'inconclusive';
  if ((predicted && source !== 'survived') || (definitive(probe) && source !== probe)) return 'mismatch';
  if (source === status && (probe === null ? predicted : definitive(probe))) return 'agreed';
  return 'inconclusive';
}

// The whole focused analysis in one call.
export function analyze(project, files, options) {
  const prepared = prepareAnalysis(project, files, options);
  return prepared.trials ? completeAnalysis(prepared) : prepared.report;
}

// Everything up to the planned trials: extraction, the baseline and the recorded comparisons.
// Returns { report } when the analysis already ended there.
export function prepareAnalysis(project, files, options) {
  const root = realpathSync(project);
  const { subjects, extraction } = collectComparisons(root, files, options);
  const report = { schemaVersion: 1, runner: options.runner ?? 'vitest', extraction, mutants: [], diagnostics: [], evaluation: 'no_sites' };
  if (['targeted', 'full'].includes(options.mutators)) report.mutators = options.mutators;
  if (options.config !== undefined || options.test?.length || options['copy-exclude']?.length) {
    report.selection = { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] };
  }
  if (!subjects.length) return { report };

  const specification = options.spec ? JSON.parse(readFileSync(inside(root, options.spec), 'utf8')) : {};
  if (report.runner === 'playwright') return { report: analyzePlaywright(root, subjects, report, options, specification) };
  const runner = (workspace, temp, settings) => runVitest(workspace, temp, {
    ...settings, config: options.config, testFiles: options.test, ...(options.timeout ? { timeout: options.timeout * 1000 } : {}),
  });
  const probeChecks = new Map(subjects.map(subject => [subject, createProbePreloadCheck(subject.input)]));
  const attempt = settings => makeAttempt(root, subjects, runner, options['copy-exclude'], probeChecks, settings);
  // Beside a session, which runs the suite on its own, the recording run stands for the baseline when it passes.
  // Otherwise the plain baseline runs first, so a failing suite is reported as before.
  const recorded = options.traceIsBaseline ? attempt({ tracing: true }) : null;
  const plainBaseline = recorded?.status === 'passed' ? null : attempt();
  const baseline = plainBaseline ?? { status: 'passed', tests: recorded.tests };
  if (baseline.status !== 'passed') {
    return { report: { ...report, evaluation: 'baseline_error', baseline: { status: baseline.status, output: baseline.output, errors: baseline.errors, failedTests: failedTests(baseline) } } };
  }
  report.baseline = { status: 'passed', tests: baseline.tests.length };
  if (plainBaseline) {
    Object.defineProperty(report, baselineRunSymbol, { value: { status: plainBaseline.status, tests: plainBaseline.tests, plain: true }, enumerable: false });
  }

  const traced = recorded?.status === 'passed' ? recorded : attempt({ tracing: true });
  const tracedStatus = verdict(traced, baseline);
  report.instrumented = { status: tracedStatus === 'survived' ? 'passed' : tracedStatus };
  let trace = tracedStatus === 'survived' ? traced.trace : null;
  let coverage = new Map();
  if (trace && (options.deterministic || options.audit)) {
    const coverageSites = options.deterministic ? sitesForIndependentCoverage(subjects, trace, baseline) : new Set();
    const replay = attempt({ tracing: true, coverageSites, synchronousTrace: traced.synchronousTrace });
    report.instrumented.stable = verdict(replay, baseline) === 'survived' && sameObservations(trace, replay.trace);
    if (!report.instrumented.stable) trace = null;
    else if (coverageSites.size) coverage = indexFocusedCoverage(replay.trace, coverageSites);
  }

  const trials = planFocusedTrials(subjects, trace, baseline, specification, options['displace-thresholds']);
  const skips = leanSkips(trials, baseline, !!options.deterministic, coverage);
  return { root, report, options, attempt, baseline, traced, trace, trials, skips };
}

// Runs the planned trials. `settled` answers a trial that another run already decided: it returns
// { status, tests } for the same edit, or nothing when this analysis has to run the edit itself.
export function completeAnalysis({ root, report, options, attempt, baseline, traced, trace, trials, skips }, settled = () => undefined) {
  report.evaluation = 'evaluated';

  for (const [index, trial] of trials.entries()) {
    const predicted = skips.has(index);
    const { site } = trial;
    const result = {
      site: site.id, location: site.location, rule: trial.rule, operator: site.operator, original: site.original,
      edit: trial.edit, replacement: trial.replacement, equivalentOnSafeIntegers: trial.equivalentOnSafeIntegers,
      status: predicted ? 'survived' : 'unevaluated', evidence: predicted ? 'predicted' : 'reexecuted',
    };
    let audit;
    if (!predicted || options.audit) {
      const known = options.audit ? undefined : settled(trial);
      const source = known ? null : attempt({ trial });
      const actual = known ? known.status : verdict(source, baseline);
      if (!predicted) {
        result.status = actual;
        if (actual === 'killed') result.tests = known ? known.tests : source.tests.filter(test => test.status === 'failed').map(testcase);
      }

      if (options.audit) {
        const focused = trial.rule === site.rule && trace && trial.observation.rows.length
          ? attempt({ tracing: true, activate: site.id, synchronousTrace: traced.synchronousTrace }) : null;
        const activation = focused?.trace?.some(row => row.site === site.id && row.operator === site.replacement);
        audit = { source: actual, probe: focused ? (activation ? verdict(focused, baseline) : 'unevaluated') : null };
      }
    }

    // Operator edits are never traced, so reach is unknown and a surviving run stands as survived.
    if (result.status === 'survived' && !site.unobserved &&
        (report.instrumented.stable === false || trial.observation.rows.length === 0)) {
      result.sourceVerdict = 'survived';
      result.status = report.instrumented.stable === false ? 'unstable'
        : trial.observation.loaded ? 'unreached' : 'unevaluated';
    }
    if (audit) {
      const status = focusedAuditStatus(audit.source, audit.probe, predicted, result.status);
      result.audit = { status, ...audit };
      if (status === 'mismatch') result.status = 'unstable';
    }
    report.mutants.push(result);
    // The runner broke down in this trial, which is neither a kill nor a survivor: the analysis is not complete.
    if (result.status === 'error') report.evaluation = 'incomplete';
    const gap = diagnose(trial, result);
    if (gap) {
      if (options.audit && gap.suggestedTest) gap.verification = verifyVitestWitness(root, attempt, baseline, trial, gap);
      const duplicate = trial.adjustment === undefined && report.diagnostics.find(other => other.site === gap.site && other.kind === gap.kind &&
        (gap.kind === 'ASSERTION GAP' || gap.witness.operands.every((value, index) => value === other.witness.operands[index])));
      if (duplicate) {
        if (gap.tests) {
          const existing = new Set(duplicate.tests.map(identity));
          duplicate.tests.push(...gap.tests.filter(test => !existing.has(identity(test))));
        }
        duplicate.mutations.push({ rule: result.rule, edit: result.edit, replacement: result.replacement, evidence: result.evidence });
      } else {
        report.diagnostics.push({ ...gap, mutations: [{ rule: result.rule, edit: result.edit, replacement: result.replacement, evidence: result.evidence }] });
      }
    }
  }
  return report;
}
