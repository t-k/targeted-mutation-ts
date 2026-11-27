import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { snapshotAndResetNamespace, verifyBridgeToken } from './playwright-bridge.mjs';

const stateFile = process.env.TMT_PW_STATE_FILE;
const token = process.env.TMT_PW_TOKEN;
const spoolDir = process.env.TMT_PW_SPOOL_DIR;
const sessionKey = Symbol.for('targeted-mutation-ts/session');

function ensureNamespace() {
  const ns = globalThis.__stryker__ ?? (globalThis.__stryker__ = {});
  ns.mutantCoverage ??= { static: {}, perTest: {} };
  ns.observed ??= {};
  ns.comparisons ??= {};
  ns.loadedComparisons ??= [];
  if (ns.hitCount === undefined) ns.hitCount = 0;
  return ns;
}

let lastSeq = -1;

function syncState() {
  const ns = ensureNamespace();
  if (!stateFile || !existsSync(stateFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    if (typeof parsed.seq === 'number' && parsed.seq === lastSeq) return;
    if (typeof parsed.seq === 'number') lastSeq = parsed.seq;
    globalThis[sessionKey] = { phase: parsed.phase ?? 'baseline' };
    ns.currentTestId = parsed.currentTestId || undefined;
    ns.activeMutant = parsed.activeMutant || undefined;
    ns.shift = Number.isSafeInteger(parsed.shift) ? parsed.shift : 0;
    ns.hitLimit = typeof parsed.hitLimit === 'number' ? parsed.hitLimit : undefined;
  } catch {
    // Transient atomic rename race or missing file: keep current state.
  }
}

function wrapServerEmit(Proto) {
  if (!Proto || Proto.__tmtWrapped) return;
  const origEmit = Proto.emit;
  Object.defineProperty(Proto, '__tmtWrapped', { value: true });
  Proto.emit = function tmtServerEmit(event, req, res, ...rest) {
    if (event === 'request' && req && res) {
      if (req.url === '/__tmt_harvest__' && verifyBridgeToken(req.headers?.['x-tmt-token'], token)) {
        syncState();
        const snapshot = snapshotAndResetNamespace(ensureNamespace(), { keepLoaded: true });
        const payload = JSON.stringify({ ok: true, pid: process.pid, snapshot });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-tmt-harvested': '1',
          'cache-control': 'no-store',
        });
        res.end(payload);
        return true;
      }
      syncState();
    }
    return origEmit.call(this, event, req, res, ...rest);
  };
}

if (stateFile && token) {
  syncState();
  wrapServerEmit(http.Server?.prototype);
  wrapServerEmit(https.Server?.prototype);

  process.on('exit', () => {
    if (!spoolDir || !existsSync(spoolDir)) return;
    const ns = globalThis.__stryker__;
    if (!ns) return;
    const snapshot = snapshotAndResetNamespace(ns, { keepLoaded: true });
    const hasData = snapshot.hitCount > 0 ||
      Object.keys(snapshot.mutantCoverage.static).length > 0 ||
      Object.keys(snapshot.mutantCoverage.perTest).length > 0 ||
      Object.keys(snapshot.observed).length > 0 ||
      Object.keys(snapshot.comparisons).length > 0 ||
      snapshot.loadedComparisons.length > 0;
    if (!hasData) return;
    try {
      writeFileSync(join(spoolDir, `exit-${process.pid}-${randomUUID()}.json`), JSON.stringify(snapshot), 'utf8');
    } catch {
      // Best-effort exit flush.
    }
  });
}
