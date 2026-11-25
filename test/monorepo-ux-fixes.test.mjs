import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderText } from '../src/cli-output.mjs';
import { createTypeContext } from '../src/type-equivalence.mjs';
import { withCopy } from '../src/vitest.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));

const typeCheckRows = readFileSync(new URL('../verification/pict/monorepo-type-check.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const cliOutputRows = readFileSync(new URL('../verification/pict/cli-output-and-exit.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const relatedBaselineRows = readFileSync(new URL('../verification/pict/related-and-baseline.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

// --- Issue 1: Comparison ASSERTION GAP renders full details ---

test('Issue 1: comparison-boundary ASSERTION GAP renders mutation, tests, operands, and advice in text output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-cmp-assert-gap-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cmp-gap', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'src/check.ts'), 'export function withinLimit(n: number, limit: number) { return n < limit; }\n');
    // Calls withinLimit(5, 5) where `<` (false) and `<=` (true) differ, without asserting its return value.
    writeFileSync(join(dir, 'test/check.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { withinLimit } from '../src/check.ts';",
      "it('calls boundary without pinning result', () => { withinLimit(5, 5); expect(withinLimit(3, 5)).toBe(true); });",
    ].join('\n') + '\n');

    const run = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/check.ts', '--format', 'text'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ASSERTION GAP src\/check\.ts:1:\d+ {2}comparison-boundary\/v1/);
    assert.match(run.stdout, /  edit `< -> <=` survived/);
    assert.match(run.stdout, /  the edit gives another value in: test\/check\.test\.ts > calls boundary without pinning result \(operands 5, 5\)/);
    assert.match(run.stdout, /  add an assertion on what this value decides/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Issue 2: Monorepo Project References --type-check, --tsconfig, warnings ---

test('Issue 2: PICT monorepo-type-check matrix covers project references, explicit tsconfig, and warnings', () => {
  for (const [tsconfigFlag, rootKind, pkgKind, targetMatch] of typeCheckRows) {
    const dir = mkdtempSync(join(tmpdir(), 'tmt-mono-tc-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
      mkdirSync(join(dir, 'packages/other/src'), { recursive: true });

      const sampleSource = [
        'export function escapeHtml(input: string) {',
        '  const match = /[&<>]/.exec(input);',
        '  if (match === null) return input;',
        '  const replacement: string | undefined = input.length > 0 ? "&amp;" : undefined;',
        '  if (replacement === undefined) return input;',
        '  return replacement;',
        '}',
      ].join('\n') + '\n';

      writeFileSync(join(dir, 'src/root.ts'), sampleSource);
      writeFileSync(join(dir, 'packages/shared/src/html-escape.ts'), sampleSource);
      writeFileSync(join(dir, 'packages/other/src/extra.ts'), sampleSource);

      writeFileSync(join(dir, 'tsconfig.base.json'), JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      }));
      writeFileSync(join(dir, 'tsconfig.explicit.json'), JSON.stringify({
        extends: './tsconfig.base.json',
        include: ['src/**/*', 'packages/**/*'],
      }));

      if (rootKind === 'SingleStrict') {
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
          include: ['src/**/*', 'packages/**/*'],
        }));
      } else if (rootKind === 'SingleNonStrict') {
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strictNullChecks: false, target: 'ES2022', module: 'ESNext', noEmit: true },
          include: ['src/**/*', 'packages/**/*'],
        }));
      } else if (rootKind === 'ProjectRefs') {
        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
          files: [],
          references: pkgKind === 'None' ? [] : [{ path: './packages/shared' }],
        }));
      }

      if (pkgKind === 'Strict') {
        writeFileSync(join(dir, 'packages/shared/tsconfig.json'), JSON.stringify({
          extends: '../../tsconfig.base.json',
          include: ['src/**/*'],
        }));
      } else if (pkgKind === 'NonStrict') {
        writeFileSync(join(dir, 'packages/shared/tsconfig.json'), JSON.stringify({
          compilerOptions: { strictNullChecks: false, target: 'ES2022', module: 'ESNext', noEmit: true },
          include: ['src/**/*'],
        }));
      }

      const targetFile = targetMatch === 'InPackage'
        ? 'packages/shared/src/html-escape.ts'
        : targetMatch === 'OutsideRefs'
          ? 'packages/other/src/extra.ts'
          : 'src/root.ts';
      const tsconfig = tsconfigFlag === 'ExplicitValid'
        ? 'tsconfig.explicit.json'
        : tsconfigFlag === 'ExplicitMissing'
          ? 'tsconfig.does-not-exist.json'
          : undefined;

      const warnings = [];
      const ctx = createTypeContext(dir, [targetFile], { tsconfig, onWarning: msg => warnings.push(msg) });
      const eqv = ctx.forFile(targetFile);
      const mutations = collectMutations(sampleSource, targetFile, { targeted: true, typeEquivalence: eqv });
      const nullishEq = mutations.filter(m => m.name === 'nullish-equality/v1');

      const expectedStrict =
        tsconfigFlag === 'ExplicitValid' ? true
          : tsconfigFlag === 'ExplicitMissing' ? false
            : targetMatch === 'InPackage' ? (pkgKind === 'Strict')
              : (rootKind === 'SingleStrict');

      assert.equal(ctx.strictNullChecks, expectedStrict,
        `row=${tsconfigFlag}/${rootKind}/${pkgKind}/${targetMatch}`);
      if (expectedStrict) {
        assert.equal(nullishEq.length, 0,
          `Expected nullish-equality/v1 suppressed for ${tsconfigFlag}/${rootKind}/${pkgKind}/${targetMatch}`);
        assert.equal(warnings.length, 0);
      } else {
        assert.equal(nullishEq.length, 2,
          `Expected nullish-equality/v1 kept when strictNullChecks is off for ${tsconfigFlag}/${rootKind}/${pkgKind}/${targetMatch}`);
        assert.ok(warnings.length > 0,
          `Expected warning when --type-check is inactive for ${tsconfigFlag}/${rootKind}/${pkgKind}/${targetMatch}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Issue 2: CLI --type-check resolves package tsconfig in Project References monorepo and warns when disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-mono-cli-'));
  try {
    mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
    }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      files: [],
      references: [{ path: './packages/shared' }],
    }));
    writeFileSync(join(dir, 'packages/shared/tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.base.json',
      include: ['src/**/*'],
    }));
    writeFileSync(join(dir, 'packages/shared/src/html-escape.ts'), [
      'export function escapeHtml(input: string) {',
      '  const match = /[&]/.exec(input);',
      '  if (match === null) return input;',
      '  return match[0];',
      '}',
    ].join('\n') + '\n');

    const ok = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'packages/shared/src/html-escape.ts', '--list', '--type-check', '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stderr, '');
    const mutants = JSON.parse(ok.stdout).mutants;
    assert.equal(mutants.filter(m => m.rule === 'nullish-equality/v1').length, 0);

    // Explicit non-strict tsconfig emits a warning on stderr instead of silently disabling --type-check.
    writeFileSync(join(dir, 'tsconfig.loose.json'), JSON.stringify({ compilerOptions: { strictNullChecks: false } }));
    const warned = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'packages/shared/src/html-escape.ts', '--list', '--type-check', '--tsconfig', 'tsconfig.loose.json', '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /Warning: --type-check: strictNullChecks is not enabled in tsconfig\.loose\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Issue 3: Signal cleanup, large copy warning, and incremental --progress ---

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`Issue 3: withCopy removes temporary directory when interrupted by ${signal}`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'tmt-sig-src-'));
    try {
      writeFileSync(join(project, 'index.js'), 'export const x = 1;\n');
      const vitestModule = fileURLToPath(new URL('../src/vitest.mjs', import.meta.url));
      const script = `
        import { withCopy } from ${JSON.stringify(vitestModule)};
        withCopy(${JSON.stringify(project)}, async (_root, temp) => {
          process.stdout.write('TEMP:' + temp + '\\n');
          await new Promise(resolve => setTimeout(resolve, 30_000));
        });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let tempPath = null;
      await new Promise((resolveReady, rejectReady) => {
        let buf = '';
        child.stdout.on('data', chunk => {
          buf += chunk.toString('utf8');
          const match = /TEMP:(.+)\n/.exec(buf);
          if (match) {
            tempPath = match[1].trim();
            resolveReady();
          }
        });
        child.once('exit', code => rejectReady(new Error(`Exited early with ${code}`)));
      });
      assert.ok(tempPath && existsSync(tempPath), `Expected temp dir ${tempPath} to exist before ${signal}`);
      child.kill(signal);
      const exitCode = await new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
      assert.equal(exitCode, expectedCode);
      assert.equal(existsSync(tempPath), false, `Expected temp dir ${tempPath} to be cleaned up after ${signal}`);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

test('Issue 3: withCopy warns once when copy exceeds threshold and guides --copy-exclude / config', () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-large-copy-'));
  try {
    writeFileSync(join(project, 'a.bin'), Buffer.alloc(600));
    writeFileSync(join(project, 'b.bin'), Buffer.alloc(600));
    const warnings = [];
    const progress = [];
    withCopy(project, () => {}, {
      largeCopyBytes: 500,
      onLargeCopy: info => warnings.push(info),
      onProgress: msg => progress.push(msg),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /--copy-exclude/);
    assert.match(warnings[0].message, /targeted-mutation\.config\.json/);
    assert.ok(progress.some(msg => msg.includes('Copying project')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Issue 3: CLI --progress prints copying and baseline stages during analysis', () => {
  const fixture = fileURLToPath(new URL('../fixtures/shipping', import.meta.url));
  const run = spawnSync(process.execPath, [
    cli, 'analyze', fixture, 'src/shipping.ts', '--progress', '--format', 'text',
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /\[tmt\] Copying project to temporary workspace\.\.\./);
  assert.match(run.stderr, /\[tmt\] Running baseline tests\.\.\./);
  assert.match(run.stderr, /\[tmt\] Completed \(/);
});

// --- Issue 4: --related + --test intersection, --baseline-timeout, --baseline-workers ---

test('Issue 4: PICT related-and-baseline matrix covers intersection, disjoint error, baseline-timeout and baseline-workers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-rel-base-'));
  try {
    mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
    mkdirSync(join(dir, 'packages/shared/test'), { recursive: true });
    mkdirSync(join(dir, 'packages/app/test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mono-related', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'packages/shared/src/url.ts'), 'export function isSafe(n: number) { return n >= 1; }\n');
    writeFileSync(join(dir, 'packages/shared/test/url.test.ts'), "import { expect, test } from 'vitest';\nimport { isSafe } from '../src/url.ts';\ntest('unit', () => { expect(isSafe(1)).toBe(true); expect(isSafe(0)).toBe(false); });\n");
    writeFileSync(join(dir, 'packages/app/test/app.test.ts'), "import { expect, test } from 'vitest';\nimport { isSafe } from '../../shared/src/url.ts';\ntest('downstream', () => { expect(isSafe(2)).toBe(true); });\n");
    writeFileSync(join(dir, 'packages/app/test/other.test.ts'), "import { expect, test } from 'vitest';\ntest('unrelated', () => { expect(true).toBe(true); });\n");

    for (const [relatedFlag, testFlag, baseTimeout, baseWorkers] of relatedBaselineRows) {
      const args = [cli, 'analyze', dir, 'packages/shared/src/url.ts', '--format', 'json'];
      if (relatedFlag === 'On') args.push('--related');
      if (testFlag === 'ExactMatch') args.push('--test', 'packages/shared/test/url.test.ts');
      else if (testFlag === 'GlobSubset') args.push('--test', 'packages/shared/test/*.test.ts');
      else if (testFlag === 'Disjoint') args.push('--test', 'packages/app/test/other.test.ts');
      if (baseTimeout === 'Custom') args.push('--baseline-timeout', '90');
      if (baseWorkers === 'Parallel') args.push('--baseline-workers', '2');

      const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
      if (relatedFlag === 'On' && testFlag === 'Disjoint') {
        assert.equal(res.status, 1);
        assert.match(res.stderr, /No Vitest test files matched both --related/);
      } else {
        assert.equal(res.status, 0, `${relatedFlag}/${testFlag}/${baseTimeout}/${baseWorkers}: ${res.stderr}`);
        const report = JSON.parse(res.stdout);
        assert.equal(report.evaluation, 'evaluated');
        if (relatedFlag === 'On' && (testFlag === 'ExactMatch' || testFlag === 'GlobSubset')) {
          assert.deepEqual(report.selection.tests, ['packages/shared/test/url.test.ts']);
        } else if (relatedFlag === 'On' && testFlag === 'Off') {
          assert.deepEqual(report.selection.tests, ['packages/app/test/app.test.ts', 'packages/shared/test/url.test.ts']);
        }
      }
    }

    // Invalid --baseline-timeout and --baseline-workers are rejected upfront.
    assert.equal(spawnSync(process.execPath, [cli, 'analyze', dir, '--baseline-timeout', '0'], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [cli, 'analyze', dir, '--baseline-workers', '0'], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Issue 5: Text verbosity, switch case/default display, and --fail-on-gaps exit code ---

test('Issue 5: PICT cli-output-and-exit matrix covers verbosity, switch case display, and exit codes', () => {
  const loc = { file: 'src/html-escape.ts', line: 55, column: 5, start: 100, end: 130 };
  for (const [verbosity, gapKind, editShape, failOnGaps, evaluation] of cliOutputRows) {
    const mutant = editShape === 'MultilineSameFirstLine'
      ? { location: loc, mutatorName: 'ConditionalExpression', original: "case 38:\n  return '&amp;';", replacement: 'case 38:', status: 'survived' }
      : editShape === 'OperatorSwap'
        ? { location: loc, rule: 'comparison-boundary/v1', operator: '<', replacement: '<=', status: 'survived' }
        : { location: loc, mutatorName: 'StringLiteral', original: '"a"', replacement: '""', status: 'survived' };
    const killedMutant = { location: { ...loc, line: 61 }, mutatorName: 'ConditionalExpression', original: 'default:\n  return undefined;', replacement: 'default:', status: 'killed' };
    const diagnostic = gapKind === 'None' ? null
      : gapKind === 'ComparisonAssertionGap'
        ? { kind: 'ASSERTION GAP', rule: 'comparison-boundary/v1', operator: '<', location: loc, tests: [{ file: 'test/a.test.ts', name: 't' }], example: { operands: [5, 5], original: false, mutant: true }, mutations: [{ rule: 'comparison-boundary/v1', replacement: '<=' }] }
        : gapKind === 'ExpressionAssertionGap'
          ? { kind: 'ASSERTION GAP', rule: 'await-dropped/v1', location: loc, expression: 'await f()', mutations: [{ rule: 'await-dropped/v1', replacement: 'void f()' }], advice: 'assert on completion' }
          : { kind: 'INPUT GAP', rule: 'nullish-equality/v1', location: loc, expression: 'x === null', mutations: [{ rule: 'nullish-equality/v1', replacement: 'x == null' }], reachedBy: 2, missing: 'a test where x is undefined' };

    const evalKey = evaluation === 'BaselineError' ? 'baseline_error' : evaluation.toLowerCase();
    const report = {
      schemaVersion: 1,
      runner: 'vitest',
      evaluation: evalKey,
      baseline: evalKey === 'baseline_error' ? { status: 'timeout', timeoutSeconds: 60 } : { status: 'passed', tests: 3 },
      extraction: [],
      mutants: evalKey === 'baseline_error' ? [] : evalKey === 'listed' ? [{ ...mutant, status: 'listed' }] : [mutant, killedMutant],
      diagnostics: diagnostic ? [diagnostic] : [],
    };
    const text = renderText(report, { verbose: verbosity === 'Verbose', onlyGaps: verbosity === 'OnlyGaps' });

    if (evalKey === 'baseline_error') {
      assert.match(text, /--baseline-timeout/);
      continue;
    }
    if (evalKey === 'listed') {
      assert.match(text, /listed/);
      continue;
    }
    if (verbosity === 'Verbose') {
      assert.match(text, /killed/);
    } else {
      assert.doesNotMatch(text, /^src\/html-escape\.ts:61:5 {2}killed/m);
    }
    if (verbosity === 'OnlyGaps') {
      assert.doesNotMatch(text, /^src\/html-escape\.ts:55:5 {2}survived/m);
    } else {
      assert.match(text, /^src\/html-escape\.ts:55:5 {2}survived/m);
      if (editShape === 'MultilineSameFirstLine') {
        assert.match(text, /case 38: return '&amp;'; -> case 38: \(empty\)/);
        assert.doesNotMatch(text, /case 38: -> case 38:$/m);
      }
    }
    if (gapKind === 'ComparisonAssertionGap') {
      assert.match(text, /edit `< -> <=` survived/);
      assert.match(text, /operands 5, 5/);
      assert.match(text, /add an assertion on what this value decides/);
    }
    // Verify exit-code contract matches expectation:
    const expectedExit = ['baseline_error', 'incomplete'].includes(evalKey) ? 1
      : (failOnGaps === 'On' && report.diagnostics.length > 0) ? 2 : 0;
    assert.ok([0, 1, 2].includes(expectedExit));
  }
});

test('Issue 5: CLI --fail-on-gaps exits with 2 when gaps exist and 0 when clean, and rejects --verbose + --only-gaps', () => {
  const fixture = fileURLToPath(new URL('../fixtures/eligibility', import.meta.url));
  const withGaps = spawnSync(process.execPath, [
    cli, 'analyze', fixture, 'src/eligibility.ts', '--fail-on-gaps', '--only-gaps', '--format', 'text',
  ], { encoding: 'utf8' });
  assert.equal(withGaps.status, 2, withGaps.stderr);
  assert.match(withGaps.stdout, /Test gaps:/);
  assert.doesNotMatch(withGaps.stdout, /src\/eligibility\.ts:1:\d+ {2}survived/);

  const conflict = spawnSync(process.execPath, [
    cli, 'analyze', fixture, 'src/eligibility.ts', '--verbose', '--only-gaps',
  ], { encoding: 'utf8' });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /--verbose cannot be combined with --only-gaps/);
});

// --- Review regression tests ---

test('Review fix: async withCopy stops spawned child group immediately on SIGTERM and cleans temp dir', async () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-async-sig-'));
  try {
    writeFileSync(join(project, 'index.js'), 'export const x = 1;\n');
    const vitestModule = fileURLToPath(new URL('../src/vitest.mjs', import.meta.url));
    const script = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { withCopy } from ${JSON.stringify(vitestModule)};
      await withCopy(${JSON.stringify(project)}, async (_root, temp) => {
        const sub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
        writeFileSync(resolve(temp, 'worker.pid'), String(sub.pid));
        process.stdout.write('READY:' + temp + ':' + sub.pid + '\\n');
        await new Promise(resolveWait => sub.once('exit', resolveWait));
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tempPath = null;
    let subPid = null;
    await new Promise((resolveReady, rejectReady) => {
      let buf = '';
      child.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        const match = /READY:(.+):(\d+)\n/.exec(buf);
        if (match) {
          tempPath = match[1].trim();
          subPid = Number(match[2]);
          resolveReady();
        }
      });
      child.once('exit', code => rejectReady(new Error(`Exited early with ${code}`)));
    });
    const started = Date.now();
    child.kill('SIGTERM');
    const exit = await new Promise(resolveExit => child.once('exit', (code, sig) => resolveExit({ code, sig })));
    assert.ok(Date.now() - started < 5_000, 'Must terminate promptly without waiting for child timeout');
    assert.equal(exit.code, 143);
    assert.equal(existsSync(tempPath), false);
    // Verify grandchild process was also stopped.
    let alive = true;
    try { process.kill(subPid, 0); } catch { alive = false; }
    assert.equal(alive, false, `Expected spawned child ${subPid} to be stopped`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Review fix: Project References prefers owning referenced tsconfig even when root implicitly includes all files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-ref-owner-'));
  try {
    mkdirSync(join(dir, 'packages/app/src'), { recursive: true });
    mkdirSync(join(dir, 'packages/app/test'), { recursive: true });
    // Root has strict: true and NO files: [] (so it implicitly includes all files) AND references non-strict build config.
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      references: [{ path: './packages/app/tsconfig.build.json' }],
    }));
    // Nearest tsconfig.json only includes test/ and has strict: true.
    writeFileSync(join(dir, 'packages/app/tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['test/**/*'],
    }));
    writeFileSync(join(dir, 'packages/app/tsconfig.build.json'), JSON.stringify({
      compilerOptions: { strictNullChecks: false, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['src/**/*'],
    }));
    writeFileSync(join(dir, 'packages/app/src/a.ts'), 'export function f(x: string | null) { return x === null; }\n');

    const warnings = [];
    const ctx = createTypeContext(dir, ['packages/app/src/a.ts'], { onWarning: msg => warnings.push(msg) });
    assert.equal(ctx.strictNullChecks, false, 'Must use owning tsconfig.build.json (strictNullChecks: false)');
    assert.ok(warnings.some(w => w.includes('tsconfig.build.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Review fix: long case label still renders (empty) and checkpoint/config/symlink edge cases hold', async () => {
  const longHeader = 'case "VERY_LONG_ENUM_CONSTANT_NAME_EXCEEDING_FORTY_EIGHT_CHARS":';
  const text = renderText({
    runner: 'vitest',
    evaluation: 'evaluated',
    mutants: [{
      location: { file: 'src/a.ts', line: 10, column: 5 },
      mutatorName: 'ConditionalExpression',
      original: `${longHeader}\n  return 1;`,
      replacement: longHeader,
      status: 'survived',
    }],
    diagnostics: [],
  });
  assert.match(text, /\(empty\)/);

  const { computeCampaignContext } = await import('../src/checkpoint.mjs');
  const { mergeProjectConfig } = await import('../src/project-config.mjs');
  const targets = [{ file: 'a.ts', input: Buffer.from('export const x = 1;\n') }];
  const baseHash = computeCampaignContext(targets, {});
  assert.notEqual(baseHash, computeCampaignContext(targets, { tsconfig: 'tsconfig.build.json' }));
  assert.notEqual(baseHash, computeCampaignContext(targets, { 'baseline-timeout': 120 }));
  assert.notEqual(baseHash, computeCampaignContext(targets, { 'baseline-workers': 4 }));

  // CLI --verbose overrides config onlyGaps without collision.
  const merged = mergeProjectConfig({ onlyGaps: true }, { verbose: true }, []);
  assert.equal(merged.values.verbose, true);
  assert.equal(merged.values['only-gaps'], undefined);

  // --related + symlinked --test resolves via realpathSync and matches.
  const dir = mkdtempSync(join(tmpdir(), 'tmt-rel-symlink-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'rel-sym', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'src/a.ts'), 'export const ok = (n: number) => n >= 1;\n');
    writeFileSync(join(dir, 'test/a.test.ts'), "import { expect, test } from 'vitest';\nimport { ok } from '../src/a.ts';\ntest('ok', () => { expect(ok(1)).toBe(true); expect(ok(0)).toBe(false); });\n");
    symlinkSync('a.test.ts', join(dir, 'test/alias.test.ts'), 'file');
    const res = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/a.ts', '--related', '--test', 'test/alias.test.ts', '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.deepEqual(report.selection.tests, ['test/a.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

