import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceWriter, pendingTraceDirectory, readCompletedTrace } from '../src/trace-buffer.mjs';
import { installProbe, instrument } from '../src/probe.mjs';
import { runVitest, withCopy } from '../src/vitest.mjs';

const rows = readFileSync(new URL('../verification/pict/trace-buffer.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [event, volume, completion] of rows) {
  test(`trace buffer ${event} ${volume} ${completion}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-trace-buffer-'));
    try {
      const trace = join(root, 'trace');
      mkdirSync(pendingTraceDirectory(trace));
      const expected = [];
      const completions = [];
      const task = {};
      const whenFinished = fn => {
        if (completion === 'Unavailable') throw new Error('Not in the test context');
        completions.push(fn);
      };
      const writer = createTraceWriter(trace, (_, done) => whenFinished(done));
      const count = { Single: 1, Small: 5, Large: 5000 }[volume];
      for (let index = 0; index < count; index++) {
        const scope = event === 'Static' || (event === 'Mixed' && index % 3 === 0) ? undefined : task;
        const row = scope ? { site: 'x', operands: [index, 1], file: '🐈.ts' } : { loaded: ['x'] };
        expected.push(row);
        writer.write(row, scope);
      }
      const buffered = event !== 'Static' && volume !== 'Single' && completion !== 'Unavailable';
      if (completion === 'Missing' && buffered) {
        assert.equal(readCompletedTrace(trace), null);
        if (volume === 'Large') assert.equal(existsSync(trace), true);
        return;
      }
      for (const complete of completions) complete();
      const late = { site: 'late', operands: [10, 20] };
      expected.push(late);
      writer.write(late, buffered ? task : undefined);
      const actual = readFileSync(trace, 'utf8');
      assert.equal(actual, expected.map(row => JSON.stringify(row) + '\n').join(''));
      assert.deepEqual(readCompletedTrace(trace), expected);
      assert.equal(completions.length, Number(buffered && completion === 'Normal'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('interleaved tasks retain one completion callback each and preserve order', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-trace-tasks-'));
  try {
    const trace = join(root, 'trace');
    mkdirSync(pendingTraceDirectory(trace));
    const a = {};
    const b = {};
    const finishes = new Map();
    const registrations = [];
    const writer = createTraceWriter(trace, (task, finish) => {
      registrations.push(task);
      finishes.set(task, finish);
    });
    const rows = [];
    for (const task of [a, a, b, b, a]) {
      const row = { index: rows.length };
      rows.push(row);
      writer.write(row, task);
    }
    assert.deepEqual(registrations, [a, b]);
    finishes.get(b)();
    assert.equal(readCompletedTrace(trace), null);
    finishes.get(a)();
    assert.deepEqual(readCompletedTrace(trace), rows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worker exiting after an earlier chunk leaves its trace unusable', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-trace-abort-'));
  try {
    const trace = join(root, 'trace');
    mkdirSync(pendingTraceDirectory(trace));
    const runtime = new URL('../src/trace-buffer.mjs', import.meta.url);
    const script = `
      import { createTraceWriter } from ${JSON.stringify(runtime.href)};
      const task = {};
      const writer = createTraceWriter(${JSON.stringify(trace)}, () => {});
      for (let index = 0; index < 200; index++) writer.write({ index, data: 'x'.repeat(1024) }, task);
      process.exit(2);
    `;
    const run = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 2, run.error?.message ?? run.stderr);
    assert.ok(readFileSync(trace).length > 64 * 1024);
    assert.equal(readCompletedTrace(trace), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the installed probe flushes ordered observations from different Vitest files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-trace-vitest-'));
  const source = Buffer.from('export const check = n => n >= 2;');
  const operator = source.indexOf('>=');
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'subject.mjs'), source);
    for (const name of ['first', 'second']) {
      writeFileSync(join(root, name + '.test.mjs'), `
        import { readFileSync } from 'node:fs';
        import { expect, it } from 'vitest';
        import { check } from './subject.mjs';
        const count = () => readFileSync(process.env.TMT_TRACE, 'utf8').trim().split('\\n').length;
        it('${name}', () => {
          const before = count();
          for (let index = 2; index < 402; index++) expect(check(index)).toBe(true);
          expect(count() - before).toBeLessThan(400);
        });
      `);
    }
    withCopy(root, (workspace, temp) => {
      const trace = join(temp, 'trace');
      mkdirSync(pendingTraceDirectory(trace));
      installProbe(workspace);
      writeFileSync(join(workspace, 'subject.mjs'), instrument(workspace, 'subject.mjs', source,
        [{ id: 'subject', left: [operator - 2, operator - 1], right: [operator + 3, operator + 4],
          edit: [operator, operator + 2], operator: '>=', replacement: '>' }]));
      const result = runVitest(workspace, temp, { trace, product: true });
      assert.equal(result.status, 'passed', JSON.stringify(result.tests ?? result));
      const rows = readCompletedTrace(trace);
      const comparisons = rows.filter(row => row.site === 'subject');
      assert.equal(rows.length - comparisons.length, 2);
      for (const name of ['first', 'second']) {
        const matching = comparisons.filter(row => row.identity.file === name + '.test.mjs');
        assert.deepEqual(matching.map(row => row.operands), Array.from({ length: 400 }, (_, index) => [index + 2, 2]));
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
