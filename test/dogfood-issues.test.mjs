import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBuiltinSwitches } from '../src/builtin-switches.mjs';
import { targetedGap } from '../src/targeted-gaps.mjs';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderText } from '../src/cli-output.mjs';
import { assessTrial } from '../src/standard-plan.mjs';
import { extractLoopCounterNonNegative, filterReachableThresholdGap } from '../src/reachability.mjs';
import { thresholdGap } from '../src/threshold.mjs';
import { gitignoredCopyExclusions, loadProjectConfig, mergeProjectConfig, validateAndExpandInputs } from '../src/project-config.mjs';
import { tmtIgnoreLines } from '../src/baseline.mjs';
import { openCheckpoint } from '../src/checkpoint.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));

describe('dogfood issues 001-007 and review regressions', () => {
  it('issue 001: baseline timeout text prints timeout limit and actionable guidance', () => {
    const text = renderText({
      evaluation: 'baseline_error',
      baseline: { status: 'timeout', timeoutSeconds: 60, output: 'Not implemented: scrollTo' },
    });
    assert.match(text, /timed out after 60s/);
    assert.match(text, /--timeout/);
    assert.match(text, /--test/);
  });

  it('issue 002: copy-dropped/v1 classifies Object.create(null) spread as nonPlain (spreadCoercion advice)', () => {
    const src = 'export function wrap() { const obj = Object.create(null); obj.a = 1; return { ...obj }; }\n';
    const rendered = renderBuiltinSwitches(Buffer.from(src), 'src/wrap.ts', () => true, { targeted: true });
    const copyMutant = rendered.mutants.find(m => m.mutatorName === 'copy-dropped/v1');
    assert.ok(copyMutant);
    // Execute the instrumented code to verify the runtime probe records nonPlain (not realCopy).
    const prev = globalThis.__stryker__;
    try {
      globalThis.__stryker__ = { currentTestId: 't1' };
      const fn = new Function(rendered.output.replace('export function wrap()', 'function wrap()') + '\nreturn wrap();');
      const result = fn();
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      const observed = globalThis.__stryker__.targetedObserved?.[copyMutant.id];
      assert.equal(observed?.realCopy, undefined);
      assert.equal(observed?.nonPlain, true);
      const gap = targetedGap({ ...copyMutant, status: 'survived' }, { agreeing: 1, differing: [], nonPlain: true });
      assert.match(gap.advice, /prototype/);
    } finally {
      globalThis.__stryker__ = prev;
    }
  });

  it('issue 003: unhandled runtime error after active mutant hit is classified as killed', () => {
    const trial = {
      snapshot: {
        errors: ["TypeError: Cannot read properties of undefined (reading 'request')"],
        reason: 'failed',
        tests: [],
      },
      records: [{ hits: 2 }],
    };
    const res = assessTrial(trial, new Map(), 100);
    assert.equal(res.status, 'killed');
    assert.equal(res.killedBy, 'unhandled-error');

    // When hitCount === 0 (runner/load error before reaching mutant), remain error.
    const preHit = assessTrial({ ...trial, records: [{ hits: 0 }] }, new Map(), 100);
    assert.equal(preHit.status, 'error');
  });

  it('issue 004: skips nullish-equality/v1 for typeof x === "object" && x !== null and honors --exclude-rule', () => {
    const guarded = 'export const isObj = (v: unknown) => typeof v === "object" && v !== null;\n';
    const mGuarded = collectMutations(guarded, 'a.ts', { targeted: true });
    assert.equal(mGuarded.filter(m => m.name === 'nullish-equality/v1').length, 0);

    const reversed = 'export const isObj = (v: unknown) => v !== null && typeof v === "object";\n';
    const mReversed = collectMutations(reversed, 'a.ts', { targeted: true });
    assert.equal(mReversed.filter(m => m.name === 'nullish-equality/v1').length, 0);

    const unguarded = 'export const f = (v: string | null) => v !== null;\n';
    const mNormal = collectMutations(unguarded, 'a.ts', { targeted: true });
    assert.ok(mNormal.some(m => m.name === 'nullish-equality/v1'));

    const mExcluded = collectMutations(unguarded, 'a.ts', { targeted: true, excludeRules: ['nullish-equality/v1'] });
    assert.equal(mExcluded.filter(m => m.name === 'nullish-equality/v1').length, 0);
  });

  it('issue 005: fails fast with clean project-relative path before copying when --test or source is missing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-issue005-'));
    try {
      mkdirSync(resolve(dir, 'src'), { recursive: true });
      writeFileSync(resolve(dir, 'src/a.ts'), 'export const x = (n: number) => n >= 1;\n');
      const run = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/a.ts', '--test', 'src/missing.test.ts'], { encoding: 'utf8' });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Test file not found: src\/missing\.test\.ts/);
      assert.doesNotMatch(run.stderr, /\/tmt-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('issue 006: suppresses unreachable negative witness (-1, 0) for 0-based loop counter compared to length', () => {
    const src = [
      'export function match(value: number[], origItems: number[]) {',
      '  for (let i = 0; i < value.length; i++) {',
      '    if (i < origItems.length) return i;',
      '  }',
      '  return -1;',
      '}',
    ].join('\n');
    const offset = src.indexOf('i < origItems.length');
    const constraint = extractLoopCounterNonNegative(src, offset, 'i');
    assert.deepEqual(constraint, { kind: 'nonNegative', min: 0 });
    const rawGap = thresholdGap(0, [0, 1], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '<');
    assert.ok(rawGap !== null);
    assert.equal(filterReachableThresholdGap(rawGap, constraint, 0, '<', [0, 1]), null);
  });

  it('issue 007: loads targeted-mutation.config.json, expands globs, and excludes gitignored paths', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-issue007-'));
    try {
      mkdirSync(resolve(dir, 'src/lib'), { recursive: true });
      mkdirSync(resolve(dir, 'dist'), { recursive: true });
      writeFileSync(resolve(dir, 'src/lib/a.ts'), 'export const a = 1;\n');
      writeFileSync(resolve(dir, 'src/lib/a.test.ts'), 'export {};\n');
      writeFileSync(resolve(dir, 'dist/bundle.js'), 'console.log(1);\n');
      writeFileSync(resolve(dir, '.gitignore'), 'dist/\n');
      writeFileSync(resolve(dir, 'targeted-mutation.config.json'), JSON.stringify({
        files: ['src/lib/*.ts'],
        tests: ['src/lib/*.test.ts'],
        timeout: 120,
        excludeRules: ['nullish-equality/v1'],
        copyExcludeGitignore: true,
      }));
      execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });

      const loaded = await loadProjectConfig(dir);
      assert.equal(loaded.source, 'targeted-mutation.config.json');
      const merged = mergeProjectConfig(loaded.config, {}, []);
      assert.equal(merged.values.timeout, '120');
      assert.deepEqual(merged.values['exclude-rule'], ['nullish-equality/v1']);

      const validated = validateAndExpandInputs(dir, ['src/lib/a.ts'], { test: merged.values.test });
      assert.deepEqual(validated.tests, ['src/lib/a.test.ts']);

      const ignored = gitignoredCopyExclusions(dir);
      assert.ok(ignored.includes('dist'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('review fixes: tmt:ignore handles template strings and regex literals; checkpoint refuses non-checkpoint overwrite', () => {
    const src = [
      'const s = `${x} // tmt:ignore fake`;',
      'const r = /"/; const ok = a >= 1; // tmt:ignore real',
    ].join('\n');
    const lines = tmtIgnoreLines(src);
    assert.equal(lines.has(0), false);
    assert.equal(lines.get(1), 'real');

    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-ckpt-guard-'));
    try {
      const important = resolve(dir, 'important.txt');
      writeFileSync(important, 'do not overwrite me\n');
      assert.throws(() => openCheckpoint(important, 'ctx1'), /Refusing to overwrite non-checkpoint file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
