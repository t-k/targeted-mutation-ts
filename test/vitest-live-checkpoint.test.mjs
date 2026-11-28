import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function parseCheckpointLines(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function createWarmAndIsolatedFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'vitest-live-checkpoint-fixture',
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
  // 1. `polluteOnFlip` (line 2): when `flag` is mutated to `false`, sets `globalThis.__tmtPolluted = true`
  //    so the in-worker post-trial control run fails (`control-differs`), routing this mutant to isolated fallback.
  //    Placing it before `warmAdd` also ensures it is first in `freshQueue` during `--verify-trials` testing.
  // 2. `warmAdd` (line 10): pure arithmetic, cleanly killed in-worker (warm settled).
  writeFileSync(join(root, 'src/subject.ts'), [
    'export async function polluteOnFlip(flag: boolean): Promise<string> {',
    '  if (flag) {',
    '    return (globalThis as Record<string, unknown>).__tmtPolluted ? "polluted" : "ok";',
    '  }',
    '  (globalThis as Record<string, unknown>).__tmtPolluted = true;',
    '  const delay = Number(process.env.TMT_FIXTURE_DELAY_MS ?? 0);',
    '  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));',
    '  return "flipped";',
    '}',
    '',
    'export function warmAdd(n: number): number {',
    '  return n + 1;',
    '}',
  ].join('\n') + '\n');

  writeFileSync(join(root, 'test/subject.test.ts'), [
    'import { expect, it } from "vitest";',
    'import { polluteOnFlip, warmAdd } from "../src/subject.ts";',
    '',
    'it("keeps polluteOnFlip clean", async () => {',
    '  expect(await polluteOnFlip(true)).toBe("ok");',
    '});',
    '',
    'it("kills warmAdd mutation in worker", () => {',
    '  expect(warmAdd(2)).toBe(3);',
    '});',
  ].join('\n') + '\n');
  return root;
}

test('Vitest live checkpoint persists settled warm kills before isolated fallback, survives SIGINT, and resumes by reusing warm kills', async () => {
  const root = createWarmAndIsolatedFixture('tmt-vitest-live-ckpt-');
  const ckptPath = join(root, 'live-ckpt.jsonl');
  try {
    // 1. Start CLI with --progress and --checkpoint; inspect checkpoint at isolated progress event, then send SIGINT.
    const interrupted = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
        '--mutators', 'full',
        '--lines', 'src/subject.ts:2-2',
        '--lines', 'src/subject.ts:12-12',
        '--timeout', '15',
        '--baseline-timeout', '15',
        '--progress',
        '--checkpoint', ckptPath,
        '--format', 'json',
      ], {
        env: { ...process.env, TMT_FIXTURE_DELAY_MS: '4000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let inspectedAtIsolated = null;
      let sentSigint = false;
      const killGuard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        rejectRun(new Error(`Timed out waiting for isolated fallback progress.\nstderr:\n${stderr}\nstdout:\n${stdout}`));
      }, 60_000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (!sentSigint && /isolated fallback/i.test(stderr)) {
          sentSigint = true;
          inspectedAtIsolated = parseCheckpointLines(ckptPath);
          child.kill('SIGINT');
        }
      });

      child.once('error', err => {
        clearTimeout(killGuard);
        rejectRun(err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(killGuard);
        resolveRun({ code, signal, stdout, stderr, inspectedAtIsolated });
      });
    });

    assert.ok(interrupted.inspectedAtIsolated, `expected isolated fallback progress event.\nstderr:\n${interrupted.stderr}`);
    const warmOutcomes = interrupted.inspectedAtIsolated.filter(
      e => e.event === 'outcome' && e.outcome?.status === 'killed' && e.key.includes('src/subject.ts:'),
    );
    assert.ok(
      warmOutcomes.length >= 1,
      `expected settled warm kill in live checkpoint at isolated fallback event, got:\n${JSON.stringify(interrupted.inspectedAtIsolated, null, 2)}`,
    );

    // Checkpoint must remain parseable after SIGINT.
    const postInterruptEntries = parseCheckpointLines(ckptPath);
    assert.ok(postInterruptEntries.some(e => e.event === 'format'));
    assert.ok(postInterruptEntries.some(e => e.event === 'campaign_started'));
    assert.ok(postInterruptEntries.some(e => e.event === 'outcome' && e.outcome?.status === 'killed'));

    // 2. Resume with the same checkpoint (fast delay now) and assert reuse of the warm kill + evaluation of the interrupted trial.
    const resumeRes = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--lines', 'src/subject.ts:2-2',
      '--lines', 'src/subject.ts:12-12',
      '--timeout', '15',
      '--baseline-timeout', '15',
      '--checkpoint', ckptPath,
      '--format', 'json',
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TMT_FIXTURE_DELAY_MS: '50' },
    });

    assert.equal(resumeRes.status, 0, `expected exit 0 on resume, got ${resumeRes.status}\nstderr:\n${resumeRes.stderr}`);
    const resumed = JSON.parse(resumeRes.stdout);
    assert.equal(resumed.evaluation, 'evaluated');
    assert.equal(resumed.checkpoint?.resumed, true);
    assert.ok(resumed.checkpoint?.reused >= warmOutcomes.length, `expected reused >= ${warmOutcomes.length}, got ${JSON.stringify(resumed.checkpoint)}`);
    assert.ok(resumed.checkpoint?.recorded >= 1, `expected interrupted isolated trial to be evaluated and recorded on resume, got ${JSON.stringify(resumed.checkpoint)}`);
    assert.ok(resumed.mutants.some(m => m.location.line === 2 && m.status === 'killed'));
    assert.ok(resumed.mutants.some(m => m.location.line === 12 && m.status === 'killed'));
    assert.equal(resumed.mutants.filter(m => m.status === 'unevaluated').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vitest live checkpoint respects --verify-trials so sampled warm verdicts remain pending until fresh verification completes', async () => {
  const root = createWarmAndIsolatedFixture('tmt-vitest-live-ckpt-verify-');
  const ckptPath = join(root, 'verify-ckpt.jsonl');
  try {
    // Request --verify-trials 10 so every warm settled verdict is sampled for fresh verification.
    const interrupted = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
        '--mutators', 'full',
        '--lines', 'src/subject.ts:2-2',
        '--lines', 'src/subject.ts:12-12',
        '--verify-trials', '10',
        '--timeout', '15',
        '--baseline-timeout', '15',
        '--progress',
        '--checkpoint', ckptPath,
        '--format', 'json',
      ], {
        env: { ...process.env, TMT_FIXTURE_DELAY_MS: '3000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let inspectedAtIsolated = null;
      let sentSigint = false;
      const killGuard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        rejectRun(new Error(`Timed out waiting for isolated fallback progress.\nstderr:\n${stderr}`));
      }, 60_000);

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (!sentSigint && /isolated fallback/i.test(stderr)) {
          sentSigint = true;
          inspectedAtIsolated = parseCheckpointLines(ckptPath);
          child.kill('SIGINT');
        }
      });

      child.once('error', err => {
        clearTimeout(killGuard);
        rejectRun(err);
      });
      child.once('close', (code, signal) => {
        clearTimeout(killGuard);
        resolveRun({ code, signal, stderr, inspectedAtIsolated });
      });
    });

    assert.ok(interrupted.inspectedAtIsolated, `expected isolated fallback progress event.\nstderr:\n${interrupted.stderr}`);
    const warmAddOutcomes = interrupted.inspectedAtIsolated.filter(
      e => e.event === 'outcome' && e.key.includes('ArithmeticOperator'),
    );
    assert.equal(
      warmAddOutcomes.length,
      0,
      `sampled warm verdict must stay pending before fresh trial finishes, got: ${JSON.stringify(warmAddOutcomes)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vitest live checkpoint supports uninterrupted completion and fresh timeout recovery followed by another eligible trial', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-live-ckpt-complete-'));
  const ckptPath = join(root, 'complete-ckpt.jsonl');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'vitest-live-ckpt-complete',
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
    writeFileSync(join(root, 'src/subject.ts'), [
      'export async function hangOnMutate(): Promise<string> {',
      '  if (true) {',
      '    return "fast";',
      '  }',
      '  await new Promise(() => {});',
      '  return "never";',
      '}',
      '',
      'export function addTwo(n: number): number {',
      '  return n + 2;',
      '}',
    ].join('\n') + '\n');

    writeFileSync(join(root, 'test/subject.test.ts'), [
      'import { expect, it } from "vitest";',
      'import { addTwo, hangOnMutate } from "../src/subject.ts";',
      '',
      'it("returns fast", async () => {',
      '  expect(await hangOnMutate()).toBe("fast");',
      '});',
      '',
      'it("adds two", () => {',
      '  expect(addTwo(3)).toBe(5);',
      '});',
    ].join('\n') + '\n');

    const res = spawnSync(process.execPath, [
      'bin/tmt.mjs', 'analyze', root, 'src/subject.ts',
      '--mutators', 'full',
      '--isolated-trials',
      '--timeout', '2',
      '--baseline-timeout', '15',
      '--checkpoint', ckptPath,
      '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstderr:\n${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.ok(report.mutants.some(m => m.status === 'timeout'));
    assert.ok(report.mutants.some(m => m.location.line === 10 && m.status === 'killed'));
    assert.equal(report.mutants.filter(m => m.status === 'unevaluated').length, 0);

    const entries = parseCheckpointLines(ckptPath);
    assert.ok(entries.some(e => e.event === 'campaign_completed'));
    const outcomeKeys = entries.filter(e => e.event === 'outcome').map(e => e.key);
    assert.equal(outcomeKeys.length, new Set(outcomeKeys).size, 'checkpoint must not contain duplicate outcome keys');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
