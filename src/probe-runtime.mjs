import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import * as vitestApi from 'vitest';

function safeCanonicalPath(path) {
  if (typeof path !== 'string' || !path) return path;
  try {
    const resolved = realpathSync(path);
    if (process.platform !== 'win32') return resolved;
    const native = realpathSync.native(resolved);
    return !resolved.startsWith('\\\\') && native.startsWith('\\\\') ? resolved : native;
  } catch {
    return path;
  }
}

const trace = process.env.TMT_TRACE;
// Use the native module cache even when Vite evaluates or resets this module.
const writer = trace && createRequire(import.meta.url)('./trace-buffer.mjs').workerTraceWriter(
  trace, (test, finish) => test.context.onTestFinished(finish), process.env.TMT_TRACE_SYNC === '1');
const active = process.env.TMT_ACTIVE_SITE;
const workspace = safeCanonicalPath(process.env.TMT_WORKSPACE);
const getCurrentTest = vitestApi.TestRunner?.getCurrentTest ??
  createRequire(workspace ? resolve(workspace, 'package.json') : import.meta.url)('vitest/suite').getCurrentTest;
const isSafeInteger = Number.isSafeInteger;

export function loaded(ids) {
  if (writer) writer.write({ loaded: ids });
}

function testIdentity(test) {
  return test ? {
    id: test.id, project: test.file.projectName ?? '', file: relative(workspace, safeCanonicalPath(test.file.filepath)),
  } : null;
}

export function hit(site) {
  if (writer) {
    const test = getCurrentTest();
    writer.write({ hit: site, identity: testIdentity(test) }, test);
  }
  return site;
}

export function compare(site, original, replacement, lhs, rhs) {
  const test = getCurrentTest();
  const identity = testIdentity(test);
  const safe = isSafeInteger(lhs) && isSafeInteger(rhs);
  const operator = site === active ? replacement : original;
  let result;
  try {
    switch (operator) {
      case '<': result = lhs < rhs; break;
      case '<=': result = lhs <= rhs; break;
      case '>': result = lhs > rhs; break;
      case '>=': result = lhs >= rhs; break;
    }
    return result;
  } finally {
    if (writer) writer.write({
      site, identity, operands: safe ? [lhs, rhs] : null, result: result ?? null, operator,
    }, test);
  }
}
