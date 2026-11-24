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

// What the probes of the targeted rules recorded, per edit: the passing tests in which the edit would have given
// the same as the original every time, those in which it would not, those in which that is not known, and
// whether it would not, or that is not known, outside any of them (while a file loads, in a hook, in a test
// that did not pass).
export function indexAgreement(records, tests) {
  const merged = new Map();
  for (const { observed } of records) {
    for (const [id, entry] of Object.entries(observed ?? {})) {
      if (!merged.has(id)) merged.set(id, { agreeing: new Set(), differing: new Set(), unsure: new Set(), outside: false, outsideUnsure: false, typed: false, realCopy: false, nonArray: false, nonPlain: false, sequence: false, nonSequence: false, threw: false });
      const into = merged.get(id);
      for (const [test, [, differed, unknown = 0]] of Object.entries(entry.tests ?? {})) {
        if (!tests.has(test)) (into.outside ||= differed > 0, into.outsideUnsure ||= unknown > 0);
        else if (differed > 0) into.differing.add(test);
        else if (unknown > 0) into.unsure.add(test);
        else into.agreeing.add(test);
      }
      into.differ ??= entry.differ;
      into.agree ??= entry.agree;
      into.unknown ??= entry.unsure;
      into.typed ||= entry.typed === true;
      into.realCopy ||= entry.realCopy === true;
      into.nonArray ||= entry.nonArray === true;
      into.nonPlain ||= entry.nonPlain === true;
      into.sequence ||= entry.sequence === true;
      into.nonSequence ||= entry.nonSequence === true;
      into.threw ||= entry.threw === true;
    }
  }
  // A test belongs to the strongest of what it saw, over all the files that recorded it.
  for (const into of merged.values()) {
    for (const test of into.differing) (into.unsure.delete(test), into.agreeing.delete(test));
    for (const test of into.unsure) into.agreeing.delete(test);
  }
  return merged;
}

// Which switches each passing test reached in the baseline, and which each test file reached while it loaded.
export function indexReach(records) {
  const byTest = new Map();
  const whileLoading = new Map();
  for (const { modules = [], coverage } of records) {
    const loaded = Object.entries(coverage?.static ?? {}).filter(([, hits]) => hits).map(([id]) => id);
    for (const module of modules) whileLoading.set(JSON.stringify(module), new Set(loaded));
    for (const [test, counts] of Object.entries(coverage?.perTest ?? {})) {
      if (!byTest.has(test)) byTest.set(test, new Set());
      for (const [id, hits] of Object.entries(counts)) if (hits) byTest.get(test).add(id);
    }
  }
  return { byTest, whileLoading };
}

// What a surviving edit changed in the code its tests run: per test, the switches it reaches only with the edit
// and those it reached only without it. `runs` holds, per test file, what each test reached with the edit
// (under an empty name: while the file loaded).
export function changedReach({ byTest, whileLoading }, runs, limit = 8) {
  const now = [];
  const gone = [];
  for (const { module, reached } of runs) {
    for (const [test, ids] of Object.entries(reached)) {
      const before = (test === '' ? whileLoading.get(module) : byTest.get(test)) ?? new Set();
      const after = new Set(ids);
      for (const id of after) if (!before.has(id)) now.push({ test, id });
      // A trial runs only the tests that reach the edit, so the hooks of the others do not run: what is missing
      // outside the tests says nothing about the edit.
      if (test !== '') for (const id of before) if (!after.has(id)) gone.push({ test, id });
    }
  }
  return { now: now.slice(0, limit), gone: gone.slice(0, limit) };
}

// The same from the records of a fresh run of the given tests: per test file, what each test reached.
export function reachOfRecords(records, tests) {
  const runs = records.flatMap(({ modules = [], coverage }) => modules.map(module => ({ module: JSON.stringify(module), reached: {
    ...Object.fromEntries(Object.entries(coverage?.perTest ?? {}).map(([test, counts]) => [test, Object.keys(counts).filter(id => counts[id])])),
    '': Object.keys(coverage?.static ?? {}).filter(id => coverage.static[id]) } })));
  const seen = new Set(runs.flatMap(({ reached }) => Object.keys(reached)));
  // A test that ran and reached no switch at all is listed with none.
  return [...runs, { module: null, reached: Object.fromEntries([...tests].filter(test => !seen.has(test)).map(test => [test, []])) }];
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
  if (errors.length) {
    if (hitCount > 0) {
      const killerTests = failed.length
        ? failed.map(({ id, name, file, project }) => ({ id, name, file, project }))
        : [...expectedTests.values()].map(({ id, name, file, project }) => ({ id, name, file, project }));
      return { status: 'killed', killedBy: 'unhandled-error', tests: killerTests, statusReason: errors.join('\n') };
    }
    return { status: 'error', statusReason: errors.join('\n') };
  }
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
export function planInThread(records, tests, pending, workspace, timing = { tests: {}, collection: {} }) {
  const modules = new Map();
  for (const record of records) {
    if (record.modules?.length !== 1) return null;
    const [project, file] = record.modules[0];
    const key = JSON.stringify([project, file]);
    if (modules.has(key)) return null;
    const own = new Map([...tests].filter(([, test]) => test.project === project && resolve(workspace, test.file) === file));
    modules.set(key, { coverage: indexCoverage([record], own), own: [...own.keys()] });
  }
  const plans = {};
  for (const { mutant, plan } of pending) {
    for (const [key, { coverage, own }] of modules) {
      // An extra trial has its own id and runs a switch that another entry may also use.
      const local = coverage(mutant.active ?? mutant.id);
      if (!local.hits) continue;
      // One run of this entry: loading the test file, then the tests it selects.
      const cost = (timing.collection[key] ?? 0) + (local.staticActivation ? own : [...local.covered])
        .reduce((sum, test) => sum + (timing.tests[test] ?? 0), 0);
      // A mutation that is active while the file loads runs every test of the file.
      (plans[key] ??= []).push({ id: mutant.id, hits: local.hits, hitLimit: plan.hits * 100, static: local.staticActivation, cost,
        tests: local.staticActivation ? own : [...local.covered],
        ...(mutant.active === undefined ? {} : { active: mutant.active, shift: mutant.shift }), ...(mutant.effects ? { effects: true } : {}) });
    }
  }
  return plans;
}

function classify(plan, event) {
  if (!event) return 'open';
  if (event.stuck) return 'timeout';
  if (event.stuckControl) return 'open';
  if (event.unhandled || event.errors?.length || event.foreign || event.missing) return 'open';
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

// Cuts each test file's list into parts of near-equal estimated cost, one part per lane. A lane runs its test
// files beside each other, so every lane gets a part of every file that is long enough to cut.
export function sharePlans(plans, count) {
  const shares = [];
  for (const [module, list] of Object.entries(plans)) {
    const lanes = Math.max(1, Math.min(count, list.length));
    const weight = plan => (plan.cost ?? 0) + 1;
    const total = list.reduce((sum, plan) => sum + weight(plan), 0);
    let spent = 0;
    for (const plan of list) {
      // An entry belongs to the lane in which its midpoint falls.
      const lane = Math.min(lanes - 1, Math.floor((spent + weight(plan) / 2) * lanes / total));
      spent += weight(plan);
      ((shares[lane] ??= {})[module] ??= []).push(plan);
    }
  }
  return [...shares].filter(Boolean);
}

// The first step runs each mutation only in the test file where it is cheapest. Most mutations are killed there,
// and the other test files then run only what is left.
export function cheapestFirst(plans) {
  const cheapest = new Map();
  for (const [module, list] of Object.entries(plans)) {
    for (const plan of list) {
      const best = cheapest.get(plan.id);
      if (!best || (plan.cost ?? 0) < (best.plan.cost ?? 0)) cheapest.set(plan.id, { module, plan });
    }
  }
  const first = {};
  const rest = {};
  for (const [module, list] of Object.entries(plans)) {
    for (const plan of list) ((cheapest.get(plan.id).module === module ? first : rest)[module] ??= []).push(plan);
  }
  return { first, rest };
}

// The plan without the entries of the given mutations.
export function withoutMutations(plans, ids) {
  return Object.fromEntries(Object.entries(plans).map(([module, list]) => [module, list.filter(plan => !ids.has(plan.id))])
    .filter(([, list]) => list.length));
}

// What the runs so far left for another one: entries without an answer. A test file whose control run differed
// starts again in a new worker without the mutation it stopped at, up to `restarts` times; after that its
// unanswered entries wait for fresh runs. A worker that hung has its mutation settled.
export function unanswered(plans, events, restarts = 0) {
  const stops = new Map();
  for (const event of events) {
    if (event.stop === undefined) continue;
    if (!stops.has(event.module)) stops.set(event.module, new Set());
    stops.get(event.module).add(event.stop);
  }
  const done = new Set(events.filter(event => event.id !== undefined).map(event => JSON.stringify([event.module, event.id])));
  return Object.fromEntries(Object.entries(plans).filter(([module]) => (stops.get(module)?.size ?? 0) <= restarts)
    .map(([module, list]) => [module, list.filter(plan => !done.has(JSON.stringify([module, plan.id])) && !stops.get(module)?.has(plan.id))])
    .filter(([, list]) => list.length));
}

// Why a worker left a mutation for a fresh run, for the report. The first reason found among its test files is given.
export function openReasons(plans, events) {
  const answers = new Map(events.filter(event => event.id !== undefined).map(event => [JSON.stringify([event.module, event.id]), event]));
  const stops = new Map();
  for (const event of events) {
    if (event.stop !== undefined) stops.set(event.module, (stops.get(event.module) ?? new Set()).add(event.stop));
  }
  const reasons = new Map();
  for (const [module, list] of Object.entries(plans)) {
    for (const plan of list) {
      if (reasons.has(plan.id)) continue;
      const event = answers.get(JSON.stringify([module, plan.id]));
      const reason = !event ? (stops.get(module)?.has(plan.id) ? 'control-differs' : stops.has(module) ? 'worker-stopped' : 'not-answered')
        : event.stuckControl ? 'control-hung'
          : event.stuck ? null
            : event.unhandled ? 'unhandled-error'
              : event.errors?.length ? 'error-outside-tests'
                : event.foreign || event.missing ? 'tests-changed'
                  : classify(plan, event) === 'open' ? 'inconclusive' : null;
      if (reason) reasons.set(plan.id, reason);
    }
  }
  return reasons;
}

// Evenly spaced picks from the mutations a worker settled, for checking them against fresh runs.
export function sampleSettled(ids, count) {
  if (!(count > 0) || !ids.length) return [];
  const step = Math.max(1, Math.floor(ids.length / count));
  return ids.filter((_, index) => index % step === 0).slice(0, count);
}
