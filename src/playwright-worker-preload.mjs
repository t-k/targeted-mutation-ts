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
const isPlaywrightWorker = process.argv.some(arg => typeof arg === 'string' && arg.includes('workerProcessEntry'));
if (isPlaywrightWorker && process.env.NODE_OPTIONS?.includes(selfUrl)) {
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
const originsFile = process.env.TMT_PW_ORIGINS_FILE;
const token = process.env.TMT_PW_TOKEN;

function readTrialSpec() {
  let spec = { phase: 'baseline', activeMutant: undefined, shift: 0, hitLimit: undefined, origins: [] };
  if (trialFile && existsSync(trialFile)) {
    try {
      spec = { ...spec, ...JSON.parse(readFileSync(trialFile, 'utf8')) };
    } catch {}
  }
  if ((!spec.origins || !spec.origins.length) && originsFile && existsSync(originsFile)) {
    try {
      spec.origins = JSON.parse(readFileSync(originsFile, 'utf8'));
    } catch {}
  }
  return spec;
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

export async function harvestOrigins(origins, authToken = token) {
  const snapshots = [];
  const list = origins ?? [];
  let cooperatedCount = 0;
  for (const origin of list) {
    const candidates = [origin];
    try {
      const parsed = new URL(origin);
      if (parsed.hostname === '127.0.0.1') {
        candidates.push(`${parsed.protocol}//localhost${parsed.port ? ':' + parsed.port : ''}`);
      } else if (parsed.hostname === 'localhost') {
        candidates.push(`${parsed.protocol}//127.0.0.1${parsed.port ? ':' + parsed.port : ''}`);
      }
    } catch {}
    for (const candidateOrigin of candidates) {
      try {
        const res = await fetch(`${candidateOrigin}/__tmt_harvest__`, {
          headers: { 'x-tmt-token': authToken },
          redirect: 'error',
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok && res.headers.get('x-tmt-harvested') === '1') {
          const body = await res.json();
          cooperatedCount++;
          if (body?.snapshot) snapshots.push(body.snapshot);
          break;
        }
      } catch {
        // Try alternate loopback alias if connection failed, or treat as non-cooperating server.
      }
    }
  }
  const serverCooperating = list.length > 0 && cooperatedCount === list.length;
  return { snapshots, serverCooperating, cooperatedCount, totalOrigins: list.length };
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
    const syncSym = Symbol.for('targeted-mutation-ts/sync');
    function applyCfg(c) {
      try {
        Object.defineProperty(globalThis, sessionSym, { value: { phase: c.phase }, enumerable: false, writable: true, configurable: true });
      } catch {
        globalThis[sessionSym] = { phase: c.phase };
      }
      let ns = globalThis.__stryker__;
      if (!ns) {
        ns = {};
        try {
          Object.defineProperty(globalThis, '__stryker__', { value: ns, enumerable: false, writable: true, configurable: true });
        } catch {
          globalThis.__stryker__ = ns;
        }
      }
      ns.currentTestId = c.testId;
      ns.activeMutant = c.activeMutant;
      ns.shift = c.shift || 0;
      ns.hitLimit = c.hitLimit;
      ns.hitCount = ns.hitCount || 0;
      ns.mutantCoverage = ns.mutantCoverage || { static: {}, perTest: {} };
      ns.observed = ns.observed || {};
      ns.comparisons = ns.comparisons || {};
      ns.loadedComparisons = ns.loadedComparisons || [];
      ns.loadedFiles = ns.loadedFiles || [];
    }
    applyCfg(cfg);
    function flush() {
      if (typeof push !== 'function') return;
      const cur = globalThis.__stryker__;
      if (!cur) return;
      const hasHits = (cur.hitCount || 0) > 0 ||
        Object.keys(cur.mutantCoverage?.static || {}).length > 0 ||
        Object.keys(cur.mutantCoverage?.perTest || {}).length > 0 ||
        Object.keys(cur.observed || {}).length > 0 ||
        Object.keys(cur.comparisons || {}).length > 0 ||
        (cur.loadedComparisons && cur.loadedComparisons.length > 0) ||
        (cur.loadedFiles && cur.loadedFiles.length > 0);
      if (!hasHits) return;
      const out = {
        hitCount: cur.hitCount || 0,
        mutantCoverage: cur.mutantCoverage || { static: {}, perTest: {} },
        observed: cur.observed || {},
        comparisons: cur.comparisons || {},
        loadedComparisons: Array.isArray(cur.loadedComparisons) ? cur.loadedComparisons.slice() : [],
        loadedFiles: Array.isArray(cur.loadedFiles) ? cur.loadedFiles.slice() : [],
      };
      cur.hitCount = 0;
      cur.mutantCoverage = { static: {}, perTest: {} };
      cur.observed = {};
      cur.comparisons = {};
      try { return push(out); } catch {}
    }
    try {
      Object.defineProperty(globalThis, flushSym, { value: flush, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(globalThis, syncSym, { value: applyCfg, enumerable: false, writable: true, configurable: true });
    } catch {
      globalThis[flushSym] = flush;
      globalThis[syncSym] = applyCfg;
    }
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', () => { flush(); }, true);
      addEventListener('beforeunload', () => { flush(); }, true);
    }
  })();`;
}

if (isPlaywrightWorker && workspace && recordsFile && token) {
  const pkgPath = runnerPackage(workspace, 'playwright');
  const req = createRequire(pkgPath);
  const pw = req(resolve(dirname(pkgPath), 'index.js'));
  const testTypeSym = Object.getOwnPropertySymbols(pw.test).find(sym => String(sym).includes('testType'));

  if (testTypeSym && pw.test[testTypeSym]?.fixtures) {
    const instrumentedContexts = new WeakSet();
    const instrumentedPages = new WeakSet();
    // Persistent worker-wide set of manually created contexts (`browser.newContext()` in `beforeAll`, etc.)
    // so reused pages across tests always flush into the currently active test's bucket!
    const openManualContexts = new Set();
    let bootChecked = false;
    let activeTestSlot = null;

    async function flushPageFrames(page) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
      for (const frame of page.frames()) {
        await frame.evaluate(async () => {
          const fn = globalThis[Symbol.for('targeted-mutation-ts/flush')];
          if (typeof fn === 'function') await fn();
        }).catch(() => {});
      }
    }

    async function syncPageFrames(page, spec, testId) {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
      const syncPayload = {
        phase: spec.phase ?? 'baseline',
        testId,
        activeMutant: spec.activeMutant,
        shift: spec.shift ?? 0,
        hitLimit: spec.hitLimit,
      };
      for (const frame of page.frames()) {
        await frame.evaluate(nextCfg => {
          const fn = globalThis[Symbol.for('targeted-mutation-ts/sync')];
          if (typeof fn === 'function') fn(nextCfg);
        }, syncPayload).catch(() => {});
      }
    }

    function wrapPageLifecycle(page) {
      if (!page || instrumentedPages.has(page)) return;
      instrumentedPages.add(page);
      for (const method of ['close', 'goto', 'reload', 'goBack', 'goForward', 'setContent']) {
        if (typeof page[method] !== 'function') continue;
        const orig = page[method].bind(page);
        page[method] = async (...args) => {
          await flushPageFrames(page);
          return orig(...args);
        };
      }
    }

    async function instrumentContext(ctx, initialSpec, initialTestId, fallbackBucket) {
      if (!ctx || instrumentedContexts.has(ctx)) return;
      instrumentedContexts.add(ctx);
      const bindingName = `__tmtPush_${randomBytes(8).toString('hex')}`;
      // Route browser flushes dynamically to `activeTestSlot` so contexts reused across tests attribute each
      // test's evaluations to that test rather than a closed earlier test bucket.
      await ctx.exposeBinding(bindingName, (_source, payload) => {
        if (payload && typeof payload === 'object') {
          const targetBucket = activeTestSlot?.bucket ?? fallbackBucket;
          const targetTestId = activeTestSlot?.testId ?? initialTestId;
          if (targetBucket) mergeRealmSnapshots(targetBucket, payload, { defaultTestId: targetTestId });
        }
      });
      await ctx.addInitScript({ content: buildBrowserInitScript(bindingName, initialSpec, initialTestId) });
      for (const existingPage of ctx.pages()) wrapPageLifecycle(existingPage);
      if (typeof ctx.on === 'function') {
        ctx.on('page', page => {
          wrapPageLifecycle(page);
          if (activeTestSlot) {
            syncPageFrames(page, activeTestSlot.spec, activeTestSlot.testId).catch(() => {});
          }
        });
      }
    }

    async function flushContextFrames(ctx) {
      if (!ctx) return;
      for (const page of ctx.pages()) {
        await flushPageFrames(page);
      }
    }

    const extended = pw.test.extend({
      _tmtLifecycle: [async ({}, use, testInfo) => {
        const spec = readTrialSpec();
        const testId = testInfo.testId;
        const bucket = createEmptyBucket();
        let serverBootStatic = undefined;
        let serverCooperating = false;

        if (!bootChecked && spec.phase === 'baseline') {
          bootChecked = true;
          const bootBucket = createEmptyBucket();
          const bootHarvest = await harvestOrigins(spec.origins);
          const spoolHad = drainSpoolDirectory(spoolDir, bootBucket);
          serverCooperating = bootHarvest.serverCooperating || (bootHarvest.totalOrigins === 0 && spoolHad);
          for (const snap of bootHarvest.snapshots) mergeRealmSnapshots(bootBucket, snap);
          serverBootStatic = bootBucket.mutantCoverage.static;
          for (const item of bootBucket.loadedComparisons) {
            if (!bucket.loadedComparisons.includes(item)) bucket.loadedComparisons.push(item);
          }
          for (const file of bootBucket.loadedFiles) {
            if (!bucket.loadedFiles.includes(file)) bucket.loadedFiles.push(file);
          }
          mergeRealmSnapshots(bucket, {
            mutantCoverage: { static: {}, perTest: {} },
            observed: bootBucket.observed,
            comparisons: bootBucket.comparisons,
          });
        } else if (!bootChecked) {
          bootChecked = true;
          const preHarvest = await harvestOrigins(spec.origins);
          serverCooperating = preHarvest.serverCooperating;
          if (spec.phase === 'trial') {
            // Preserve server-startup `hitCount` during isolated trials so `serverStatic` activation is verified!
            for (const snap of preHarvest.snapshots) mergeRealmSnapshots(bucket, snap);
            drainSpoolDirectory(spoolDir, bucket);
          } else {
            drainSpoolDirectory(spoolDir, createEmptyBucket());
          }
        }

        // Flush any stale data on reused manual contexts before switching to `testId`, then sync `testId` + trial spec.
        for (const ctx of openManualContexts) {
          await flushContextFrames(ctx);
          for (const page of ctx.pages()) await syncPageFrames(page, spec, testId);
        }

        const slot = { spec, testId, bucket };
        activeTestSlot = slot;
        publishState(spec, testId);
        try {
          await use(slot);
        } finally {
          for (const ctx of openManualContexts) await flushContextFrames(ctx);
          activeTestSlot = null;
          publishState(spec, undefined);
          const harvest = await harvestOrigins(spec.origins);
          const spoolHad = drainSpoolDirectory(spoolDir, bucket, { defaultTestId: testId });
          if (harvest.totalOrigins > 0) {
            serverCooperating = harvest.serverCooperating;
          } else if (spoolHad) {
            serverCooperating = true;
          }
          for (const snap of harvest.snapshots) {
            mergeRealmSnapshots(bucket, snap, { defaultTestId: testId });
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
            loadedFiles: bucket.loadedFiles,
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
                const initSpec = cur?.spec ?? readTrialSpec();
                await instrumentContext(ctx, initSpec, cur?.testId, cur?.bucket);
                openManualContexts.add(ctx);
                const origClose = ctx.close.bind(ctx);
                ctx.close = async (...closeArgs) => {
                  await flushContextFrames(ctx);
                  openManualContexts.delete(ctx);
                  return origClose(...closeArgs);
                };
                return ctx;
              };
            }
            if (prop === 'newPage') {
              return async (...args) => {
                const page = await target.newPage(...args);
                const ctx = page.context();
                const cur = activeTestSlot;
                const initSpec = cur?.spec ?? readTrialSpec();
                await instrumentContext(ctx, initSpec, cur?.testId, cur?.bucket);
                wrapPageLifecycle(page);
                openManualContexts.add(ctx);
                const origClose = ctx.close.bind(ctx);
                ctx.close = async (...closeArgs) => {
                  await flushContextFrames(ctx);
                  openManualContexts.delete(ctx);
                  return origClose(...closeArgs);
                };
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
