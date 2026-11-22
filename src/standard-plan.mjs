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
