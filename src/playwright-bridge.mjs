import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const MAX_COMPARISON_ROWS_PER_TEST = 1024;

export function verifyBridgeToken(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !expected.length) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createEmptyBucket() {
  return {
    hitCount: 0,
    mutantCoverage: { static: {}, perTest: {} },
    observed: {},
    comparisons: {},
    loadedComparisons: [],
  };
}

export function snapshotAndResetNamespace(ns, { keepLoaded = true } = {}) {
  if (!ns || typeof ns !== 'object') return createEmptyBucket();
  const snapshot = {
    hitCount: Number(ns.hitCount ?? 0),
    mutantCoverage: ns.mutantCoverage ?? { static: {}, perTest: {} },
    observed: ns.observed ?? {},
    comparisons: ns.comparisons ?? {},
    loadedComparisons: Array.isArray(ns.loadedComparisons) ? [...ns.loadedComparisons] : [],
  };
  ns.hitCount = 0;
  ns.mutantCoverage = { static: {}, perTest: {} };
  ns.observed = {};
  ns.comparisons = {};
  if (!keepLoaded) ns.loadedComparisons = [];
  return snapshot;
}

function updateExtrema(ex, pair) {
  const [lhs, rhs, result] = pair;
  const diff = lhs - rhs;
  if (result) {
    if (!ex.minTrue || diff < ex.minTrue[0] - ex.minTrue[1]) ex.minTrue = [lhs, rhs, true];
    if (!ex.maxTrue || diff > ex.maxTrue[0] - ex.maxTrue[1]) ex.maxTrue = [lhs, rhs, true];
  } else {
    if (!ex.minFalse || diff < ex.minFalse[0] - ex.minFalse[1]) ex.minFalse = [lhs, rhs, false];
    if (!ex.maxFalse || diff > ex.maxFalse[0] - ex.maxFalse[1]) ex.maxFalse = [lhs, rhs, false];
  }
}

export function mergeComparisonSlot(targetSlot, incomingSlot) {
  if (!incomingSlot || typeof incomingSlot !== 'object') return targetSlot;
  if (incomingSlot.invalid) targetSlot.invalid = true;
  const incomingRows = Array.isArray(incomingSlot.rows) ? incomingSlot.rows : [];
  for (const row of incomingRows) {
    if (!Array.isArray(row) || row.length < 3) continue;
    if (targetSlot.rows.length < MAX_COMPARISON_ROWS_PER_TEST && !targetSlot.overflow) {
      targetSlot.rows.push(row);
    } else {
      targetSlot.overflow = true;
      const ex = targetSlot.extrema ?? (targetSlot.extrema = {});
      if (targetSlot.rows.length > 0 && row[1] !== targetSlot.rows[0][1] && !ex.altRhs) ex.altRhs = row;
      updateExtrema(ex, row);
    }
  }
  if (incomingSlot.overflow) {
    targetSlot.overflow = true;
    const inEx = incomingSlot.extrema ?? {};
    const ex = targetSlot.extrema ?? (targetSlot.extrema = {});
    if (inEx.altRhs && !ex.altRhs) ex.altRhs = inEx.altRhs;
    for (const pair of [inEx.minTrue, inEx.maxTrue, inEx.minFalse, inEx.maxFalse]) {
      if (!pair) continue;
      if (targetSlot.rows.length > 0 && pair[1] !== targetSlot.rows[0][1] && !ex.altRhs) ex.altRhs = pair;
      updateExtrema(ex, pair);
    }
  }
  return targetSlot;
}

export function mergeRealmSnapshots(target, incoming, { defaultTestId } = {}) {
  if (!incoming || typeof incoming !== 'object') return target;
  target.hitCount = (target.hitCount ?? 0) + Number(incoming.hitCount ?? 0);

  const inCov = incoming.mutantCoverage ?? {};
  for (const [id, count] of Object.entries(inCov.static ?? {})) {
    if (!count) continue;
    if (defaultTestId) {
      const per = target.mutantCoverage.perTest[defaultTestId] ?? (target.mutantCoverage.perTest[defaultTestId] = {});
      per[id] = (per[id] ?? 0) + count;
    } else {
      target.mutantCoverage.static[id] = (target.mutantCoverage.static[id] ?? 0) + count;
    }
  }
  for (const [rawTestId, counts] of Object.entries(inCov.perTest ?? {})) {
    const testId = rawTestId || defaultTestId || '';
    if (!testId) {
      for (const [id, count] of Object.entries(counts ?? {})) {
        if (count) target.mutantCoverage.static[id] = (target.mutantCoverage.static[id] ?? 0) + count;
      }
      continue;
    }
    const per = target.mutantCoverage.perTest[testId] ?? (target.mutantCoverage.perTest[testId] = {});
    for (const [id, count] of Object.entries(counts ?? {})) {
      if (count) per[id] = (per[id] ?? 0) + count;
    }
  }

  for (const [id, entry] of Object.entries(incoming.observed ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const dst = target.observed[id] ?? (target.observed[id] = { tests: {} });
    for (const [rawTestId, tuple] of Object.entries(entry.tests ?? {})) {
      const testId = rawTestId || defaultTestId || '';
      const cur = dst.tests[testId] ?? (dst.tests[testId] = [0, 0, 0]);
      cur[0] += Number(tuple?.[0] ?? 0);
      cur[1] += Number(tuple?.[1] ?? 0);
      cur[2] += Number(tuple?.[2] ?? 0);
    }
    for (const sampleKey of ['agree', 'differ', 'unsure']) {
      if (dst[sampleKey] === undefined && entry[sampleKey] !== undefined) dst[sampleKey] = entry[sampleKey];
    }
    for (const flagKey of ['typed', 'realCopy', 'nonArray', 'nonPlain', 'sequence', 'nonSequence', 'threw', 'absorbed']) {
      if (entry[flagKey]) dst[flagKey] = true;
    }
  }

  for (const [cmpKey, byTest] of Object.entries(incoming.comparisons ?? {})) {
    if (!byTest || typeof byTest !== 'object') continue;
    const dstByTest = target.comparisons[cmpKey] ?? (target.comparisons[cmpKey] = {});
    for (const [rawTestId, slot] of Object.entries(byTest)) {
      const testId = rawTestId || defaultTestId || '';
      const dstSlot = dstByTest[testId] ?? (dstByTest[testId] = { rows: [], overflow: false, invalid: false });
      mergeComparisonSlot(dstSlot, slot);
    }
  }

  if (Array.isArray(incoming.loadedComparisons)) {
    const seen = new Set(target.loadedComparisons);
    for (const item of incoming.loadedComparisons) {
      if (typeof item === 'string' && !seen.has(item)) {
        seen.add(item);
        target.loadedComparisons.push(item);
      }
    }
  }
  return target;
}

export function writeAtomicJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, filePath);
}

export function drainSpoolDirectory(spoolDir, target, options) {
  if (!spoolDir || !existsSync(spoolDir)) return false;
  let any = false;
  for (const name of readdirSync(spoolDir)) {
    if (!name.endsWith('.json')) continue;
    const full = join(spoolDir, name);
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      rmSync(full, { force: true });
      mergeRealmSnapshots(target, parsed, options);
      any = true;
    } catch {
      rmSync(full, { force: true });
    }
  }
  return any;
}

// Convert dual-realm (browser + server) in-memory comparison snapshots into `analysis.mjs` trace rows.
export function comparisonRecordsToTrace(records, tests, subjects) {
  const sitesByKey = new Map();
  for (const subject of subjects ?? []) {
    for (const site of subject.sites ?? []) {
      if (site.unobserved || !['<', '<=', '>', '>='].includes(site.operator)) continue;
      const at = (site.operatorEdit ?? site.edit)[0];
      const key = `${subject.file}:${at}`;
      if (!sitesByKey.has(key)) sitesByKey.set(key, []);
      sitesByKey.get(key).push(site);
    }
  }
  const rows = [];
  const loadedIds = new Set();
  const overflowSites = new Set();

  for (const record of records ?? []) {
    for (const cmpKey of record?.loadedComparisons ?? []) {
      for (const site of sitesByKey.get(cmpKey) ?? []) loadedIds.add(site.id);
    }
    for (const [cmpKey, byTest] of Object.entries(record?.comparisons ?? {})) {
      const targetSites = sitesByKey.get(cmpKey);
      if (!targetSites?.length || !byTest || typeof byTest !== 'object') continue;
      for (const site of targetSites) {
        loadedIds.add(site.id);
        for (const [testId, slot] of Object.entries(byTest)) {
          const test = testId ? tests.get(testId) : null;
          const identity = test ? { id: test.id, project: test.project, file: test.file } : null;
          const pairs = [...(slot?.rows ?? [])];
          if (slot?.overflow) {
            overflowSites.add(site.id);
            const ex = slot.extrema ?? {};
            for (const candidate of [ex.altRhs, ex.minTrue, ex.maxTrue, ex.minFalse, ex.maxFalse]) {
              if (candidate) pairs.push(candidate);
            }
          }
          for (const [lhs, rhs, result] of pairs) {
            rows.push({ site: site.id, identity, operands: [lhs, rhs], result, operator: site.operator });
          }
          if (slot?.invalid) {
            rows.push({ site: site.id, identity, operands: null, result: null, operator: site.operator });
          }
        }
      }
    }
  }
  if (loadedIds.size) rows.unshift({ loaded: [...loadedIds] });
  return { rows, overflowSites };
}

export async function createPlaywrightCoordinator({ maxBodyBytes = 8 * 1024 * 1024, stateFile, spoolDir } = {}) {
  const token = randomBytes(32).toString('hex');
  if (spoolDir) mkdirSync(spoolDir, { recursive: true });
  let state = { seq: 0, phase: 'baseline', currentTestId: undefined, activeMutant: undefined, shift: 0, hitLimit: undefined };
  if (stateFile) writeAtomicJson(stateFile, state);
  const records = [];

  const server = createServer((req, res) => {
    // Reject any browser-originated request (CORS/DNS-rebinding defense) or unauthenticated caller.
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined ||
        !verifyBridgeToken(req.headers['x-tmt-token'], token)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden"}');
      return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && (req.url === '/state' || req.url === '/record')) {
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) return;
        total += chunk.length;
        if (total > maxBodyBytes) {
          aborted = true;
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end('{"error":"payload_too_large"}');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (req.url === '/state') {
            state = { ...state, ...body, seq: state.seq + 1 };
            if (stateFile) writeAtomicJson(stateFile, state);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
          } else {
            records.push(body);
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          }
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad_json"}');
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    token,
    createBucket: createEmptyBucket,
    getState: () => ({ ...state }),
    async setState(patch) {
      state = { ...state, ...patch, seq: state.seq + 1 };
      if (stateFile) writeAtomicJson(stateFile, state);
      return state;
    },
    takeRecords() {
      const out = [...records];
      records.length = 0;
      return out;
    },
    async close() {
      await new Promise(resolveClose => server.close(() => resolveClose()));
    },
  };
}
