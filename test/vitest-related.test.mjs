import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeProjectConfig } from '../src/project-config.mjs';
import { resolveRelatedVitestTests } from '../src/vitest.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const scenarios = readFileSync(new URL('../verification/pict/vitest-related.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function makeSampleProject() {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-related-'));
  mkdirSync(resolve(dir, 'src/lib'), { recursive: true });
  mkdirSync(resolve(dir, 'src/test'), { recursive: true });
  mkdirSync(resolve(dir, 'test'), { recursive: true });
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'related-sample', type: 'module' }));
  symlinkSync(repoNodeModules, resolve(dir, 'node_modules'), 'dir');
  writeFileSync(resolve(dir, 'src/lib/math.ts'), 'export function atLeast(n: number) { return n >= 10; }\n');
  writeFileSync(resolve(dir, 'src/lib/wrapper.ts'), "import { atLeast } from './math.ts';\nexport function check(n: number) { return atLeast(n); }\n");
  writeFileSync(resolve(dir, 'src/lib/orphan.ts'), 'export function unused(n: number) { return n >= 5; }\n');
  writeFileSync(resolve(dir, 'src/lib/math.test.ts'), "import { expect, test } from 'vitest';\nimport { atLeast } from './math.ts';\ntest('direct', () => { expect(atLeast(10)).toBe(true); expect(atLeast(9)).toBe(false); });\n");
  writeFileSync(resolve(dir, 'src/test/integration.test.ts'), "import { expect, test } from 'vitest';\nimport { check } from '../lib/wrapper.ts';\ntest('transitive', () => { expect(check(12)).toBe(true); });\n");
  // Unrelated failing test: if --related failed to filter, baseline would fail!
  writeFileSync(resolve(dir, 'test/unrelated.test.ts'), "import { expect, test } from 'vitest';\ntest('unrelated fails', () => { expect(1).toBe(2); });\n");
  return dir;
}

test('resolveRelatedVitestTests finds direct and transitive tests and ignores unrelated tests', async () => {
  const dir = makeSampleProject();
  try {
    const related = await resolveRelatedVitestTests(dir, ['src/lib/math.ts']);
    assert.deepEqual(related, ['src/lib/math.test.ts', 'src/test/integration.test.ts']);

    await assert.rejects(
      () => resolveRelatedVitestTests(dir, ['src/lib/orphan.ts']),
      /No Vitest test files are related to src\/lib\/orphan\.ts\. Specify test files explicitly with --test <FILE>\./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --related runs only related tests and bypasses unrelated failing test suite', () => {
  const dir = makeSampleProject();
  try {
    const run = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/lib/math.ts', '--related', '--progress', '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /\[tmt\] Selected 2 related test files\./);
    const report = JSON.parse(run.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.deepEqual(report.selection.tests, ['src/lib/math.test.ts', 'src/test/integration.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --related runs discovery in CI=true copy and preserves Vitest project selection', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-related-proj-'));
  try {
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    mkdirSync(resolve(dir, 'test'), { recursive: true });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'related-projects', type: 'module' }));
    symlinkSync(repoNodeModules, resolve(dir, 'node_modules'), 'dir');
    writeFileSync(resolve(dir, 'src/alpha.ts'), 'export function fn(n: number) { return n >= 10; }\n');
    writeFileSync(resolve(dir, 'src/beta.ts'), 'export function fn(n: number) { return n >= 20; }\n');
    writeFileSync(resolve(dir, 'test/shared.test.ts'), [
      "import { expect, test } from 'vitest';",
      "import { fn } from '@target';",
      "test('shared', () => { expect(fn(10)).toBe(true); expect(fn(9)).toBe(false); });",
    ].join('\n') + '\n');
    // Project 'alpha' maps @target -> src/alpha.ts (passes); project 'beta' maps @target -> src/beta.ts (fails fn(10)===true!).
    // Also gates include on process.env.CI === 'true'.
    writeFileSync(resolve(dir, 'vitest.config.mjs'), [
      "import { resolve } from 'node:path';",
      'export default {',
      '  test: {',
      '    projects: [',
      "      { test: { name: 'alpha', include: process.env.CI === 'true' ? ['test/shared.test.ts'] : [] }, resolve: { alias: { '@target': resolve(import.meta.dirname, 'src/alpha.ts') } } },",
      "      { test: { name: 'beta', include: process.env.CI === 'true' ? ['test/shared.test.ts'] : [] }, resolve: { alias: { '@target': resolve(import.meta.dirname, 'src/beta.ts') } } },",
      '    ],',
      '  },',
      '};',
    ].join('\n') + '\n');

    const run = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/alpha.ts', '--related', '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, CI: '' } });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.equal(report.baseline.tests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vitest-related PICT matrix: CLI/config validation, precedence, unmatched, empty scope, and --list', () => {
  const dir = makeSampleProject();
  try {
    for (const [runner, relatedFlag, testFlag, targetScope, listMode] of scenarios) {
      const configObj = {
        ...(relatedFlag === 'Config' ? { related: true } : {}),
        ...(testFlag === 'Config' ? { tests: ['src/lib/math.test.ts'] } : {}),
      };
      const cliValues = {
        ...(runner === 'Playwright' ? { runner: 'playwright' } : {}),
        ...(relatedFlag === 'Cli' ? { related: true } : {}),
        ...(testFlag === 'Cli' ? { test: ['src/lib/math.test.ts'] } : {}),
        ...(listMode === 'On' ? { list: true } : {}),
      };
      const merged = mergeProjectConfig(Object.keys(configObj).length ? configObj : null, cliValues, []);
      // Precedence invariants:
      if (relatedFlag === 'Config' && testFlag === 'Cli') {
        assert.equal(merged.values.related, undefined, 'CLI --test overrides config related');
        assert.deepEqual(merged.values.test, ['src/lib/math.test.ts']);
      }
      if (relatedFlag === 'Cli' && testFlag === 'Config') {
        assert.equal(merged.values.related, true);
        assert.equal(merged.values.test, undefined, 'CLI --related overrides config tests');
      }

      // Exercise key CLI error / success paths for representative PICT rows:
      if (runner === 'Playwright' && relatedFlag === 'Cli' && testFlag === 'Off') {
        const res = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/lib/math.ts', '--runner', 'playwright', '--related'], { encoding: 'utf8' });
        assert.equal(res.status, 1);
        assert.match(res.stderr, /--related requires Vitest/);
      } else if (runner === 'Vitest' && relatedFlag === 'Cli' && testFlag === 'Cli' && targetScope === 'ExplicitMatched' && listMode === 'Off') {
        const res = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/lib/math.ts', '--related', '--test', 'src/lib/math.test.ts', '--format', 'json'], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        const report = JSON.parse(res.stdout);
        assert.equal(report.evaluation, 'evaluated');
        assert.deepEqual(report.selection.tests, ['src/lib/math.test.ts']);
      } else if (runner === 'Vitest' && relatedFlag === 'Cli' && testFlag === 'Off' && targetScope === 'ExplicitUnmatched' && listMode === 'Off') {
        const res = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/lib/orphan.ts', '--related'], { encoding: 'utf8' });
        assert.equal(res.status, 1);
        assert.match(res.stderr, /No Vitest test files are related.*--test <FILE>/);
      } else if (runner === 'Vitest' && relatedFlag === 'Cli' && testFlag === 'Off' && targetScope === 'ExplicitMatched' && listMode === 'On') {
        const res = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/lib/math.ts', '--related', '--list', '--format', 'json'], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        const report = JSON.parse(res.stdout);
        assert.equal(report.evaluation, 'listed');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
