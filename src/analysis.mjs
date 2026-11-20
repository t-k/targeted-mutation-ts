import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { byteOffsets, extract } from './extract.mjs';
import { thresholdSites } from './prototype.mjs';
import { thresholdGap } from './threshold.mjs';
import { tightenComparison } from './displacement.mjs';
import { inside, runVitest, withCopy } from './vitest.mjs';
import { instrument, installProbe, rewrite } from './probe.mjs';
import { runPlaywright } from './playwright.mjs';
import { selectScope } from './scope.mjs';
import { checkReplay } from './lean-replay.mjs';

const sha = source => createHash('sha256').update(source).digest('hex');
const identity = test => JSON.stringify([test.project, test.file, test.id]);
const testcase = ({ id, project, file, name }) => ({ id, project, file, name });

function compare(operator, left, right) {
  switch (operator) {
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
  }
}

function lineAt(source, offset) {
  const lines = source.subarray(0, offset).toString().split(/\r\n|[\n\r\u2028\u2029]/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

export function collectComparisons(root, files, options) {
  const subjects = [];
  const extraction = [];
  for (const { file, selected } of selectScope(root, files, options)) {
    const input = readFileSync(inside(root, file));
    const { path, reason, candidates, diagnostics } = extract(input, { file, mode: options.mode, dialect: options.dialect, requireNative: true, logical: options.runner === 'playwright' });
    extraction.push({ file, path, reason, diagnostics });
    if (path === 'diagnostic') continue;
    const digest = sha(input);
    const sites = candidates.flatMap(candidate => {
      const [start, end] = candidate.operatorEdit ?? candidate.edit;
      const location = { file, ...lineAt(input, start), start, end };
      if (!selected(location.line)) return [];
      return [{ ...candidate, location, id: sha(JSON.stringify([
        file, digest, options.mode ?? 'module', options.dialect ?? (file.endsWith('.tsx') ? 'tsx' : 'ts'),
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

function traceFrom(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return null;
  }
}

function makeAttempt(root, subjects, runner, copyExclude, { tracing = false, activate, trial, witness } = {}) {
  return withCopy(root, (workspace, temp) => {
    const trace = tracing ? resolve(temp, 'trace.jsonl') : undefined;
    if (tracing) installProbe(workspace);
    for (const subject of subjects) {
      const file = inside(workspace, subject.file);
      if (sha(readFileSync(file)) !== subject.digest) throw new Error(`Source changed during analysis: ${subject.file}`);
      if (tracing) writeFileSync(file, instrument(workspace, subject.file, subject.input, subject.sites));
      else if (trial?.site.location.file === subject.file) writeFileSync(file, rewrite(subject.input, trial.edit, trial.replacement));
    }
    let witnessFile;
    if (witness?.appendTo) {
      const path = inside(workspace, witness.appendTo);
      appendFileSync(path, witness.source);
      witnessFile = relative(workspace, path);
    } else if (witness) {
      const folder = inside(workspace, witness.directory);
      const path = resolve(folder, witness.name);
      writeFileSync(path, readFileSync(inside(workspace, witness.content)), { flag: 'wx' });
      witnessFile = relative(workspace, path);
    }
    const result = runner(workspace, temp, { trace, active: activate, product: true });
    return tracing ? { ...result, trace: traceFrom(trace) } : { ...result, witnessFile, witnessName: witness?.testName };
  }, { exclude: copyExclude });
}

function matchObservations(site, trace, baseline) {
  const all = baseline.tests.filter(test => test.status === 'passed');
  const tests = new Map(all.map(test => [identity(test), test]));
  const rows = trace?.filter(row => row.site === site.id) ?? [];
  const loaded = trace?.some(row => row.loaded?.includes(site.id)) ?? false;
  const observed = new Map();
  let complete = trace !== null && rows.length > 0;
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
  return { observed, rows, complete, tests, loaded };
}

function callableThreshold(subject, site, observations, specification) {
  if (!observations.complete ||
      !/^-?\s*\d+$/.test(subject.input.subarray(...site.right).toString())) return null;
  const source = subject.input.toString();
  const offsets = byteOffsets(source);
  const meta = thresholdSites(source, subject.file, site.operator).find(entry =>
    offsets[entry.from] === site.left[0] && offsets[entry.literalFrom] === site.right[0] && offsets[entry.literalTo] === site.right[1]);
  if (!meta || observations.rows.some(row => row.operands[1] !== meta.threshold)) return null;
  const contract = Object.hasOwn(specification, meta.functionName) ? specification[meta.functionName] : null;
  const specified = contract?.operator === site.operator && contract.threshold === meta.threshold &&
    typeof contract.rationale === 'string' && contract.rationale.trim().length > 0;
  const inputs = observations.rows.map(row => row.operands[0]);
  const gap = site.operator === '>='
    ? thresholdGap(meta.threshold, inputs, specified ? contract.min : undefined, specified ? contract.max : undefined)
    : null;
  return { meta, gap, specified, inputs, contract };
}

function plan(subjects, trace, baseline, specification, displaceThresholds) {
  const trials = [];
  for (const subject of subjects) {
    for (const site of subject.sites) {
      const observation = matchObservations(site, trace, baseline);
      const threshold = site.operator === '>=' ? callableThreshold(subject, site, observation, specification) : null;
      const boundary = { site, edit: site.edit, replacement: site.replacement, rule: site.rule, observation, threshold };
      trials.push(boundary);
      if (threshold?.gap) {
        const alternate = String(threshold.gap.alternate);
        if (threshold.gap.alternate === threshold.meta.threshold + 1) {
          boundary.equivalentOnSafeIntegers = [`>= ${alternate}`];
        } else {
          trials.push({ site, edit: site.right, replacement: alternate, rule: 'comparison-threshold/v1', observation, threshold });
        }
      }
      const tightened = tightenComparison(subject.input, site, observation, displaceThresholds);
      if (tightened) trials.push({
        ...tightened, threshold: callableThreshold(subject, site, observation, specification),
      });
    }
  }
  return trials;
}

function leanSkips(trials, baseline, deterministic) {
  if (!deterministic || baseline.tests.some(test => test.retry || test.repeats || test.concurrent)) return new Set();
  const requests = [];
  const indices = [];
  for (const [index, trial] of trials.entries()) {
    const { site, rule, observation } = trial;
    if (rule !== site.rule || !observation.complete || observation.observed.size !== observation.tests.size) continue;
    for (const operands of observation.observed.values()) {
      indices.push(index);
      requests.push({
        candidate: site.id, traceCandidate: site.id, complete: true, deterministic,
        original: site.operator, replacement: trial.replacement, observations: operands,
      });
    }
  }
  const accepted = checkReplay(requests);
  if (!accepted) return new Set();
  const rejected = new Set(indices.filter((_, index) => accepted[index] !== true));
  return new Set(indices.filter(index => !rejected.has(index)));
}

function diagnose(trial, result) {
  if (result.status !== 'survived' || !trial.observation.complete) return null;
  const { site, threshold, observation } = trial;
  function values(lhs, rhs) {
    const original = compare(site.operator, lhs, rhs);
    const mutant = trial.adjustment !== undefined ? compare(site.operator, lhs, rhs + trial.adjustment)
      : trial.rule === 'comparison-threshold/v1' ? lhs >= Number(trial.replacement)
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
  const gap = trial.rule === 'comparison-threshold/v1' ? threshold.gap : null;
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
    feasibleThresholds: gap?.interval ?? (constantThreshold ? threshold.gap?.interval : undefined),
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

function traceSignature(trace) {
  return trace && trace.map(row => JSON.stringify(row)).join('\n');
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
  const runner = (workspace, temp) => runPlaywright(workspace, temp, { config: options.config, projects: options.project, original: root });
  const attempt = settings => makeAttempt(root, subjects, runner, options['copy-exclude'], settings);
  const baseline = attempt();
  report.baseline = playwrightSummary(baseline);
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error', baseline: { ...report.baseline, output: baseline.output } };
  }

  report.evaluation = 'evaluated';
  report.instrumented = { status: 'unavailable', reason: 'browser-observations-unavailable' };
  for (const subject of subjects) {
    for (const site of subject.sites) {
      const trial = { site, edit: site.edit, replacement: site.replacement };
      const mutant = attempt({ trial });
      const result = {
        site: site.id, location: site.location, rule: site.rule, operator: site.operator, edit: site.edit,
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

export function analyze(project, files, options) {
  const root = realpathSync(project);
  const { subjects, extraction } = collectComparisons(root, files, options);
  const report = { schemaVersion: 1, runner: options.runner ?? 'vitest', extraction, mutants: [], diagnostics: [], evaluation: 'no_sites' };
  if (options.config !== undefined || options.test?.length || options['copy-exclude']?.length) {
    report.selection = { config: options.config, tests: options.test, copyExclude: options['copy-exclude'] };
  }
  if (!subjects.length) return report;

  const specification = options.spec ? JSON.parse(readFileSync(inside(root, options.spec), 'utf8')) : {};
  if (report.runner === 'playwright') return analyzePlaywright(root, subjects, report, options, specification);
  const runner = (workspace, temp, settings) => runVitest(workspace, temp, {
    ...settings, config: options.config, testFiles: options.test,
  });
  const attempt = settings => makeAttempt(root, subjects, runner, options['copy-exclude'], settings);
  const baseline = attempt();
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error', baseline: { status: baseline.status, output: baseline.output, errors: baseline.errors } };
  }
  report.baseline = { status: 'passed', tests: baseline.tests.length };

  const traced = attempt({ tracing: true });
  const tracedStatus = verdict(traced, baseline);
  report.instrumented = { status: tracedStatus === 'survived' ? 'passed' : tracedStatus };
  let trace = tracedStatus === 'survived' ? traced.trace : null;
  if (trace && (options.deterministic || options.audit)) {
    const replay = attempt({ tracing: true });
    report.instrumented.stable = verdict(replay, baseline) === 'survived' && traceSignature(trace) === traceSignature(replay.trace);
    if (!report.instrumented.stable) trace = null;
  }

  const trials = plan(subjects, trace, baseline, specification, options['displace-thresholds']);
  const skips = leanSkips(trials, baseline, !!options.deterministic);
  report.evaluation = 'evaluated';

  for (const [index, trial] of trials.entries()) {
    const predicted = skips.has(index);
    const { site } = trial;
    const result = {
      site: site.id, location: site.location, rule: trial.rule, operator: site.operator,
      edit: trial.edit, replacement: trial.replacement, equivalentOnSafeIntegers: trial.equivalentOnSafeIntegers,
      status: predicted ? 'survived' : 'unevaluated', evidence: predicted ? 'predicted' : 'reexecuted',
    };
    if (!predicted || options.audit) {
      const source = attempt({ trial });
      const actual = verdict(source, baseline);
      if (!predicted) {
        result.status = actual;
        if (actual === 'killed') result.tests = source.tests.filter(test => test.status === 'failed').map(testcase);
      }

      if (options.audit) {
        const probe = trial.rule === site.rule && tracedStatus === 'survived'
          ? verdict(attempt({ tracing: true, activate: site.id }), baseline) : null;
        const agrees = ['killed', 'survived'].includes(actual) && result.status === actual &&
          (probe === null || probe === actual);
        result.audit = { status: agrees ? 'agreed' : 'mismatch', source: actual, probe };
        if (!agrees && (predicted || probe !== null)) result.status = 'unstable';
      }
    }

    if (result.status === 'survived' && (report.instrumented.stable === false || trial.observation.rows.length === 0)) {
      result.sourceVerdict = 'survived';
      result.status = report.instrumented.stable === false ? 'unstable'
        : trial.observation.loaded ? 'unreached' : 'unevaluated';
    }
    report.mutants.push(result);
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
