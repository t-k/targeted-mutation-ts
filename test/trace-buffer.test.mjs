import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceWriter, pendingTraceDirectory, readCompletedTrace } from '../src/trace-buffer.mjs';
import { freshProbeBinding, installProbe, instrument } from '../src/probe.mjs';
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

for (const runtime of ['CommonJS', 'ResetESM']) {
  test(`a worker preserves trace order across ${runtime} probe instances`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tmt-trace-instances-'));
    const mixed = runtime === 'CommonJS';
    const esm = Buffer.from('export const check = n => n >= 0;');
    const cjs = Buffer.from('module.exports = n => n >= 0;');
    try {
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(join(root, 'subject.mjs'), esm);
      if (mixed) writeFileSync(join(root, 'other.cjs'), cjs);
      writeFileSync(join(root, 'subject.test.mjs'), `
        import { createRequire } from 'node:module';
        import { expect, it, vi } from 'vitest';
        import { check } from './subject.mjs';
        it('interleaves module instances', async () => {
          const other = ${mixed ? "createRequire(import.meta.url)('./other.cjs')" : "(vi.resetModules(), (await import('./subject.mjs')).check)"};
          for (const [probe, value] of [[check, 1], [other, 2], [check, 3], [other, 4], [other, 5], [check, 6]]) {
            expect(probe(value)).toBe(true);
          }
        });
      `);
      withCopy(root, (workspace, temp) => {
        const trace = join(temp, 'trace');
        mkdirSync(pendingTraceDirectory(trace));
        const binding = mixed ? freshProbeBinding([cjs]) : undefined;
        const probePreload = installProbe(workspace, binding);
        function writeProbe(filename, source, site, preload) {
          const op = source.indexOf('>=');
          writeFileSync(join(workspace, filename), instrument(workspace, filename, source,
            [{ id: site, left: [op - 2, op - 1], right: [op + 3, op + 4], edit: [op, op + 2], operator: '>=', replacement: '>' }],
            preload, new Set(['a', 'b'])));
        }
        writeProbe('subject.mjs', esm, 'a');
        if (mixed) writeProbe('other.cjs', cjs, 'b', binding);
        const result = runVitest(workspace, temp, { trace, probePreload, product: true });
        assert.equal(result.status, 'passed', JSON.stringify(result.tests ?? result));
        const events = readCompletedTrace(trace).filter(row => !row.loaded);
        const expected = [1, 2, 3, 4, 5, 6].flatMap(value => {
          const site = mixed && [2, 4, 5].includes(value) ? 'b' : 'a';
          return [[site], [site, value]];
        });
        assert.deepEqual(events.map(row => row.hit ? [row.hit] : [row.site, row.operands[0]]), expected);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('an overlapping child trace retries before the focused audit trusts ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-trace-child-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'subject.mjs'), 'export const check = n => n >= 0;');
    writeFileSync(join(root, 'other.cjs'), 'module.exports = n => n >= 0;');
    writeFileSync(join(root, 'subject.test.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { expect, it } from 'vitest';
      import { check } from './subject.mjs';
      it('compares before and after a native child', () => {
        expect(check(1)).toBe(true);
        expect(check(2)).toBe(true);
        expect(execFileSync(process.execPath, ['--eval', "console.log(require('./other.cjs')(3))"], { encoding: 'utf8' })).toBe('true\\n');
        expect(check(4)).toBe(true);
      });
      it('does not reach either candidate', () => expect(5).toBe(5));
    `);
    const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.mjs', 'other.cjs', '--deterministic', '--audit'],
      { encoding: 'utf8', timeout: 25_000 });
    assert.equal(run.status, 0, run.error?.message ?? run.stderr + run.stdout);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.instrumented, { status: 'passed', stable: true });
    const trial = report.mutants.find(mutant => mutant.location.file === 'subject.mjs' && mutant.rule === 'comparison-boundary/v1');
    assert.equal(trial?.status, 'survived');
    assert.equal(trial.evidence, 'predicted');
    assert.equal(trial.audit.status, 'agreed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
