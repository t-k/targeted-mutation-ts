import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatSessionFailure, renderText } from '../src/cli-output.mjs';

test('fresh Vitest trial timeout disposes timed-out lane, continues queued mutants, persists warm results, and reports stage/deadline progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-fresh-timeout-'));
  const ckptPath = join(root, 'ckpt.jsonl');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'vitest-fresh-timeout-fixture',
      type: 'module',
      dependencies: { vitest: '*' },
    }));
    writeFileSync(join(root, 'vitest.config.ts'), `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 15000,
  },
});
`);
    // Two independent functions:
    // 1. `hangWhenMutated`: when `BlockStatement` removes the early return or `BooleanLiteral` flips,
    //    the test hangs past the 2s session trial deadline (but under Vitest's 15s testTimeout) -> fresh trial deadline timeout!
    // 2. `checkValue`: simple comparison killed by its test.
    // We use `--isolated-trials` so both mutants run on the fresh trial path in order:
    // the timed-out fresh trial is followed by an independently killed mutant in the same passing-baseline campaign.
    writeFileSync(join(root, 'src/subject.ts'), [
      'export async function guardedWork(): Promise<string> {',
      '  if (true) {',
      '    return "fast";',
      '  }',
      '  await new Promise(() => {});',
      '  return "never";',
      '}',
      '',
      'export function addOne(n: number): number {',
      '  return n + 1;',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'test/subject.test.ts'), [
      'import { expect, it } from "vitest";',
      'import { addOne, guardedWork } from "../src/subject.ts";',
      '',
      'it("returns fast from guardedWork", async () => {',
      '  expect(await guardedWork()).toBe("fast");',
      '});',
      '',
      'it("adds one", () => {',
      '  expect(addOne(2)).toBe(3);',
      '});',
    ].join('\n') + '\n');

    // Run with --isolated-trials --timeout 2 --baseline-timeout 15 --progress --checkpoint
    const res = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--isolated-trials',
      '--timeout', '2',
      '--baseline-timeout', '15',
      '--progress',
      '--checkpoint', ckptPath,
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated', `expected evaluated campaign, got ${report.evaluation}`);
    assert.equal(report.sessionFailure, undefined);

    const timedOut = report.mutants.filter(m => m.status === 'timeout');
    assert.ok(timedOut.length >= 1, 'expected at least one timed-out fresh trial');
    assert.ok(
      timedOut.some(m => m.statusReason === 'Vitest did not finish before its deadline'),
      `expected deadline timeout reason, got: ${JSON.stringify(timedOut.map(m => m.statusReason))}`,
    );

    const addOneKilled = report.mutants.filter(m => m.location.line === 10 && m.status === 'killed');
    assert.ok(addOneKilled.length >= 1, 'expected addOne mutant after timed-out fresh trial to still be independently killed');
    assert.equal(report.mutants.filter(m => m.status === 'unevaluated').length, 0, 'no remaining mutants should be aborted as unevaluated');

    // Progress should surface stage and trial deadline.
    assert.match(res.stderr, /isolated.*2s trial deadline|2s trial deadline/i, `expected stage + trial deadline in progress stderr:\n${res.stderr}`);

    // Resuming from the checkpoint should reuse all decided outcomes without re-running timed-out trials.
    const resumeRes = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--isolated-trials',
      '--timeout', '2',
      '--baseline-timeout', '15',
      '--checkpoint', ckptPath,
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(resumeRes.status, 0, resumeRes.stderr);
    const resumed = JSON.parse(resumeRes.stdout);
    assert.equal(resumed.evaluation, 'evaluated');
    assert.ok(resumed.checkpoint?.reused >= report.mutants.length - report.mutants.filter(m => m.status === 'ignored').length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warm session persists completed in-worker results before fresh fallback timeout and continues remaining fresh trials', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-warm-then-fresh-timeout-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'vitest-warm-fresh-timeout-fixture',
      type: 'module',
      dependencies: { vitest: '*' },
    }));
    writeFileSync(join(root, 'vitest.config.ts'), `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 15000,
  },
});
`);
    // `polluteAndHang`: when mutated, pollutes global state (forcing control-differs -> fresh fallback) or hangs in fresh.
    // `warmKilled`: cleanly killed in-worker before fresh fallback runs.
    writeFileSync(join(root, 'src/subject.ts'), [
      'export async function maybeHang(flag: boolean): Promise<string> {',
      '  if (flag) {',
      '    return "ok";',
      '  }',
      '  await new Promise(() => {});',
      '  return "never";',
      '}',
      '',
      'export function warmDouble(x: number): number {',
      '  return x * 2;',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'test/subject.test.ts'), [
      'import { expect, it } from "vitest";',
      'import { maybeHang, warmDouble } from "../src/subject.ts";',
      '',
      'it("handles flag true", async () => {',
      '  expect(await maybeHang(true)).toBe("ok");',
      '});',
      '',
      'it("doubles number", () => {',
      '  expect(warmDouble(4)).toBe(8);',
      '});',
    ].join('\n') + '\n');

    const res = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--timeout', '2',
      '--baseline-timeout', '15',
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.equal(report.mutants.filter(m => m.status === 'unevaluated').length, 0);
    assert.ok(report.mutants.some(m => m.location.line === 10 && m.status === 'killed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured sessionFailure stores large shared stderr once instead of duplicating it on every unevaluated row', () => {
  const repeatedNoise = 'Error: Not implemented: Window.prototype.scrollTo\n'.repeat(1500); // ~75 KB
  const failure = formatSessionFailure({
    runnerLabel: 'Vitest',
    events: [],
    run: { status: 124, signal: null, stderr: repeatedNoise },
  });
  assert.equal(failure.reason, 'Vitest session stopped (exit 124)');
  assert.equal(failure.exitCode, 124);
  assert.ok(typeof failure.stderr === 'string' && failure.stderr.length > 0);
  assert.ok(failure.stderr.length <= 8250, `expected bounded stderr excerpt, got ${failure.stderr.length}`);

  const mutants = Array.from({ length: 100 }, (_, i) => ({
    id: `m${i}`,
    location: { file: 'src/app.ts', line: i + 1, column: 1 },
    mutatorName: 'ArithmeticOperator',
    original: 'a + b',
    replacement: 'a - b',
    status: 'unevaluated',
    statusReason: failure.reason,
  }));
  const report = {
    schemaVersion: 1,
    runner: 'vitest',
    mutators: 'full',
    evaluation: 'incomplete',
    sessionFailure: failure,
    mutants,
    diagnostics: [],
  };
  const serialized = JSON.stringify(report);
  assert.ok(serialized.length < 64 * 1024, `expected compact report without duplicated stderr, got ${serialized.length} bytes`);
  const text = renderText(report);
  assert.match(text, /Session failure: Vitest session stopped \(exit 124\)/);
});

test('--concurrency 1 recovers a fresh lane for subsequent threshold extras after the last regular fresh trial times out', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-c1-extras-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'vitest-c1-extras-fixture',
      type: 'module',
      dependencies: { vitest: '*' },
    }));
    writeFileSync(join(root, 'vitest.config.ts'), `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    testTimeout: 15000,
  },
});
`);
    // `isAdult`: constant-RHS comparison that triggers a threshold extra (`17`) in `awaitsExtras`.
    // `guarded`: hangs when mutated under `--isolated-trials --concurrency 1 --timeout 2`.
    writeFileSync(join(root, 'src/subject.ts'), [
      'export const isAdult = (age: number) => age >= 18;',
      'export async function guarded(): Promise<string> {',
      '  if (true) {',
      '    return "ok";',
      '  }',
      '  await new Promise(() => {});',
      '  return "never";',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'test/subject.test.ts'), [
      'import { expect, it } from "vitest";',
      'import { guarded, isAdult } from "../src/subject.ts";',
      '',
      'it("checks adult threshold with gap at 17", () => {',
      '  expect(isAdult(20)).toBe(true);',
      '  expect(isAdult(10)).toBe(false);',
      '});',
      '',
      'it("returns ok from guarded", async () => {',
      '  expect(await guarded()).toBe("ok");',
      '});',
    ].join('\n') + '\n');

    const res = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--isolated-trials',
      '--concurrency', '1',
      '--timeout', '2',
      '--baseline-timeout', '15',
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.ok(report.mutants.some(m => m.status === 'timeout'), 'expected timed-out fresh trial');
    const threshold = report.mutants.find(m => m.rule === 'comparison-threshold/v1' && m.replacement === '17');
    assert.ok(threshold, 'expected threshold extra trial to complete after fresh timeout under --concurrency 1');
    assert.equal(threshold.status, 'survived');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
