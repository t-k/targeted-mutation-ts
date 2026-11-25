import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const assertionSessionScript = fileURLToPath(new URL('../src/assertion-session.mjs', import.meta.url));
const pictRows = readFileSync(new URL('../verification/pict/vitest-version-compat.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const localRequire = createRequire(import.meta.url);
const installedVitestPkg = localRequire.resolve('vitest/package.json');
const installedModulesDir = resolve(dirname(installedVitestPkg), '..');
const vitest5Modules = process.env.TMT_VITEST5_NODE_MODULES ? resolve(process.env.TMT_VITEST5_NODE_MODULES) : null;

function activeModulesList() {
  const list = [{ label: 'installed-vitest', modulesDir: installedModulesDir }];
  if (vitest5Modules && existsSync(vitest5Modules) && vitest5Modules !== installedModulesDir) {
    list.push({ label: 'vitest-5', modulesDir: vitest5Modules });
  }
  return list;
}

function vitestVersionOf(modulesDir) {
  const req = createRequire(join(modulesDir, '_noop.js'));
  return req('./vitest/package.json').version;
}

function fsCacheConfigSnippet(version, extra = '') {
  const prefix = extra ? `${extra}, ` : '';
  return version.startsWith('5.')
    ? `export default { test: { ${prefix}fsModuleCache: true } };\n`
    : `export default { test: { ${prefix}experimental: { fsModuleCache: true } } };\n`;
}

function assertNoFsCacheCreated(root, modulesDir, beforeFlags) {
  assert.equal(existsSync(join(root, 'node_modules', '.vitest-cache')), false);
  assert.equal(existsSync(join(root, 'node_modules', '.experimental-vitest-cache')), false);
  if (!beforeFlags.v5) assert.equal(existsSync(join(modulesDir, '.vitest-cache')), false);
  if (!beforeFlags.v4) assert.equal(existsSync(join(modulesDir, '.experimental-vitest-cache')), false);
}

function withVitestProject(modulesDir, files, action) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-compat-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  let pending = false;
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['vitest', 'vite']) {
      if (existsSync(join(modulesDir, name))) {
        symlinkSync(join(modulesDir, name), join(root, 'node_modules', name), 'dir');
      }
    }
    // Link `@vitest/*` packages individually so tests overriding `node_modules/@vitest/runner/...`
    // never write through a directory symlink into `modulesDir/@vitest`.
    const scopedDir = join(modulesDir, '@vitest');
    if (existsSync(scopedDir)) {
      mkdirSync(join(root, 'node_modules', '@vitest'), { recursive: true });
      const overridden = new Set(
        Object.keys(files)
          .filter(key => key.startsWith('node_modules/@vitest/'))
          .map(key => key.split('/')[2]),
      );
      for (const entry of readdirSync(scopedDir)) {
        if (!overridden.has(entry)) {
          symlinkSync(join(scopedDir, entry), join(root, 'node_modules', '@vitest', entry), 'dir');
        }
      }
    }
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    const result = action(root);
    pending = typeof result?.then === 'function';
    return pending ? result.finally(cleanup) : result;
  } finally {
    if (!pending) cleanup();
  }
}

for (const { label, modulesDir } of activeModulesList()) {
  const version = vitestVersionOf(modulesDir);

  test(`[${label} v${version}] observes comparisons in ESM and CommonJS under --audit without polluting fsModuleCache`, () => {
    const beforeFlags = {
      v5: existsSync(join(modulesDir, '.vitest-cache')),
      v4: existsSync(join(modulesDir, '.experimental-vitest-cache')),
    };
    withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-probe', type: 'module' }),
      'vitest.config.mjs': fsCacheConfigSnippet(version),
      'src/age.ts': 'export const isAdult = (age: number) => age >= 18;\n',
      'src/legacy.cjs': '"use strict";\nmodule.exports = value => value >= 10;\n',
      'test/age.test.ts': [
        "import { createRequire } from 'node:module';",
        "import { expect, it } from 'vitest';",
        "import { isAdult } from '../src/age';",
        "const legacy = createRequire(import.meta.url)('../src/legacy.cjs');",
        "it('checks adult above threshold', () => { expect(isAdult(20)).toBe(true); expect(isAdult(10)).toBe(false); });",
        "it('checks legacy boundary', () => { expect(legacy(10)).toBe(true); });",
      ].join('\n') + '\n',
    }, root => {
      const run = spawnSync(process.execPath, [
        cli, 'analyze', root, 'src/age.ts', 'src/legacy.cjs', '--deterministic', '--audit', '--format', 'json',
      ], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const report = JSON.parse(run.stdout);
      assert.equal(report.evaluation, 'evaluated');
      assert.equal(report.instrumented.status, 'passed');
      assert.equal(report.instrumented.stable, true);
      const thresholdMutant = report.mutants.find(m => m.location.file === 'src/age.ts' && m.rule === 'comparison-threshold/v1');
      assert.ok(thresholdMutant, 'expected synthesized comparison-threshold/v1 mutant');
      assert.equal(thresholdMutant.status, 'survived');
      assert.equal(thresholdMutant.evidence, 'predicted');
      assert.equal(thresholdMutant.audit.status, 'agreed');
      const cjsBoundary = report.mutants.find(m => m.location.file === 'src/legacy.cjs' && m.rule === 'comparison-boundary/v1');
      assert.equal(cjsBoundary.status, 'killed');
      assert.equal(cjsBoundary.audit.status, 'agreed');
      const cjsThreshold = report.mutants.find(m => m.location.file === 'src/legacy.cjs' && m.rule === 'comparison-threshold/v1');
      assert.ok(cjsThreshold, 'expected CommonJS threshold mutant');
      assert.equal(cjsThreshold.status, 'survived');
      assertNoFsCacheCreated(root, modulesDir, beforeFlags);
    });
  });

  test(`[${label} v${version}] runs in-worker switched session matching isolated trials with worker hazards and fsModuleCache isolation`, () => {
    const beforeFlags = {
      v5: existsSync(join(modulesDir, '.vitest-cache')),
      v4: existsSync(join(modulesDir, '.experimental-vitest-cache')),
    };
    withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-session', type: 'module' }),
      'vitest.config.mjs': fsCacheConfigSnippet(version, 'testTimeout: 250, hookTimeout: 250'),
      'src/subject.ts': [
        'export const fee = (cents: number, rate: number) => cents * rate;',
        'export const fallback = (count?: number | null) => count ?? 10;',
        'export const margin = (score: number, pass: number) => score >= pass + 5;',
        'export function spin(n: number) { let i = 0; while (i < n) i++; return i; }',
        'export async function wait(n: number) { if (n > 7) return "done"; return new Promise(() => {}); }',
        'export const TABLE = [1, 2].map(n => n * 2);',
        'export function leak(n: number) { (globalThis as any).__leaked = n > 3 ? "mut" : "orig"; return n; }',
        'export function readLeak() { return (globalThis as any).__leaked ?? "clean"; }',
        'export function lateBoom(n: number) { return n > 5 ? "ok" : "bad"; }',
      ].join('\n') + '\n',
      'src/names.ts': "export const NAMES = ['a', 'cc'].filter(s => s.length < 2);\n",
      'test/subject.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { TABLE, fallback, fee, lateBoom, leak, margin, readLeak, spin, wait } from '../src/subject';",
        "it('clean before leak', () => expect(readLeak()).toBe('clean'));",
        "it('weak fee assertion', () => expect(fee(200, 3)).toBeGreaterThan(0));",
        "it('fallback non-falsy only', () => { expect(fallback(undefined)).toBe(10); expect(fallback(4)).toBe(4); });",
        "it('margin with gap', () => { expect(margin(20, 10)).toBe(true); expect(margin(12, 12)).toBe(false); });",
        "it('table', () => expect(TABLE).toEqual([2, 4]));",
        "it('spin', () => expect(spin(3)).toBe(3));",
        "it('wait', async () => expect(await wait(8)).toBe('done'));",
        "it('lateBoom', () => { void Promise.resolve().then(() => { if (lateBoom(7) !== 'ok') throw new Error('late'); }); });",
        "it('leak', () => { expect(leak(5)).toBe(5); expect(readLeak()).toBe('mut'); });",
      ].join('\n') + '\n',
      'test/names.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { NAMES } from '../src/names';",
        "for (const name of NAMES) it('case ' + name, () => expect(name.length).toBe(1));",
      ].join('\n') + '\n',
    }, root => {
      const shared = spawnSync(process.execPath, [
        cli, 'analyze', root, 'src/subject.ts', 'src/names.ts', '--mutators', 'full', '--concurrency', '2', '--verify-trials', '4', '--timeout', '5', '--format', 'json',
      ], { encoding: 'utf8', timeout: 120_000 });
      assert.equal(shared.status, 0, shared.stderr + shared.stdout);
      const sharedReport = JSON.parse(shared.stdout);
      assert.equal(sharedReport.evaluation, 'evaluated');
      assert.equal(sharedReport.operatorExecution, 'session');
      assert.ok(sharedReport.trials.inWorker >= 10, JSON.stringify(sharedReport.trials));
      assert.deepEqual(sharedReport.trials.verified, { sampled: 4, mismatches: [] });

      const isolated = spawnSync(process.execPath, [
        cli, 'analyze', root, 'src/subject.ts', 'src/names.ts', '--mutators', 'full', '--isolated-trials', '--timeout', '5', '--format', 'json',
      ], { encoding: 'utf8', timeout: 120_000 });
      assert.equal(isolated.status, 0, isolated.stderr + isolated.stdout);
      const isolatedReport = JSON.parse(isolated.stdout);
      assert.equal(isolatedReport.operatorExecution, 'session');
      assert.equal(isolatedReport.trials.inWorker, 0);

      const byKey = report => new Map(report.mutants.map(m => [`${m.location.file}:${m.edit}:${m.replacement}`, m]));
      const expected = byKey(isolatedReport);
      for (const [key, mutant] of byKey(sharedReport)) {
        assert.equal(mutant.status, expected.get(key)?.status, `verdict mismatch for ${key}`);
      }
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'ASSERTION GAP' && d.rule === 'arithmetic-swap/v1'));
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'INPUT GAP' && d.rule === 'nullish-fallback/v1'));
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'INPUT GAP' && d.rule === 'comparison-margin/v1'));
      const reasons = new Set(sharedReport.mutants.map(m => m.fallback).filter(Boolean));
      for (const reason of ['control-differs', 'unhandled-error', 'tests-changed']) {
        assert.ok(reasons.has(reason), `missing fallback ${reason} in ${[...reasons].join(',')}`);
      }
      assertNoFsCacheCreated(root, modulesDir, beforeFlags);
    });
  });

  if (version.startsWith('5.')) {
    test(`[${label} v${version}] falls back on viteModuleRunner:false, ignores hoisted @vitest/runner 4.x, and classifies aroundEach/aroundAll timeouts`, () => {
      withVitestProject(modulesDir, {
        'package.json': JSON.stringify({ name: 'compat-native-esm', type: 'module' }),
        'vitest.config.mjs': 'export default { test: { hookTimeout: 150, experimental: { viteModuleRunner: false } } };\n',
        'src/init.ts': 'export const BOOT = 10 >= 5 ? "ready" : "broken";\n',
        'test/init.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { BOOT } from '../src/init.ts';",
          "it('checks boot constant', () => expect(BOOT).toBe('ready'));",
        ].join('\n') + '\n',
      }, root => {
        const run = spawnSync(process.execPath, [
          cli, 'analyze', root, 'src/init.ts', '--mutators', 'full', '--format', 'json',
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        const report = JSON.parse(run.stdout);
        assert.equal(report.evaluation, 'evaluated');
        assert.equal(report.operatorExecution, 'source-rewrite');
        assert.ok(report.mutants.some(m => m.status === 'killed'));
      });

      // Coexisting foreign `@vitest/runner` 4.x in the dependency tree must never be imported by Vitest 5,
      // and must not leak into `modulesDir/@vitest`:
      const foreignRunnerExistedBefore = existsSync(join(modulesDir, '@vitest', 'runner'));
      withVitestProject(modulesDir, {
        'package.json': JSON.stringify({ name: 'compat-foreign-runner-4', type: 'module' }),
        'node_modules/@vitest/runner/package.json': JSON.stringify({ name: '@vitest/runner', version: '4.0.18', type: 'module', exports: './index.js' }),
        'node_modules/@vitest/runner/index.js': "throw new Error('Loaded foreign @vitest/runner 4.x under Vitest 5');\n",
        'src/gate.ts': [
          'export function allowEach(ok: boolean) { if (ok) return true; return false; }',
          'export function allowAllSetup(ok: boolean) { if (ok) return true; return false; }',
          'export function allowAllTeardown(ok: boolean) { if (ok) return true; return false; }',
        ].join('\n') + '\n',
        'src/control-trap.ts': [
          'export function armControlTrap(n: number) { if (n > 5) (globalThis as any).__trapTeardown = true; return n; }',
        ].join('\n') + '\n',
        'vitest.config.mjs': 'export default { test: { hookTimeout: 150 } };\n',
        'test/gate.test.ts': [
          "import { aroundAll, aroundEach, describe, expect, it } from 'vitest';",
          "import { allowAllSetup, allowAllTeardown, allowEach } from '../src/gate';",
          "aroundAll(async runSuite => {",
          "  if (!allowAllSetup(true)) await new Promise(() => {});",
          "  await runSuite();",
          "});",
          "describe('nested aroundAll teardown', () => {",
          "  aroundAll(async runSuite => {",
          "    await runSuite();",
          "    if (!allowAllTeardown(true)) await new Promise(() => {});",
          "  });",
          "  aroundEach(async runTest => {",
          "    if (!allowEach(true)) await new Promise(() => {});",
          "    await runTest();",
          "  });",
          "  it('runs under aroundAll and aroundEach', () => {",
          "    expect(allowEach(true)).toBe(true);",
          "    expect(allowAllSetup(true)).toBe(true);",
          "    expect(allowAllTeardown(true)).toBe(true);",
          "  });",
          "});",
        ].join('\n') + '\n',
        'test/control-trap.test.ts': [
          "import { aroundAll, expect, it } from 'vitest';",
          "import { armControlTrap } from '../src/control-trap';",
          "aroundAll(async runSuite => {",
          "  const armedBeforeSuite = Boolean((globalThis as any).__trapTeardown);",
          "  await runSuite();",
          "  if (armedBeforeSuite) await new Promise(() => {});",
          "});",
          "it('passes trial then hangs control aroundAll teardown', () => {",
          "  expect(armControlTrap(1)).toBe(1);",
          "});",
        ].join('\n') + '\n',
      }, root => {
        for (const extraFlags of [[], ['--isolated-trials']]) {
          const run = spawnSync(process.execPath, [
            cli, 'analyze', root, 'src/gate.ts', '--test', 'test/gate.test.ts', '--mutators', 'full', '--timeout', '5', '--format', 'json', ...extraFlags,
          ], { encoding: 'utf8', timeout: 60_000 });
          assert.equal(run.status, 0, run.stderr + run.stdout);
          const report = JSON.parse(run.stdout);
          assert.equal(report.evaluation, 'evaluated');
          assert.equal(report.operatorExecution, 'session');
          const condFalseMutants = report.mutants.filter(m => m.original === 'ok' && m.replacement === 'false');
          assert.equal(condFalseMutants.length, 3);
          for (const mutant of condFalseMutants) {
            assert.equal(mutant.status, 'timeout', `expected timeout for line ${mutant.location.line} (${extraFlags.join(' ') || 'in-worker'}): ${JSON.stringify(mutant)}`);
          }
        }
        // When `n > 5` -> `true` arms `__trapTeardown`, the trial itself passes (`current === 1`) and ONLY the
        // control run (`current === 2`) times out in `aroundAll` teardown; `control.timeout` must reject the
        // tainted worker verdict and re-evaluate in an isolated run:
        const trapRun = spawnSync(process.execPath, [
          cli, 'analyze', root, 'src/control-trap.ts', '--test', 'test/control-trap.test.ts', '--mutators', 'full', '--timeout', '5', '--format', 'json',
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(trapRun.status, 0, trapRun.stderr + trapRun.stdout);
        const trapReport = JSON.parse(trapRun.stdout);
        assert.equal(trapReport.evaluation, 'evaluated');
        const trapMutant = trapReport.mutants.find(m => m.original === 'n > 5' && m.replacement === 'true');
        assert.equal(trapMutant?.fallback, 'control-differs');
        assert.equal(trapMutant?.status, 'survived');
      });
      if (!foreignRunnerExistedBefore) {
        assert.equal(existsSync(join(modulesDir, '@vitest', 'runner')), false);
      }
    });
  }

  test(`[${label} v${version}] runs warm assertion-session IPC, globalSetup fallback, and --related --suggest-assertions without cache pollution`, async () => {
    const beforeFlags = {
      v5: existsSync(join(modulesDir, '.vitest-cache')),
      v4: existsSync(join(modulesDir, '.experimental-vitest-cache')),
    };
    await withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-warm-related', type: 'module' }),
      'vitest.config.mjs': fsCacheConfigSnippet(version),
      'src/fees.ts': [
        'export const fee = (cents: number, rate: number) => cents * rate;',
        'export function syncStore(store: { dirty: boolean }, changed: boolean, ready: boolean) { if (changed && ready) store.dirty = true; }',
      ].join('\n') + '\n',
      'src/orphan.ts': 'export const unused = (n: number) => n >= 1;\n',
      'test/fees.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { fee, syncStore } from '../src/fees';",
        "it('charges weakly', () => { expect(fee(200, 3)).toBeGreaterThan(0); });",
        "it('updates proxy store without asserting dirty', () => {",
        "  const store = new Proxy({ dirty: false }, {});",
        "  syncStore(store, false, true);",
        "  expect(typeof store.dirty).toBe('boolean');",
        "});",
      ].join('\n') + '\n',
      'test/unrelated.test.ts': "import { expect, it } from 'vitest';\nit('unrelated broken test', () => expect(1).toBe(2));\n",
    }, async root => {
      const subjectContent = readFileSync(join(root, 'src/fees.ts'));
      const subjectDigest = createHash('sha256').update(subjectContent).digest('hex');
      const child = spawn(process.execPath, [assertionSessionScript, root, 'vitest.config.mjs'], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          VITE_CACHE_DIR: join(root, '.tmp-vite'),
          VITEST_FS_MODULE_CACHE: 'false',
          VITEST_FS_MODULE_CACHE_PATH: join(root, '.tmp-fs-cache'),
        },
      });
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      const messages = [];
      const nextMessage = (timeoutMs = 15_000) => new Promise((resolveMsg, rejectMsg) => {
        if (messages.length) return resolveMsg(messages.shift());
        const timer = setTimeout(() => { cleanup(); rejectMsg(new Error('Timed out waiting for warm session IPC message')); }, timeoutMs);
        const onMsg = msg => { cleanup(); resolveMsg(msg); };
        const onExit = code => { cleanup(); rejectMsg(new Error(`warm session exited early (${code})`)); };
        const cleanup = () => { clearTimeout(timer); child.off('message', onMsg); child.off('exit', onExit); };
        child.on('message', onMsg);
        child.on('exit', onExit);
      });
      child.on('message', msg => messages.push(msg));
      try {
        const boot = await nextMessage();
        messages.length = 0;
        assert.equal(boot.ready, true, JSON.stringify(boot));
        const rewriteTest = [
          "import { appendFileSync } from 'node:fs';",
          "import { it } from 'vitest';",
          "import { fee } from '../src/fees';",
          "it('records', () => { appendFileSync('.collect.jsonl', String(fee(200, 3)) + '\\n'); });",
        ].join('\n') + '\n';
        const multIndex = subjectContent.indexOf('cents * rate');
        child.send({ id: 1, testFile: 'test/fees.test.ts', rewriteContent: rewriteTest, collect: '.collect.jsonl' });
        const origReply = await nextMessage();
        messages.length = 0;
        assert.equal(origReply.collected.trim(), '600');

        child.send({
          id: 2,
          testFile: 'test/fees.test.ts',
          rewriteContent: rewriteTest,
          collect: '.collect.jsonl',
          subjectFile: 'src/fees.ts',
          subjectDigest,
          trial: { edit: [multIndex, multIndex + 'cents * rate'.length], replacement: '(cents + rate)' },
        });
        const editedReply = await nextMessage();
        messages.length = 0;
        assert.equal(editedReply.collected.trim(), '203');

        child.send({ id: 3, testFile: 'test/fees.test.ts', rewriteContent: rewriteTest, collect: '.collect.jsonl' });
        const restoredReply = await nextMessage();
        messages.length = 0;
        assert.equal(restoredReply.collected.trim(), '600');
      } finally {
        if (child.connected) child.send({ close: true });
        if (child.exitCode === null && child.signalCode === null) {
          let closeTimer;
          try {
            await Promise.race([
              exited,
              new Promise((_, rejectWait) => {
                closeTimer = setTimeout(() => { child.kill('SIGKILL'); rejectWait(new Error('Timed out closing warm session')); }, 10_000);
              }),
            ]);
          } finally {
            clearTimeout(closeTimer);
          }
        }
        rmSync(join(root, '.tmp-vite'), { recursive: true, force: true });
        rmSync(join(root, '.tmp-fs-cache'), { recursive: true, force: true });
      }

      const run = spawnSync(process.execPath, [
        cli, 'analyze', root, 'src/fees.ts', '--related', '--suggest-assertions', '--format', 'json',
      ], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const report = JSON.parse(run.stdout);
      assert.equal(report.evaluation, 'evaluated');
      assert.deepEqual(report.selection.tests, ['test/fees.test.ts']);
      const suggested = report.diagnostics.map(d => d.suggestedTest).filter(Boolean);
      assert.ok(suggested.includes('expect(fee(200, 3)).toBe(600)'), JSON.stringify(suggested));
      assert.ok(suggested.includes('expect(store.dirty).toBe(false)'), JSON.stringify(suggested));
      assertNoFsCacheCreated(root, modulesDir, beforeFlags);
    });

    // Projects with `globalSetup` must decline the warm assertion session so `globalSetup` re-runs per edited trial:
    await withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-global-setup', type: 'module' }),
      'global-setup.mjs': [
        "import { computeSeed } from './src/seed.mjs';",
        "export default function setup(project) { project.provide('seedValue', computeSeed(200, 3)); }",
      ].join('\n') + '\n',
      'vitest.config.mjs': "export default { test: { globalSetup: ['./global-setup.mjs'] } };\n",
      'src/seed.mjs': 'export const computeSeed = (a, b) => a * b;\n',
      'test/seed.test.ts': [
        "import { expect, inject, it } from 'vitest';",
        "import { computeSeed } from '../src/seed.mjs';",
        "it('reads globalSetup seed and calls computeSeed weakly', () => {",
        "  expect(computeSeed(200, 3)).toBeGreaterThan(0);",
        "  const provided = inject('seedValue');",
        "  expect(provided).toBeGreaterThan(0);",
        "});",
      ].join('\n') + '\n',
    }, async root => {
      const run = spawnSync(process.execPath, [
        cli, 'analyze', root, 'src/seed.mjs', '--suggest-assertions', '--format', 'json',
      ], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      const report = JSON.parse(run.stdout);
      assert.equal(report.evaluation, 'evaluated');
      const suggested = report.diagnostics.map(d => d.suggestedTest).filter(Boolean);
      // Weak `expect(provided).toBeGreaterThan(0)` (or `computeSeed(200, 3)`) is evaluated in fresh runs with re-run globalSetup:
      assert.ok(
        suggested.includes('expect(provided).toBe(600)') || suggested.includes('expect(computeSeed(200, 3)).toBe(600)'),
        JSON.stringify(suggested),
      );
      // Directly confirm warm session declines `globalSetup`:
      const child = spawn(process.execPath, [assertionSessionScript, root, 'vitest.config.mjs'], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      try {
        const boot = await new Promise((resolveMsg, rejectMsg) => {
          const timer = setTimeout(() => rejectMsg(new Error('Timed out waiting for globalSetup boot reply')), 15_000);
          child.once('message', msg => { clearTimeout(timer); resolveMsg(msg); });
        });
        assert.equal(boot.ready, false);
        assert.match(boot.reason, /globalSetup/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          let closeTimer;
          try {
            await Promise.race([
              exited,
              new Promise((_, rejectWait) => {
                closeTimer = setTimeout(() => { child.kill('SIGKILL'); rejectWait(new Error('Timed out closing globalSetup warm session')); }, 10_000);
              }),
            ]);
          } finally {
            clearTimeout(closeTimer);
          }
        }
      }
    });
  });
}

test('PICT vitest-version-compat policy matrix covers all 30 version, mode, config, and module-format rows', async () => {
  const {
    classifyVitestSessionSupport,
    disableProjectFsModuleCache,
    resolveVitestRunnerEntry,
    vitestCacheCliArgs,
    vitestServerCacheOptions,
  } = await import('../src/vitest.mjs');
  // Vitest 4.0.0..4.0.10 predate `experimental.fsModuleCache` and reject unknown CLI options:
  assert.deepEqual(vitestCacheCliArgs('4.0.0', '/tmp/tmt-cache'), ['--no-cache']);
  assert.deepEqual(vitestCacheCliArgs('4.0.10', '/tmp/tmt-cache'), ['--no-cache']);
  assert.deepEqual(vitestServerCacheOptions('4.0.10', '/tmp/tmt-cache'), { cache: false });
  assert.deepEqual(vitestCacheCliArgs('4.0.11', '/tmp/tmt-cache'), [
    '--no-cache',
    '--experimental.fsModuleCache=false',
    '--experimental.fsModuleCachePath=/tmp/tmt-cache',
  ]);
  assert.equal(pictRows.length, 30);
  const probeSource = readFileSync(new URL('../src/probe-runtime.mjs', import.meta.url), 'utf8');
  const versionMap = { v3_2: '3.2.4', v4_0: '4.0.18', v4_1: '4.1.12', v5_1: '5.1.2' };

  const synthRoot = mkdtempSync(join(tmpdir(), 'tmt-pict-runner-'));
  try {
    // Synthetic tree with a hoisted foreign `@vitest/runner` 4.0.18 above both a v4 and v5 package:
    mkdirSync(join(synthRoot, 'node_modules/@vitest/runner'), { recursive: true });
    writeFileSync(join(synthRoot, 'node_modules/@vitest/runner/package.json'), JSON.stringify({ name: '@vitest/runner', version: '4.0.18', main: 'v4-runner.js' }));
    writeFileSync(join(synthRoot, 'node_modules/@vitest/runner/v4-runner.js'), 'export {};\n');

    for (const [verToken, mode, configKind, moduleFormat] of pictRows) {
      const version = versionMap[verToken];
      const major = Number.parseInt(version.split('.')[0], 10);
      const projectConfig = {
        browser: { enabled: configKind === 'BrowserEnabled' },
        typecheck: { enabled: false },
        runner: configKind === 'CustomRunner' ? './custom-runner.mjs' : undefined,
        fsModuleCache: configKind === 'FsModuleCacheTrue' && major >= 5 ? true : undefined,
        experimental: {
          ...(configKind === 'ViteModuleRunnerFalse' ? { viteModuleRunner: false } : {}),
          ...(configKind === 'FsModuleCacheTrue' && major === 4 ? { fsModuleCache: true } : {}),
        },
      };
      const support = classifyVitestSessionSupport(version, [projectConfig], {
        allowGlobalSetup: mode !== 'SuggestAssertionsWarm',
      });
      const cacheArgs = vitestCacheCliArgs(version, '/tmp/tmt-cache');
      const serverCache = vitestServerCacheOptions(version, '/tmp/tmt-cache');

      if (verToken === 'v3_2') {
        assert.equal(support.supported, false);
        assert.match(support.reason, /Vitest 4 or 5/);
        assert.deepEqual(cacheArgs, ['--no-cache']);
        assert.deepEqual(serverCache, { cache: false });
      } else {
        const configBlocksSession = ['BrowserEnabled', 'CustomRunner', 'ViteModuleRunnerFalse'].includes(configKind);
        assert.equal(support.supported, !configBlocksSession, `${verToken}/${mode}/${configKind}/${moduleFormat}`);
        assert.equal(support.supportsIds, verToken !== 'v4_0');

        const mockVitestInstance = { _fsCache: { getMemoryCachePath: () => '/stale' }, cache: { _modules: { getMemoryCachePath: () => '/stale' } } };
        if (major >= 5) {
          assert.deepEqual(cacheArgs, ['--no-cache', '--no-fsModuleCache', '--fsModuleCachePath=/tmp/tmt-cache']);
          assert.deepEqual(serverCache, { cache: false, fsModuleCache: false, fsModuleCachePath: '/tmp/tmt-cache' });
          disableProjectFsModuleCache(version, projectConfig, mockVitestInstance);
          assert.equal(projectConfig.fsModuleCache, false);
        } else {
          assert.deepEqual(cacheArgs, ['--no-cache', '--experimental.fsModuleCache=false', '--experimental.fsModuleCachePath=/tmp/tmt-cache']);
          assert.deepEqual(serverCache, {
            cache: false,
            experimental: { fsModuleCache: false, fsModuleCachePath: '/tmp/tmt-cache' },
          });
          disableProjectFsModuleCache(version, projectConfig, mockVitestInstance);
          assert.equal(projectConfig.experimental.fsModuleCache, false);
        }
        assert.equal(mockVitestInstance._fsCache.getMemoryCachePath(), null);
        assert.equal(mockVitestInstance.cache._modules.getMemoryCachePath(), null);

        // Verify major-version-specific runner entry resolution even when a hoisted v4 `@vitest/runner` coexists:
        const pkgDir = join(synthRoot, 'packages', verToken, 'node_modules/vitest');
        mkdirSync(join(pkgDir, 'dist'), { recursive: true });
        writeFileSync(join(pkgDir, 'dist/browser.js'), 'export {};\n');
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
          name: 'vitest',
          version,
          exports: { './package.json': './package.json', './internal/browser': './dist/browser.js' },
        }));
        const entryHref = resolveVitestRunnerEntry(join(pkgDir, 'package.json'));
        if (major === 4) assert.match(entryHref, /v4-runner\.js$/);
        else assert.match(entryHref, /vitest\/dist\/browser\.js$/);
      }

      if (mode === 'SuggestAssertionsWarm' && verToken !== 'v3_2') {
        const withGlobalSetup = classifyVitestSessionSupport(version, [{ ...projectConfig, globalSetup: ['./gs.mjs'] }], {
          allowGlobalSetup: false,
        });
        assert.equal(withGlobalSetup.supported, false);
      }

      if (moduleFormat === 'CommonJS' && verToken !== 'v3_2') {
        assert.doesNotMatch(probeSource, /\bawait\b/);
      }
    }
  } finally {
    rmSync(synthRoot, { recursive: true, force: true });
  }
});

test('standard-runner resolves legacy Vitest 4 runners as a file:// URL compatible with Windows VitestModuleEvaluator', async () => {
  const { pathToFileURL } = await import('node:url');
  const { moduleRunnerTransform } = await import('vite');
  const runnerUrl = new URL('../src/standard-runner.mjs', import.meta.url);
  const runnerCode = readFileSync(runnerUrl, 'utf8');
  const transformed = await moduleRunnerTransform(runnerCode, undefined, runnerUrl.pathname, runnerCode);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const evaluateRunner = async vitestExports => {
    const exportsObj = {};
    const dynamicSpecifiers = [];
    const ssrImport = async id => {
      if (id === 'vitest') return vitestExports;
      return import(id);
    };
    const ssrDynamicImport = async id => {
      dynamicSpecifiers.push(id);
      // Reproduce VitestModuleEvaluator.convertIdToImportUrl on win32, which turns bare specifiers like
      // `vitest/runners` into `pathToFileURL(id)` unless `id` already has a `file:` (or `node:`/`data:`/`http:`) scheme.
      const winConverted = /^(?:node:|data:|http:|https:|file:)/.test(id) ? id : pathToFileURL(id).href;
      return import(winConverted);
    };
    const fn = new AsyncFunction(
      '__vite_ssr_exports__',
      '__vite_ssr_import_meta__',
      '__vite_ssr_import__',
      '__vite_ssr_dynamic_import__',
      '__vite_ssr_exportAll__',
      '__vite_ssr_exportName__',
      '"use strict";' + transformed.code,
    );
    await fn(
      exportsObj,
      { url: runnerUrl.href },
      ssrImport,
      ssrDynamicImport,
      () => {},
      (name, getter) => Object.defineProperty(exportsObj, name, { enumerable: true, configurable: true, get: getter }),
    );
    return { RunnerClass: exportsObj.default, dynamicSpecifiers };
  };

  // Vitest 4 mode (`vitest.TestRunner` is undefined): must dynamically import a `file://` URL, never bare `vitest/runners`.
  const v4 = await evaluateRunner({ vi: {} });
  assert.equal(typeof v4.RunnerClass, 'function');
  assert.equal(v4.dynamicSpecifiers.length, 1);
  assert.match(v4.dynamicSpecifiers[0], /^file:\/\//);

  // Vitest 5 mode (`vitest.TestRunner` is present): no dynamic fallback import needed at module evaluation.
  class FakeV5TestRunner {}
  const v5 = await evaluateRunner({ vi: {}, TestRunner: FakeV5TestRunner });
  assert.equal(typeof v5.RunnerClass, 'function');
  assert.equal(Object.getPrototypeOf(v5.RunnerClass), FakeV5TestRunner);
  assert.deepEqual(v5.dynamicSpecifiers, []);

  // Windows backslash paths passed to warm-session module invalidation must be slash-normalized for `invalidateFile`:
  const { invalidateVitestSessionModules } = await import('../src/vitest.mjs');
  const invalidatedFiles = [];
  let ssrInvalidated = 0;
  invalidateVitestSessionModules({
    invalidateFile: filepath => invalidatedFiles.push(filepath),
    projects: [{ vite: { environments: { ssr: { moduleGraph: { invalidateAll: () => { ssrInvalidated++; } } } } } }],
  }, ['D:\\work\\project\\test\\example.test.ts', 'D:\\work\\project\\src\\example.ts', null]);
  assert.deepEqual(invalidatedFiles, [
    'D:/work/project/test/example.test.ts',
    'D:/work/project/src/example.ts',
  ]);
  assert.equal(ssrInvalidated, 1);
});

