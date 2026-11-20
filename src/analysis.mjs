import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteOffsets, extract } from './extract.mjs';
import { thresholdSites } from './prototype.mjs';
import { thresholdGap } from './threshold.mjs';
import { inside, runVitest, withCopy } from './vitest.mjs';
import { instrument, installProbe, rewrite } from './probe.mjs';
import { selectScope } from './scope.mjs';

const proof = fileURLToPath(new URL('../build/tmt-decide', import.meta.url));
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

function collect(root, files, options) {
  const subjects = [];
  const extraction = [];
  for (const { file, selected } of selectScope(root, files, options)) {
    const input = readFileSync(inside(root, file));
    const { path, reason, candidates, diagnostics } = extract(input, { file, mode: options.mode, dialect: options.dialect, requireNative: true });
    extraction.push({ file, path, reason, diagnostics });
    if (path === 'diagnostic') continue;
    const digest = sha(input);
    const sites = candidates.flatMap(candidate => {
      const location = { file, ...lineAt(input, candidate.edit[0]), start: candidate.edit[0], end: candidate.edit[1] };
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

function verdict(run, baseline) {
  if (!['passed', 'failed'].includes(run.status)) return run.status;
  const baselineTests = new Map(baseline.tests.map(test => [identity(test), test]));
  if (run.tests.length !== baselineTests.size || run.tests.some(test => {
    const original = baselineTests.get(identity(test));
    return !original || original.name !== test.name ||
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

function makeAttempt(root, subjects, { tracing = false, activate, trial, runner = runVitest } = {}) {
  return withCopy(root, (workspace, temp) => {
    const trace = tracing ? resolve(temp, 'trace.jsonl') : undefined;
    if (tracing) installProbe(workspace);
    for (const subject of subjects) {
      const file = inside(workspace, subject.file);
      if (sha(readFileSync(file)) !== subject.digest) throw new Error(`Source changed during analysis: ${subject.file}`);
      if (tracing) writeFileSync(file, instrument(workspace, subject.file, subject.input, subject.sites));
      else if (trial?.site.location.file === subject.file) writeFileSync(file, rewrite(subject.input, trial.edit, trial.replacement));
    }
    const result = runner(workspace, temp, { trace, active: activate, product: true });
    return tracing ? { ...result, trace: traceFrom(trace) } : result;
  });
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

function thresholdTrial(subject, site, observations, specification) {
  if (site.operator !== '>=' || !observations.complete ||
      !/^-?\s*\d+$/.test(subject.input.subarray(...site.right).toString())) return null;
  const source = subject.input.toString();
  const offsets = byteOffsets(source);
  const meta = thresholdSites(source, subject.file).find(entry =>
    offsets[entry.from] === site.left[0] && offsets[entry.literalFrom] === site.right[0] && offsets[entry.literalTo] === site.right[1]);
  if (!meta) return null;
  const contract = Object.hasOwn(specification, meta.functionName) ? specification[meta.functionName] : null;
  const specified = contract?.operator === '>=' && contract.threshold === meta.threshold &&
    typeof contract.rationale === 'string' && contract.rationale.trim().length > 0;
  const inputs = observations.rows.map(row => row.operands[0]);
  const gap = thresholdGap(meta.threshold, inputs, specified ? contract.min : undefined, specified ? contract.max : undefined);
  return { meta, gap, specified, inputs, contract };
}

function plan(subjects, trace, baseline, specification, enableThresholds) {
  const trials = [];
  for (const subject of subjects) {
    for (const site of subject.sites) {
      const observation = matchObservations(site, trace, baseline);
      const threshold = enableThresholds ? thresholdTrial(subject, site, observation, specification) : null;
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
    }
  }
  return trials;
}

function leanSkips(trials, baseline, deterministic) {
  if (!deterministic || !existsSync(proof) || baseline.tests.some(test => test.retry || test.repeats || test.concurrent)) return new Set();
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
  if (!requests.length) return new Set();
  const decision = spawnSync(proof, [], {
    encoding: 'utf8', input: JSON.stringify(requests), timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (decision.status !== 0) return new Set();
  try {
    const accepted = JSON.parse(decision.stdout);
    if (!Array.isArray(accepted) || accepted.length !== requests.length) return new Set();
    const rejected = new Set(indices.filter((_, index) => accepted[index] !== true));
    return new Set(indices.filter(index => !rejected.has(index)));
  } catch {
    return new Set();
  }
}

function diagnose(trial, result) {
  if (result.status !== 'survived' || !trial.observation.complete) return null;
  const { site, threshold, observation } = trial;
  const differs = trial.rule === site.rule
    ? ([lhs, rhs]) => compare(site.operator, lhs, rhs) !== compare(trial.replacement, lhs, rhs)
    : ([lhs, rhs]) => compare(site.operator, lhs, rhs) !== (lhs >= Number(trial.replacement));
  const tests = [...observation.observed].filter(([, operands]) => operands.some(differs))
    .map(([key]) => testcase(observation.tests.get(key)));
  if (tests.length) return { kind: 'ASSERTION GAP', site: site.id, location: site.location, tests };
  const binary = observation.rows[0]?.operands;
  if (!binary) return null;
  const gap = trial.rule !== site.rule ? threshold.gap : null;
  const input = gap?.witness ?? binary[1];
  const expected = gap?.expected ?? compare(site.operator, input, input);
  const mutant = gap?.mutant ?? compare(trial.replacement, input, input);
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

function traceSignature(trace) {
  return trace && trace.map(row => JSON.stringify(row)).join('\n');
}

export function analyze(project, files, options) {
  const root = realpathSync(project);
  const { subjects, extraction } = collect(root, files, options);
  const report = { schemaVersion: 1, runner: 'vitest', extraction, mutants: [], diagnostics: [], evaluation: 'no_sites' };
  if (!subjects.length) return report;

  const specification = options.spec ? JSON.parse(readFileSync(inside(root, options.spec), 'utf8')) : {};
  const baseline = makeAttempt(root, subjects);
  if (baseline.status !== 'passed') {
    return { ...report, evaluation: 'baseline_error', baseline: { status: baseline.status, output: baseline.output } };
  }
  report.baseline = { status: 'passed', tests: baseline.tests.length };

  const traced = makeAttempt(root, subjects, { tracing: true });
  const tracedStatus = verdict(traced, baseline);
  report.instrumented = { status: tracedStatus === 'survived' ? 'passed' : tracedStatus };
  let trace = tracedStatus === 'survived' ? traced.trace : null;
  if (trace && (options.deterministic || options.audit)) {
    const replay = makeAttempt(root, subjects, { tracing: true });
    report.instrumented.stable = verdict(replay, baseline) === 'survived' && traceSignature(trace) === traceSignature(replay.trace);
    if (!report.instrumented.stable) trace = null;
  }

  const trials = plan(subjects, trace, baseline, specification, true);
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
      const source = makeAttempt(root, subjects, { trial });
      const actual = verdict(source, baseline);
      if (!predicted) {
        result.status = actual;
        if (actual === 'killed') result.tests = source.tests.filter(test => test.status === 'failed').map(testcase);
      }

      if (options.audit) {
        const probe = trial.rule === site.rule && tracedStatus === 'survived'
          ? verdict(makeAttempt(root, subjects, { tracing: true, activate: site.id }), baseline) : null;
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
      const duplicate = report.diagnostics.find(other => other.site === gap.site && other.kind === gap.kind &&
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
