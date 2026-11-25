import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const assertionSessionScript = fileURLToPath(new URL('../src/assertion-session.mjs', import.meta.url));
const pictRows = readFileSync(new URL('../verification/pict/vitest-version-compat.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const repoNodeModules = fileURLToPath(new URL('../../../node_modules', import.meta.url));
const vitest5Modules = process.env.TMT_VITEST5_NODE_MODULES ? resolve(process.env.TMT_VITEST5_NODE_MODULES) : null;

function activeModulesList() {
  const list = [{ label: 'installed-vitest', modulesDir: existsSync(repoNodeModules) ? repoNodeModules : resolve('node_modules') }];
  if (vitest5Modules && existsSync(vitest5Modules)) {
    list.push({ label: 'vitest-5', modulesDir: vitest5Modules });
  }
  return list;
}

function vitestVersionOf(modulesDir) {
  const req = createRequire(join(modulesDir, '_noop.js'));
  return req('./vitest/package.json').version;
}

function withVitestProject(modulesDir, files, action) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-compat-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  let pending = false;
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    // Link packages individually so we can verify Vitest never creates `node_modules/.vitest-cache` inside `root` or `modulesDir`.
    for (const name of ['vitest', 'vite', '@vitest']) {
      if (existsSync(join(modulesDir, name))) {
        symlinkSync(join(modulesDir, name), join(root, 'node_modules', name), 'dir');
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
    const cacheBeforeInShared = existsSync(join(modulesDir, '.vitest-cache'));
    withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-probe', type: 'module' }),
      'vitest.config.mjs': version.startsWith('5.')
        ? 'export default { test: { fsModuleCache: true } };\n'
        : 'export default {};\n',
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
      // Threshold synthesis requires recorded safe-integer operands on `age >= 18`:
      const thresholdMutant = report.mutants.find(m => m.location.file === 'src/age.ts' && m.rule === 'comparison-threshold/v1');
      assert.ok(thresholdMutant, 'expected synthesized comparison-threshold/v1 mutant');
      assert.equal(thresholdMutant.status, 'survived');
      assert.equal(thresholdMutant.evidence, 'predicted');
      assert.equal(thresholdMutant.audit.status, 'agreed');
      // CommonJS probe observation: `legacy(10)` hits boundary `10 >= 10`, leaving lower side `9` open:
      const cjsBoundary = report.mutants.find(m => m.location.file === 'src/legacy.cjs' && m.rule === 'comparison-boundary/v1');
      assert.equal(cjsBoundary.status, 'killed');
      assert.equal(cjsBoundary.audit.status, 'agreed');
      const cjsThreshold = report.mutants.find(m => m.location.file === 'src/legacy.cjs' && m.rule === 'comparison-threshold/v1');
      assert.ok(cjsThreshold, 'expected CommonJS threshold mutant');
      assert.equal(cjsThreshold.status, 'survived');
      // Verify `node_modules/.vitest-cache` was never created in the project or shared modulesDir:
      assert.equal(existsSync(join(root, 'node_modules', '.vitest-cache')), false);
      if (!cacheBeforeInShared) {
        assert.equal(existsSync(join(modulesDir, '.vitest-cache')), false);
      }
    });
  });

  test(`[${label} v${version}] runs in-worker switched session matching isolated trials with worker hazards and fsModuleCache isolation`, () => {
    const cacheBeforeInShared = existsSync(join(modulesDir, '.vitest-cache'));
    withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-session', type: 'module' }),
      'vitest.config.mjs': version.startsWith('5.')
        ? 'export default { test: { testTimeout: 250, hookTimeout: 250, fsModuleCache: true } };\n'
        : 'export default { test: { testTimeout: 250, hookTimeout: 250 } };\n',
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
      // Value-aware INPUT GAP, ASSERTION GAP, and variable-RHS margin synthesis all work in session mode:
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'ASSERTION GAP' && d.rule === 'arithmetic-swap/v1'));
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'INPUT GAP' && d.rule === 'nullish-fallback/v1'));
      assert.ok(sharedReport.diagnostics.some(d => d.kind === 'INPUT GAP' && d.rule === 'comparison-margin/v1'));
      const reasons = new Set(sharedReport.mutants.map(m => m.fallback).filter(Boolean));
      for (const reason of ['control-differs', 'unhandled-error', 'tests-changed']) {
        assert.ok(reasons.has(reason), `missing fallback ${reason} in ${[...reasons].join(',')}`);
      }
      assert.equal(existsSync(join(root, 'node_modules', '.vitest-cache')), false);
      if (!cacheBeforeInShared) {
        assert.equal(existsSync(join(modulesDir, '.vitest-cache')), false);
      }
    });
  });

  if (version.startsWith('5.')) {
    test(`[${label} v${version}] falls back safely to source-rewrite when experimental.viteModuleRunner is false and classifies aroundEach timeouts`, () => {
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

      withVitestProject(modulesDir, {
        'package.json': JSON.stringify({ name: 'compat-around-timeout', type: 'module' }),
        'vitest.config.mjs': 'export default { test: { hookTimeout: 150 } };\n',
        'src/gate.ts': 'export function shouldProceed(ok: boolean) { if (ok) return true; return false; }\n',
        'test/gate.test.ts': [
          "import { aroundEach, expect, it } from 'vitest';",
          "import { shouldProceed } from '../src/gate';",
          "aroundEach(async runTest => {",
          "  if (!shouldProceed(true)) await new Promise(() => {});",
          "  await runTest();",
          "});",
          "it('runs under aroundEach', () => expect(shouldProceed(true)).toBe(true));",
        ].join('\n') + '\n',
      }, root => {
        const run = spawnSync(process.execPath, [
          cli, 'analyze', root, 'src/gate.ts', '--mutators', 'full', '--format', 'json',
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        const report = JSON.parse(run.stdout);
        assert.equal(report.evaluation, 'evaluated');
        assert.equal(report.operatorExecution, 'session');
        const falseMutant = report.mutants.find(m => m.original === 'ok' && m.replacement === 'false');
        assert.equal(falseMutant?.status, 'timeout');
      });
    });
  }

  test(`[${label} v${version}] runs warm assertion-session IPC and --related --suggest-assertions without cache pollution`, async () => {
    const cacheBeforeInShared = existsSync(join(modulesDir, '.vitest-cache'));
    await withVitestProject(modulesDir, {
      'package.json': JSON.stringify({ name: 'compat-warm-related', type: 'module' }),
      'vitest.config.mjs': version.startsWith('5.')
        ? 'export default { test: { fsModuleCache: true } };\n'
        : 'export default {};\n',
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
      // 1. Verify the warm assertion-session child process actually boots (`ready: true`) on both Vitest 4 and 5,
      //    and invalidates edited + restored modules across back-to-back runs in the same warm worker:
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
      const nextMessage = () => new Promise((resolveMsg, rejectMsg) => {
        if (messages.length) return resolveMsg(messages.shift());
        const onMsg = msg => { cleanup(); resolveMsg(msg); };
        const onExit = code => { cleanup(); rejectMsg(new Error(`warm session exited early (${code})`)); };
        const cleanup = () => { child.off('message', onMsg); child.off('exit', onExit); };
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

        // Re-running without `trial` must observe the restored `600`, never a cached `203`:
        child.send({ id: 3, testFile: 'test/fees.test.ts', rewriteContent: rewriteTest, collect: '.collect.jsonl' });
        const restoredReply = await nextMessage();
        messages.length = 0;
        assert.equal(restoredReply.collected.trim(), '600');
      } finally {
        if (child.connected) child.send({ close: true });
        if (child.exitCode === null && child.signalCode === null) await exited;
        rmSync(join(root, '.tmp-vite'), { recursive: true, force: true });
        rmSync(join(root, '.tmp-fs-cache'), { recursive: true, force: true });
      }

      // 2. Verify end-to-end CLI `--related --suggest-assertions` bypasses `unrelated.test.ts`,
      //    produces concrete assertions for both Pass 1 and Pass 2, and leaves no `.vitest-cache`:
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
      assert.equal(existsSync(join(root, 'node_modules', '.vitest-cache')), false);
      if (!cacheBeforeInShared) {
        assert.equal(existsSync(join(modulesDir, '.vitest-cache')), false);
      }
    });
  });
}

test('PICT vitest-version-compat matrix covers all 30 version, mode, config, and module-format combinations', async () => {
  const { classifyVitestSessionSupport, vitestCacheCliArgs } = await import('../src/vitest.mjs');
  assert.equal(pictRows.length, 30);
  const versionMap = { v3_2: '3.2.4', v4_0: '4.0.18', v4_1: '4.1.12', v5_1: '5.1.2' };
  for (const [verToken, mode, configKind, moduleFormat] of pictRows) {
    const version = versionMap[verToken];
    const projectConfig = {
      browser: { enabled: configKind === 'BrowserEnabled' },
      typecheck: { enabled: false },
      runner: configKind === 'CustomRunner' ? './custom-runner.mjs' : undefined,
      fsModuleCache: configKind === 'FsModuleCacheTrue' ? true : undefined,
      experimental: configKind === 'ViteModuleRunnerFalse' ? { viteModuleRunner: false } : {},
    };
    const support = classifyVitestSessionSupport(version, [projectConfig]);
    const major = Number.parseInt(version.split('.')[0], 10);
    const cacheArgs = vitestCacheCliArgs(major);

    if (verToken === 'v3_2') {
      assert.equal(support.supported, false);
      assert.match(support.reason, /Vitest 4 or 5/);
      assert.deepEqual(cacheArgs, ['--no-cache']);
    } else {
      const configBlocksSession = ['BrowserEnabled', 'CustomRunner', 'ViteModuleRunnerFalse'].includes(configKind);
      assert.equal(support.supported, !configBlocksSession, `${verToken}/${mode}/${configKind}/${moduleFormat}`);
      assert.equal(support.supportsIds, verToken !== 'v4_0');
      if (verToken === 'v5_1') {
        assert.deepEqual(cacheArgs, ['--no-cache', '--no-fsModuleCache']);
      } else {
        assert.deepEqual(cacheArgs, ['--no-cache']);
      }
    }
    // CommonJS requires synchronous probe resolution without top-level await in all supported versions:
    if (moduleFormat === 'CommonJS' && verToken !== 'v3_2') {
      const probeSource = readFileSync(new URL('../src/probe-runtime.mjs', import.meta.url), 'utf8');
      assert.doesNotMatch(probeSource, /\bawait\b/);
    }
  }
});
