import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

const chunkSize = 64 * 1024;
const workerWriters = new Map();

export function pendingTraceDirectory(trace) {
  return trace + '.pending';
}

export function createTraceWriter(trace, onFinished, { producer, immediate } = {}) {
  const tasks = new WeakMap();
  const pending = pendingTraceDirectory(trace);
  const writerHeader = producer ? JSON.stringify({ traceWriter: producer }) + '\n' : '';
  let active;
  let lines = [];
  let bytes = 0;

  function publish(data) {
    appendFileSync(trace, writerHeader + data);
  }

  function flush() {
    if (!lines.length) return;
    publish(lines.join('') + (producer ? '{"traceBuffer":"closed"}\n' : ''));
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
    if (immediate) {
      publish(line);
      return;
    }
    if (task !== active || !task) flush();
    active = task;
    if (!task) {
      publish(line);
      return;
    }
    const state = tasks.get(task);
    if (!state) {
      // Most tests see very few comparisons. Write the first event without registering a hook.
      tasks.set(task, { marker: undefined, closed: false });
      publish(line);
      return;
    }
    if (!state.closed && !state.marker) begin(task, state);
    if (state.closed) {
      publish(line);
      return;
    }
    if (producer && !lines.length) publish('{"traceBuffer":"open"}\n');
    lines.push(line);
    bytes += Buffer.byteLength(line);
    if (bytes >= chunkSize) flush();
  } };
}

export function workerTraceWriter(trace, onFinished, immediate) {
  let writer = workerWriters.get(trace);
  if (!writer) {
    writer = createTraceWriter(trace, onFinished, { producer: randomUUID(), immediate });
    workerWriters.set(trace, writer);
  }
  return writer;
}

export function inspectTrace(trace) {
  try {
    if (readdirSync(pendingTraceDirectory(trace)).length) return { rows: null, overlap: false };
    const outstanding = new Set();
    const rows = [];
    let writer;
    let overlap = false;
    for (const line of readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row?.traceWriter) {
        writer = row.traceWriter;
        // A foreign append during an open chunk may have passed an earlier observation.
        overlap ||= outstanding.size > 0 && !outstanding.has(writer);
      } else if (row?.traceBuffer === 'open') {
        outstanding.add(writer);
      } else if (row?.traceBuffer === 'closed') {
        outstanding.delete(writer);
      } else {
        rows.push(row);
      }
    }
    return { rows: overlap || outstanding.size ? null : rows, overlap };
  } catch {
    return { rows: null, overlap: false };
  }
}

export function readCompletedTrace(trace) {
  return inspectTrace(trace).rows;
}
