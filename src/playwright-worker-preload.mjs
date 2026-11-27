import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  createEmptyBucket,
  drainSpoolDirectory,
  mergeRealmSnapshots,
  writeAtomicJson,
} from './playwright-bridge.mjs';
import { runnerPackage } from './vitest.mjs';

const selfUrl = import.meta.url;
const selfFlag = `--import ${selfUrl}`;
if (process.env.NODE_OPTIONS?.includes(selfUrl)) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS
    .replaceAll(`--import=${selfUrl}`, '')
    .replaceAll(selfFlag, '')
    .trim();
}

const workspace = process.env.TMT_WORKSPACE;
const trialFile = process.env.TMT_PW_TRIAL_FILE;
const stateFile = process.env.TMT_PW_STATE_FILE;
const recordsFile = process.env.TMT_PW_RECORDS_FILE;
const spoolDir = process.env.TMT_PW_SPOOL_DIR;
const token = process.env.TMT_PW_TOKEN;

function readTrialSpec() {
  if (!trialFile || !existsSync(trialFile)) {
    return { phase: 'baseline', activeMutant: undefined, shift: 0, hitLimit: undefined, origins: [] };
  }
  try {
    return JSON.parse(readFileSync(trialFile, 'utf8'));
  } catch {
    return { phase: 'baseline', activeMutant: undefined, shift: 0, hitLimit: undefined, origins: [] };
  }
}

let stateSeq = 1000;
function publishState(spec, currentTestId) {
  if (!stateFile) return;
  stateSeq++;
  writeAtomicJson(stateFile, {
    seq: stateSeq,
    phase: spec.phase ?? 'baseline',
    currentTestId,
    activeMutant: spec.activeMutant,
    shift: spec.shift ?? 0,
    hitLimit: spec.hitLimit,
  });
}

async function harvestOrigins(origins) {
  const snapshots = [];
  let serverCooperating = false;
  for (const origin of origins ?? []) {
    try {
      const res = await fetch(`${origin}/__tmt_harvest__`, {
        headers: { 'x-tmt-token': token },
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok && res.headers.get('x-tmt-harvested') === '1') {
        const body = await res.json();
        serverCooperating = true;
        if (body?.snapshot) snapshots.push(body.snapshot);
      }
    } catch {
      // Server may have exited or be a static non-Node server.
    }
  }
  return { snapshots, serverCooperating };
}

function buildBrowserInitScript(bindingName, spec, testId) {
  const payload = JSON.stringify({
    bindingName,
    phase: spec.phase ?? 'baseline',
    testId,
    activeMutant: spec.activeMutant,
    shift: spec.shift ?? 0,
    hitLimit: spec.hitLimit,
  });
  return `(() => {
    const cfg = ${payload};
    const push = globalThis[cfg.bindingName];
    try { delete globalThis[cfg.bindingName]; } catch {}
    const sessionSym = Symbol.for('targeted-mutation-ts/session');
    const flushSym = Symbol.for('targeted-mutation-ts/flush');
    globalThis[sessionSym] = { phase: cfg.phase };
    const ns = globalThis.__stryker__ || (globalThis.__stryker__ = {});
    ns.currentTestId = cfg.testId;
    ns.activeMutant = cfg.activeMutant;
    ns.shift = cfg.shift || 0;
    ns.hitLimit = cfg.hitLimit;
    ns.hitCount = ns.hitCount || 0;
    ns.mutantCoverage = ns.mutantCoverage || { static: {}, perTest: {} };
    ns.observed = ns.observed || {};
    ns.comparisons = ns.comparisons || {};
    ns.loadedComparisons = ns.loadedComparisons || [];
    function flush() {
      if (typeof push !== 'function') return;
      const cur = globalThis.__stryker__;
      if (!cur) return;
      const hasHits = (cur.hitCount || 0) > 0 ||
        Object.keys(cur.mutantCoverage?.static || {}).length > 0 ||
        Object.keys(cur.mutantCoverage?.perTest || {}).length > 0 ||
        Object.keys(cur.observed || {}).length > 0 ||
        Object.keys(cur.comparisons || {}).length > 0 ||
        (cur.loadedComparisons && cur.loadedComparisons.length > 0);
      if (!hasHits) return;
      const out = {
        hitCount: cur.hitCount || 0,
        mutantCoverage: cur.mutantCoverage || { static: {}, perTest: {} },
        observed: cur.observed || {},
        comparisons: cur.comparisons || {},
        loadedComparisons: Array.isArray(cur.loadedComparisons) ? cur.loadedComparisons.slice() : [],
      };
      cur.hitCount = 0;
      cur.mutantCoverage = { static: {}, perTest: {} };
      cur.observed = {};
      cur.comparisons = {};
      try { push(out); } catch {}
    }
    globalThis[flushSym] = flush;
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', flush, true);
      addEventListener('beforeunload', flush, true);
    }
  })();`;
}

if (workspace && recordsFile && token) {
  const pkgPath = runnerPackage(workspace, 'playwright');
  const req = createRequire(pkgPath);
  const pw = req(resolve(dirname(pkgPath), 'index.js'));
  const testTypeSym = Object.getOwnPropertySymbols(pw.test).find(sym => String(sym).includes('testType'));

  if (testTypeSym && pw.test[testTypeSym]?.fixtures) {
    const instrumentedContexts = new WeakSet();
    let bootChecked = false;
    let activeTestSlot = null;

    async function instrumentContext(ctx, spec, testId, bucket) {
      if (!ctx || instrumentedContexts.has(ctx)) return;
      instrumentedContexts.add(ctx);
      const bindingName = `__tmtPush_${randomBytes(8).toString('hex')}`;
      await ctx.exposeBinding(bindingName, (_source, payload) => {
        if (payload && typeof payload === 'object') {
          mergeRealmSnapshots(bucket, payload, { defaultTestId: testId });
        }
      });
      await ctx.addInitScript({ content: buildBrowserInitScript(bindingName, spec, testId) });
    }

    async function flushContextFrames(ctx) {
      if (!ctx) return;
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          await frame.evaluate(() => {
            const fn = globalThis[Symbol.for('targeted-mutation-ts/flush')];
            if (typeof fn === 'function') fn();
          }).catch(() => {});
        }
      }
    }

    const extended = pw.test.extend({
      _tmtLifecycle: [async ({}, use, testInfo) => {
        const spec = readTrialSpec();
        const testId = testInfo.testId;
        const bucket = createEmptyBucket();
        const manualContexts = [];
        let serverBootStatic = undefined;
        let serverCooperating = false;

        if (!bootChecked && spec.phase === 'baseline') {
          bootChecked = true;
          const bootBucket = createEmptyBucket();
          const bootHarvest = await harvestOrigins(spec.origins);
          serverCooperating ||= bootHarvest.serverCooperating;
          for (const snap of bootHarvest.snapshots) mergeRealmSnapshots(bootBucket, snap);
          drainSpoolDirectory(spoolDir, bootBucket);
          serverBootStatic = bootBucket.mutantCoverage.static;
          for (const item of bootBucket.loadedComparisons) {
            if (!bucket.loadedComparisons.includes(item)) bucket.loadedComparisons.push(item);
          }
          // Preserve any server-boot `outside` comparison or targeted observations under empty test id ''.
          mergeRealmSnapshots(bucket, {
            mutantCoverage: { static: {}, perTest: {} },
            observed: bootBucket.observed,
            comparisons: bootBucket.comparisons,
          });
        } else if (!bootChecked) {
          bootChecked = true;
          // Drain any prior server hits before starting the first trial in a worker.
          await harvestOrigins(spec.origins);
          drainSpoolDirectory(spoolDir, createEmptyBucket());
        }

        const slot = { spec, testId, bucket, manualContexts };
        activeTestSlot = slot;
        publishState(spec, testId);
        try {
          await use(slot);
        } finally {
          activeTestSlot = null;
          for (const ctx of manualContexts) await flushContextFrames(ctx);
          publishState(spec, undefined);
          const harvest = await harvestOrigins(spec.origins);
          serverCooperating ||= harvest.serverCooperating;
          for (const snap of harvest.snapshots) {
            mergeRealmSnapshots(bucket, snap, { defaultTestId: testId });
          }
          if (drainSpoolDirectory(spoolDir, bucket, { defaultTestId: testId })) {
            serverCooperating = true;
          }
          appendFileSync(recordsFile, JSON.stringify({
            testId,
            file: testInfo.file ?? undefined,
            project: testInfo.project?.name ?? '',
            serverCooperating,
            ...(serverBootStatic ? { serverBootStatic } : {}),
            hitCount: bucket.hitCount,
            coverage: bucket.mutantCoverage,
            observed: bucket.observed,
            comparisons: bucket.comparisons,
            loadedComparisons: bucket.loadedComparisons,
          }) + '\n');
        }
      }, { auto: true, box: true }],

      browser: [async ({ browser }, use) => {
        if (!browser) {
          await use(browser);
          return;
        }
        const wrapped = new Proxy(browser, {
          get(target, prop, receiver) {
            if (prop === 'newContext') {
              return async (...args) => {
                const ctx = await target.newContext(...args);
                const cur = activeTestSlot;
                if (cur) {
                  await instrumentContext(ctx, cur.spec, cur.testId, cur.bucket);
                  cur.manualContexts.push(ctx);
                  const origClose = ctx.close.bind(ctx);
                  ctx.close = async (...closeArgs) => {
                    await flushContextFrames(ctx);
                    return origClose(...closeArgs);
                  };
                }
                return ctx;
              };
            }
            if (prop === 'newPage') {
              return async (...args) => {
                const page = await target.newPage(...args);
                const cur = activeTestSlot;
                if (cur) {
                  const ctx = page.context();
                  await instrumentContext(ctx, cur.spec, cur.testId, cur.bucket);
                  cur.manualContexts.push(ctx);
                }
                return page;
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
        await use(wrapped);
      }, { scope: 'worker', box: true }],

      context: [async ({ context, _tmtLifecycle }, use) => {
        if (context && _tmtLifecycle) {
          await instrumentContext(context, _tmtLifecycle.spec, _tmtLifecycle.testId, _tmtLifecycle.bucket);
        }
        try {
          await use(context);
        } finally {
          await flushContextFrames(context);
        }
      }, { box: true }],
    });

    const addedFixtures = extended[testTypeSym].fixtures.at(-1);
    pw.test[testTypeSym].fixtures.push(addedFixtures);
  }
}
