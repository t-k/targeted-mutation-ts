export function coveredTests(id, records, tests) {
  let staticHits = 0;
  let hits = 0;
  let unknown = false;
  const covered = new Set();
  for (const { coverage } of records) {
    if (!coverage) continue;
    staticHits += coverage.static?.[id] ?? 0;
    for (const [testId, mutations] of Object.entries(coverage.perTest ?? {})) {
      if (!mutations[id]) continue;
      hits += mutations[id];
      covered.add(testId);
      if (!tests.has(testId)) unknown = true;
    }
  }
  return { hits: hits + staticHits, staticActivation: staticHits > 0 || unknown, covered };
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
