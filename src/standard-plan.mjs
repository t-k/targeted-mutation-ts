import { resolve } from 'node:path';

export function indexCoverage(records, tests) {
  const plans = new Map();
  function entry(id) {
    let plan = plans.get(id);
    if (!plan) {
      plan = { hits: 0, staticHits: 0, unknown: false, perTestHits: new Map() };
      plans.set(id, plan);
    }
    return plan;
  }
  for (const { coverage } of records) {
    if (!coverage) continue;
    for (const [id, hits] of Object.entries(coverage.static ?? {})) {
      if (hits) entry(id).staticHits += hits;
    }
    for (const [testId, mutations] of Object.entries(coverage.perTest ?? {})) {
      const unknown = !tests.has(testId);
      for (const [id, hits] of Object.entries(mutations)) {
        if (!hits) continue;
        const plan = entry(id);
        plan.hits += hits;
        plan.unknown ||= unknown;
        plan.perTestHits.set(testId, (plan.perTestHits.get(testId) ?? 0) + hits);
      }
    }
  }
  for (const [id, { hits, staticHits, unknown, perTestHits }] of plans) {
    plans.set(id, { hits: hits + staticHits, staticActivation: staticHits > 0 || unknown,
      covered: new Set(perTestHits.keys()), perTestHits });
  }
  return id => plans.get(String(id)) ?? { hits: 0, staticActivation: false, covered: new Set(), perTestHits: new Map() };
}

export function coveredTests(id, records, tests) {
  return indexCoverage(records, tests)(id);
}

export function agreesWithCoverage(rows, plan) {
  if (!rows || plan.staticActivation || rows.length !== plan.hits) return false;
  const rowCounts = new Map();
  for (const [id] of rows) rowCounts.set(id, (rowCounts.get(id) ?? 0) + 1);
  return rowCounts.size === plan.covered.size &&
    [...rowCounts].every(([id, hits]) => plan.perTestHits.get(id) === hits);
}

export function assessTrial(trial, expectedTests, hitLimit) {
  const { errors, reason } = trial.snapshot;
  const moduleKey = test => JSON.stringify([test.project, test.file]);
  const failed = trial.snapshot.tests.filter(test => test.status === 'failed');
  const actualPassed = new Set(trial.snapshot.tests.filter(test => test.status === 'passed').map(test => test.id));
  const registered = new Set(trial.snapshot.tests.map(test => test.id));
  const collectedModules = new Set(trial.snapshot.tests.map(moduleKey));
  const hitCount = trial.records.reduce((sum, row) => sum + row.hits, 0);
  if (hitCount > hitLimit || failed.some(test => test.timeout)) {
    return { status: 'timeout', statusReason: hitCount > hitLimit ? 'Mutation hit limit reached' : 'Vitest test timeout' };
  }
  if (errors.length) return { status: 'error', statusReason: errors.join('\n') };
  if (hitCount > 0 && ['failed', 'interrupted'].includes(reason) && failed.length &&
      failed.every(test => expectedTests.has(test.id)) && [...expectedTests].every(([id, test]) =>
        registered.has(id) || reason === 'interrupted' && !collectedModules.has(moduleKey(test)))) {
    return { status: 'killed', tests: failed.map(({ id, name, file, project }) => ({ id, name, file, project })) };
  }
  if (hitCount > 0 && reason === 'passed' && !failed.length && [...expectedTests.keys()].every(id => actualPassed.has(id))) {
    return { status: 'survived' };
  }
  return { status: 'unstable', statusReason: 'Vitest did not observe the active mutation with the expected test inventory' };
}

// Splits each pending mutation over the test files that reach it. A test file runs its share inside one worker.
// Returns null when the baseline did not report exactly one record per test file.
export function planInThread(records, tests, pending, workspace) {
  const modules = new Map();
  for (const record of records) {
    if (record.modules?.length !== 1) return null;
    const [project, file] = record.modules[0];
    const key = JSON.stringify([project, file]);
    if (modules.has(key)) return null;
    const own = new Map([...tests].filter(([, test]) => test.project === project && resolve(workspace, test.file) === file));
    modules.set(key, { coverage: indexCoverage([record], own), total: own.size });
  }
  const plans = {};
  for (const { mutant, plan } of pending) {
    for (const [key, { coverage, total }] of modules) {
      const local = coverage(mutant.id);
      if (!local.hits) continue;
      (plans[key] ??= []).push({ id: mutant.id, hits: local.hits, hitLimit: plan.hits * 100, static: local.staticActivation, total,
        ...(local.staticActivation ? {} : { tests: [...local.covered] }) });
    }
  }
  return plans;
}

function classify(plan, event) {
  if (!event) return 'open';
  if (event.stuck) return 'timeout';
  if (event.unhandled || event.errors?.length) return 'open';
  if (event.hits > plan.hitLimit || event.timeout) return 'timeout';
  if (event.hits > 0 && event.failed.length) return 'killed';
  if (event.hits > 0 && event.passed === event.expected) return 'survived';
  return 'open';
}

// A mutation is settled when one test file killed it, or when every test file that reaches it answered.
// The others are left for an isolated run.
export function settleInThread(plans, events, tests) {
  const answers = new Map(events.filter(event => event.id !== undefined).map(event => [JSON.stringify([event.module, event.id]), event]));
  const parts = new Map();
  for (const [module, list] of Object.entries(plans)) {
    for (const plan of list) {
      const event = answers.get(JSON.stringify([module, plan.id]));
      if (!parts.has(plan.id)) parts.set(plan.id, []);
      parts.get(plan.id).push({ verdict: classify(plan, event), event });
    }
  }
  const settled = new Map();
  for (const [id, list] of parts) {
    const killers = list.filter(part => part.verdict === 'killed').flatMap(part => part.event.failed);
    if (killers.length) {
      settled.set(id, { status: 'killed', tests: killers.map(test => tests.get(test)).filter(Boolean)
        .map(({ id: test, name, file, project }) => ({ id: test, name, file, project })) });
    } else if (list.some(part => part.verdict === 'open')) continue;
    else if (list.some(part => part.verdict === 'timeout')) {
      settled.set(id, { status: 'timeout', statusReason: list.some(part => part.event.stuck) ? 'The worker stopped answering'
        : list.some(part => part.event.timeout) ? 'Vitest test timeout' : 'Mutation hit limit reached' });
    } else settled.set(id, { status: 'survived' });
  }
  return settled;
}

// Cuts the plan into near-equal shares, one per lane. A test file's list stays together unless it crosses a cut.
export function sharePlans(plans, count) {
  const entries = Object.entries(plans).flatMap(([module, list]) => list.map(plan => [module, plan]));
  const lanes = Math.max(1, Math.min(count, entries.length));
  const size = Math.ceil(entries.length / lanes);
  const shares = [];
  for (let start = 0; start < entries.length; start += size) {
    const share = {};
    for (const [module, plan] of entries.slice(start, start + size)) (share[module] ??= []).push(plan);
    shares.push(share);
  }
  return shares;
}
