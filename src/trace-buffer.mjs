import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

const chunkSize = 64 * 1024;

export function pendingTraceDirectory(trace) {
  return trace + '.pending';
}

export function createTraceWriter(trace, onFinished) {
  const tasks = new WeakMap();
  const pending = pendingTraceDirectory(trace);
  let active;
  let lines = [];
  let bytes = 0;

  function flush() {
    if (!lines.length) return;
    appendFileSync(trace, lines.join(''));
    lines = [];
    bytes = 0;
  }

  function begin(task, state) {
    try {
      onFinished(task, () => {
        flush();
        if (state.marker) rmdirSync(state.marker);
        state.closed = true;
      });
    } catch {
      state.closed = true;
    }
    if (!state.closed) state.marker = mkdtempSync(join(pending, 'task-'));
  }

  return { write(row, task) {
    const line = JSON.stringify(row) + '\n';
    if (task !== active || !task) flush();
    active = task;
    if (!task) {
      appendFileSync(trace, line);
      return;
    }
    const state = tasks.get(task);
    if (!state) {
      // Most tests see very few comparisons. Write the first event without registering a hook.
      tasks.set(task, { marker: undefined, closed: false });
      appendFileSync(trace, line);
      return;
    }
    if (!state.closed && !state.marker) begin(task, state);
    if (state.closed) {
      appendFileSync(trace, line);
      return;
    }
    lines.push(line);
    bytes += Buffer.byteLength(line);
    if (bytes >= chunkSize) flush();
  } };
}

export function readCompletedTrace(trace) {
  try {
    if (readdirSync(pendingTraceDirectory(trace)).length) return null;
    return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return null;
  }
}
