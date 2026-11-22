import { relative } from 'node:path';
import { getCurrentTest } from 'vitest/suite';
import { createTraceWriter } from './trace-buffer.mjs';

const trace = process.env.TMT_TRACE;
const writer = trace && createTraceWriter(trace, (test, finish) => test.context.onTestFinished(finish));
const active = process.env.TMT_ACTIVE_SITE;
const workspace = process.env.TMT_WORKSPACE;
const isSafeInteger = Number.isSafeInteger;

export function loaded(ids) {
  if (writer) writer.write({ loaded: ids });
}

export function compare(site, original, replacement, lhs, rhs) {
  const test = getCurrentTest();
  const identity = test ? {
    id: test.id, project: test.file.projectName ?? '', file: relative(workspace, test.file.filepath),
  } : null;
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
