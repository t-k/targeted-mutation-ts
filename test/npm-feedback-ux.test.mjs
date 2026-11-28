import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyBaseline,
  findingId,
  loadBaselineWithReasons,
  parseBaselineWithReasons,
  writeBaseline,
} from '../src/baseline.mjs';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderText } from '../src/cli-output.mjs';
import { analyzeConventional } from '../src/conventional.mjs';
import {
  detectGitignoreBaselineHints,
  gitignoredCopyExclusions,
  mergeProjectConfig,
  resolveAnalyzePositionals,
  validateAndExpandInputs,
} from '../src/project-config.mjs';
import { filterExcludedFiles, selectScope } from '../src/scope.mjs';
import { openReasons, planInThread } from '../src/standard-plan.mjs';
import { resolveCopyInclusions, withCopy } from '../src/vitest.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));

test('Item 1: copyInclude re-includes gitignored or nested excluded paths and rejects unsafe targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-copy-include-'));
  try {
    mkdirSync(join(dir, 'src/generated/i18n'), { recursive: true });
    mkdirSync(join(dir, 'src/generated/cache'), { recursive: true });
    mkdirSync(join(dir, 'src/paraglide'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'copy-inc-proj', type: 'module' }));
    writeFileSync(join(dir, 'src/generated/i18n/messages.ts'), 'export const hello = "hi";\n');
    writeFileSync(join(dir, 'src/generated/cache/blob.bin'), 'cache-data');
    writeFileSync(join(dir, 'src/paraglide/messages.ts'), 'export const ok = () => "ok";\n');
    writeFileSync(join(dir, 'dist/bundle.js'), 'console.log(1);\n');

    // Nested copyInclude under an excluded parent directory keeps only the included subtree.
    withCopy(dir, copyRoot => {
      assert.equal(existsSync(resolve(copyRoot, 'src/generated/i18n/messages.ts')), true);
      assert.equal(existsSync(resolve(copyRoot, 'src/generated/cache/blob.bin')), false);
      assert.equal(existsSync(resolve(copyRoot, 'src/paraglide/messages.ts')), true);
      assert.equal(existsSync(resolve(copyRoot, 'dist/bundle.js')), false);
    }, {
      exclude: ['src/generated', 'src/paraglide', 'dist'],
      include: ['src/generated/i18n', 'src/paraglide'],
    });

    // Missing copyInclude path warns via onMissing and skips; unsafe paths throw.
    const missing = [];
    const active = resolveCopyInclusions(dir, ['src/paraglide', 'src/does-not-exist'], {
      onMissing: p => missing.push(p),
    });
    assert.equal(active.length, 1);
    assert.deepEqual(missing, ['src/does-not-exist']);

    assert.throws(() => resolveCopyInclusions(dir, ['../outside']), /must be inside the project/);
    assert.throws(() => resolveCopyInclusions(dir, ['node_modules']), /cannot target node_modules/);
    assert.throws(() => resolveCopyInclusions(dir, ['.git']), /cannot target reserved directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 1: baseline_error emits actionable copyInclude hint when gitignore excludes an imported module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-gitignore-hint-'));
  try {
    mkdirSync(join(dir, 'src/paraglide'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hint-proj', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'junction');
    writeFileSync(join(dir, '.gitignore'), 'src/paraglide/\n');
    writeFileSync(join(dir, 'src/paraglide/messages.ts'), 'export const greet = () => "hello";\n');
    writeFileSync(join(dir, 'src/app.ts'), [
      "import { greet } from './paraglide/messages.ts';",
      'export const isLong = (n: number) => greet().length >= n;',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'test/app.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { isLong } from '../src/app.ts';",
      "it('checks length', () => { expect(isLong(5)).toBe(true); expect(isLong(6)).toBe(false); });",
    ].join('\n') + '\n');
    execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });

    // Unit check for aliased import specifier (`@/paraglide/messages`).
    const aliasHints = detectGitignoreBaselineHints({
      status: 'error',
      fileErrors: [{ file: 'test/app.test.ts', message: 'Failed to resolve import "@/paraglide/messages" from "src/app.ts"' }],
    }, ['src/paraglide']);
    assert.equal(aliasHints.length, 1);
    assert.match(aliasHints[0], /src\/paraglide/);
    assert.match(aliasHints[0], /--copy-include src\/paraglide/);
    const renderedHint = renderText({
      evaluation: 'baseline_error',
      baseline: { status: 'error', errors: ['Failed to resolve import "@/paraglide/messages"'], hints: aliasHints },
    });
    assert.match(renderedHint, /Hint: "src\/paraglide" was excluded by --copy-exclude-gitignore/);

    // End-to-end CLI: --copy-exclude-gitignore without --copy-include fails baseline with hint.
    const failed = spawnSync(process.execPath, [
      cli, 'analyze', 'src/app.ts', '--copy-exclude-gitignore', '--format', 'json',
    ], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(failed.status, 1);
    const failedReport = JSON.parse(failed.stdout);
    assert.equal(failedReport.evaluation, 'baseline_error');
    assert.ok(failedReport.baseline.hints?.length >= 1, JSON.stringify(failedReport.baseline));
    assert.match(failedReport.baseline.hints[0], /src\/paraglide/);

    // End-to-end CLI: adding --copy-include src/paraglide makes baseline pass and evaluation succeed.
    const fixed = spawnSync(process.execPath, [
      cli, 'analyze', 'src/app.ts', '--copy-exclude-gitignore', '--copy-include', 'src/paraglide', '--format', 'json',
    ], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(fixed.status, 0, fixed.stderr);
    const fixedReport = JSON.parse(fixed.stdout);
    assert.equal(fixedReport.evaluation, 'evaluated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 2: --exclude, config exclude, and !pattern in files exclude files from mutation while keeping them in copies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-exclude-'));
  try {
    mkdirSync(join(dir, 'src/features/alpha'), { recursive: true });
    mkdirSync(join(dir, 'src/features/beta'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'exclude-proj', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'junction');
    writeFileSync(join(dir, 'src/features/alpha/sample.ts'), 'export const SAMPLE_TIME = "06-03 14:02";\n');
    writeFileSync(join(dir, 'src/features/beta/sample.ts'), 'export const SAMPLE_TAG = "beta";\n');
    writeFileSync(join(dir, 'src/routeTree.gen.ts'), 'export const ROUTE_COUNT = 3;\n');
    writeFileSync(join(dir, 'src/core.ts'), 'export const ready = (n: number) => n >= 1;\n');
    writeFileSync(join(dir, 'test/core.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { SAMPLE_TIME } from '../src/features/alpha/sample.ts';",
      "import { ROUTE_COUNT } from '../src/routeTree.gen.ts';",
      "import { ready } from '../src/core.ts';",
      "it('uses sample and routeTree while testing core', () => {",
      '  expect(SAMPLE_TIME.length).toBeGreaterThan(0);',
      '  expect(ROUTE_COUNT).toBe(3);',
      '  expect(ready(1)).toBe(true);',
      '  expect(ready(0)).toBe(false);',
      '});',
    ].join('\n') + '\n');

    // Unit check: validateAndExpandInputs supports both `exclude` option and `!pattern` in files.
    const expanded = validateAndExpandInputs(
      dir,
      ['src', '!src/routeTree.gen.ts'],
      { exclude: ['src/features/*/sample.ts'] },
    );
    assert.deepEqual(expanded.files, ['src/core.ts']);
    assert.deepEqual(expanded.exclude.sort(), ['src/features/*/sample.ts', 'src/routeTree.gen.ts']);

    // Scope filtering honors exclude even when files is omitted (auto-discovered).
    const scoped = selectScope(dir, [], { exclude: ['src/features/*/sample.ts', 'src/routeTree.gen.ts'] });
    assert.deepEqual(scoped.map(s => s.file), ['src/core.ts']);

    // Outside-project exclude patterns are rejected.
    assert.throws(() => filterExcludedFiles(dir, ['src/core.ts'], ['../secret.ts']), /must be inside the project/);
    assert.throws(() => filterExcludedFiles(dir, ['src/core.ts'], ['/etc/passwd']), /must be inside the project/);

    // End-to-end Vitest run: sample.ts and routeTree.gen.ts remain importable by tests, but only src/core.ts is mutated.
    writeFileSync(join(dir, 'targeted-mutation.config.json'), JSON.stringify({
      files: ['src'],
      exclude: ['src/features/*/sample.ts', 'src/routeTree.gen.ts'],
      mutators: 'full',
    }));
    const run = spawnSync(process.execPath, [cli, 'analyze', '--format', 'json'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.evaluation, 'evaluated');
    const mutatedFiles = [...new Set(report.mutants.map(m => m.location.file))];
    assert.deepEqual(mutatedFiles, ['src/core.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 3: resolveAnalyzePositionals auto-defaults PROJECT to "." for cwd files, globs, negated patterns, and non-project subdirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-pos-root-'));
  try {
    mkdirSync(join(dir, 'src/lib'), { recursive: true });
    mkdirSync(join(dir, 'packages/app/src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
    writeFileSync(join(dir, 'src/lib/role.ts'), 'export const r = 1;\n');
    writeFileSync(join(dir, 'packages/app/package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(dir, 'packages/app/src/a.ts'), 'export const a = 1;\n');

    assert.deepEqual(resolveAnalyzePositionals([], dir), { project: '.', files: [] });
    assert.deepEqual(resolveAnalyzePositionals(['.', 'src/lib/role.ts'], dir), { project: '.', files: ['src/lib/role.ts'] });
    assert.deepEqual(resolveAnalyzePositionals(['src/lib/role.ts'], dir), { project: '.', files: ['src/lib/role.ts'] });
    assert.deepEqual(resolveAnalyzePositionals(['src/lib'], dir), { project: '.', files: ['src/lib'] });
    assert.deepEqual(resolveAnalyzePositionals(['src/**/*.ts'], dir), { project: '.', files: ['src/**/*.ts'] });
    assert.deepEqual(resolveAnalyzePositionals(['!src/lib/role.ts'], dir), { project: '.', files: ['!src/lib/role.ts'] });
    assert.deepEqual(resolveAnalyzePositionals(['packages/app', 'src/a.ts'], dir), { project: 'packages/app', files: ['src/a.ts'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 4: isolated fallback surfaces reasons in mutant.fallback, trials.fallbackReasons, and --progress output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-isolated-reason-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'iso-reason', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'junction');
    writeFileSync(join(dir, 'src/check.ts'), 'export const ok = (n: number) => n >= 1;\n');
    writeFileSync(join(dir, 'test/check.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { ok } from '../src/check.ts';",
      "it('checks threshold', () => { expect(ok(1)).toBe(true); expect(ok(0)).toBe(false); });",
    ].join('\n') + '\n');

    const progressLines = [];
    const sessionReport = await analyzeConventional(dir, ['src/check.ts'], {
      mutators: 'targeted',
      'isolated-trials': true,
      progressIntervalMs: 10,
      onProgress: line => progressLines.push(line),
    });
    assert.equal(sessionReport.evaluation, 'evaluated');
    assert.ok(sessionReport.trials?.isolated >= 1, JSON.stringify(sessionReport.trials));
    assert.ok(sessionReport.trials?.fallbackReasons?.['isolated-trials'] >= 1, JSON.stringify(sessionReport.trials));
    assert.ok(sessionReport.mutants.some(m => m.fallback === 'isolated-trials'), JSON.stringify(sessionReport.mutants));
    assert.ok(
      progressLines.some(line => /isolated fallback: isolated-trials/.test(line)),
      `Expected isolated fallback reason in progress lines: ${JSON.stringify(progressLines)}`,
    );

    const run = spawnSync(process.execPath, [
      cli, 'analyze', 'src/check.ts', '--isolated-trials', '--format', 'json',
    ], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.ok(report.trials?.fallbackReasons?.['isolated-trials'] >= 1, JSON.stringify(report.trials));
    assert.ok(report.mutants.some(m => m.fallback === 'isolated-trials'), JSON.stringify(report.mutants));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 5: built-in StringLiteral and ArrayDeclaration replacements use tmt-mutated instead of Stryker was here', () => {
  const src = [
    'export const a = "";',
    'export const b = ``;',
    'export const c = [];',
  ].join('\n') + '\n';
  const mutations = collectMutations(src, 'src/literals.ts');
  const replacements = mutations.map(m => m.replacement);
  assert.ok(replacements.includes('"tmt-mutated"'), JSON.stringify(replacements));
  assert.ok(replacements.includes('`tmt-mutated`'), JSON.stringify(replacements));
  assert.ok(replacements.includes('["tmt-mutated"]'), JSON.stringify(replacements));
  assert.equal(replacements.some(r => /Stryker/i.test(r)), false, JSON.stringify(replacements));
});

test('Item 6: baseline v2 supports reason field, preserves reasons on rewrite, and exposes suppressed.reasons', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-baseline-reason-'));
  try {
    const file = resolve(dir, 'tmt-baseline.json');
    const diagA = {
      kind: 'INPUT GAP',
      location: { file: 'src/cart.ts', line: 10, column: 5 },
      rule: 'nullish-fallback/v1',
      expression: 'count ?? 10',
    };
    const diagB = {
      kind: 'ASSERTION GAP',
      location: { file: 'src/cart.ts', line: 20, column: 3 },
      rule: 'arithmetic-swap/v1',
      expression: 'a * b',
    };

    const initial = writeBaseline(file, [diagA]);
    assert.equal(initial.findings[0].reason, '');

    // User annotates reason in baseline file.
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.findings[0].reason = 'Equivalent: count is always normalized upstream';
    writeFileSync(file, JSON.stringify(edited, null, 2) + '\n', 'utf8');

    // Re-running --write-baseline preserves existing reason for diagA and initializes "" for diagB.
    const rewritten = writeBaseline(file, [diagA, diagB]);
    assert.equal(rewritten.findings[0].reason, 'Equivalent: count is always normalized upstream');
    assert.equal(rewritten.findings[1].reason, '');

    // Loading and applying baseline preserves suppressed.baseline/ids and adds suppressed.reasons.
    const loaded = loadBaselineWithReasons(file);
    assert.equal(loaded.ids.size, 2);
    assert.equal(loaded.reasons.get(findingId(diagA, 0)), 'Equivalent: count is always normalized upstream');
    assert.equal(loaded.reasons.has(findingId(diagB, 0)), false);

    const applied = applyBaseline({ diagnostics: [diagA, diagB] }, loaded);
    assert.equal(applied.diagnostics.length, 0);
    assert.equal(applied.suppressed.baseline, 2);
    assert.deepEqual(applied.suppressed.reasons, {
      [findingId(diagA, 0)]: 'Equivalent: count is always normalized upstream',
    });

    // Rejects non-string reason field.
    assert.throws(
      () => parseBaselineWithReasons(JSON.stringify({ version: 2, findings: [{ id: 'tmt-1', reason: 123 }] })),
      /reason must be a string/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PICT matrix verification/pict/npm-feedback-ux.tsv covers all pairs and mandatory seeds', () => {
  const tableLines = readFileSync(new URL('../verification/pict/npm-feedback-ux.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const seedLines = readFileSync(new URL('../verification/pict/npm-feedback-ux.seed.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
  const tableSet = new Set(tableLines);
  for (const seed of seedLines) {
    assert.ok(tableSet.has(seed), `Missing mandatory PICT seed: ${seed}`);
  }
  assert.ok(tableLines.length >= 20);

  const dir = mkdtempSync(join(tmpdir(), 'tmt-pict-ux-'));
  try {
    mkdirSync(join(dir, 'src/gen/keep'), { recursive: true });
    mkdirSync(join(dir, 'src/gen/drop'), { recursive: true });
    mkdirSync(join(dir, 'packages/sub/src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pict-root' }));
    writeFileSync(join(dir, 'packages/sub/package.json'), JSON.stringify({ name: 'pict-sub' }));
    writeFileSync(join(dir, '.gitignore'), 'src/gen/\n');
    writeFileSync(join(dir, 'src/gen/keep/ok.ts'), 'export const k = 1;\n');
    writeFileSync(join(dir, 'src/gen/drop/no.ts'), 'export const n = 2;\n');
    writeFileSync(join(dir, 'src/app.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/sample.ts'), 'export const s = "sample";\n');
    execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' });
    const gitignored = gitignoredCopyExclusions(dir);
    assert.ok(gitignored.includes('src/gen'));

    for (const row of tableLines) {
      const [copyFilter, targetExclude, positionalRoot, baselineReason, fallbackReason] = row.split('\t');

      const config = {};
      if (copyFilter === 'GitignoreOnly') config.copyExcludeGitignore = true;
      else if (copyFilter === 'GitignoreWithInclude') {
        config.copyExcludeGitignore = true;
        config.copyInclude = ['src/gen/keep'];
      } else if (copyFilter === 'ExcludeWithNestedInclude') {
        config.copyExclude = ['src/gen'];
        config.copyInclude = ['src/gen/keep'];
      }
      if (targetExclude === 'ExcludeOption' || targetExclude === 'Both') {
        config.exclude = ['src/sample.ts'];
      }
      if (fallbackReason === 'IsolatedFlag') config.isolatedTrials = true;

      const rawPos = positionalRoot === 'Omitted' ? []
        : positionalRoot === 'DotDir' ? ['.', 'src']
          : positionalRoot === 'ProjectSubDir' ? ['packages/sub']
            : positionalRoot === 'FileInCwd' ? ['src/app.ts']
              : positionalRoot === 'NonProjectSubDir' ? ['src']
                : positionalRoot === 'GlobInCwd' ? ['src/*.ts']
                  : ['/outside/missing.ts'];

      const resolvedPos = resolveAnalyzePositionals(rawPos, dir);
      if (positionalRoot === 'ProjectSubDir' || positionalRoot === 'OutsideFile') {
        assert.equal(resolvedPos.project, rawPos[0], row);
      } else {
        assert.equal(resolvedPos.project, '.', row);
      }

      const cliFiles = targetExclude === 'NegatedFilePattern'
        ? [...resolvedPos.files, '!src/sample.ts', '!src/gen/**']
        : targetExclude === 'Both'
          ? [...resolvedPos.files, '!src/gen/**']
          : resolvedPos.files;
      const merged = mergeProjectConfig(config, {}, cliFiles);

      if (copyFilter === 'ExcludeWithNestedInclude' || copyFilter === 'GitignoreWithInclude' || copyFilter === 'GitignoreOnly') {
        const effectiveExclude = copyFilter === 'ExcludeWithNestedInclude' ? merged.values['copy-exclude'] : gitignored;
        const effectiveInclude = copyFilter === 'GitignoreOnly' ? [] : merged.values['copy-include'];
        withCopy(dir, copyRoot => {
          assert.equal(existsSync(resolve(copyRoot, 'src/gen/keep/ok.ts')), copyFilter !== 'GitignoreOnly', row);
          assert.equal(existsSync(resolve(copyRoot, 'src/gen/drop/no.ts')), false, row);
        }, { exclude: effectiveExclude, include: effectiveInclude });
      }
      if (positionalRoot !== 'ProjectSubDir' && positionalRoot !== 'OutsideFile' && merged.files.length) {
        const validated = validateAndExpandInputs(dir, merged.files, merged.values);
        if (targetExclude !== 'None') {
          assert.equal(validated.files.includes('src/sample.ts'), false, row);
        }
        if (targetExclude === 'Both' || targetExclude === 'NegatedFilePattern') {
          assert.equal(validated.files.some(f => f.startsWith('src/gen/')), false, row);
        }
      }
      if (baselineReason === 'LoadedWithReasons') {
        const parsed = parseBaselineWithReasons(JSON.stringify({
          version: 2,
          findings: [{ id: 'tmt-abc', reason: 'accepted' }],
        }));
        assert.equal(parsed.reasons.get('tmt-abc'), 'accepted', row);
      } else if (baselineReason === 'PreserveOnRewrite') {
        const bFile = resolve(dir, 'pict-baseline.json');
        writeFileSync(bFile, JSON.stringify({ version: 2, findings: [{ id: 'tmt-keep', reason: 'keep-me' }] }));
        const rewritten = writeBaseline(bFile, [{ findingId: 'tmt-keep', kind: 'GAP', location: { file: 'src/app.ts' } }]);
        assert.equal(rewritten.findings[0].reason, 'keep-me', row);
      }
      if (fallbackReason === 'IsolatedFlag') {
        assert.equal(merged.values['isolated-trials'], true, row);
      } else if (fallbackReason === 'InWorkerReason') {
        const reasons = openReasons({ m: [{ id: '1', hitLimit: 10 }] }, [{ module: 'm', stop: '1' }]);
        assert.equal(reasons.get('1'), 'control-differs', row);
      } else if (fallbackReason === 'PlanNullFallback') {
        assert.equal(planInThread([{ modules: [['p', 'a'], ['p', 'b']] }], new Map(), [], dir), null, row);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex Round 1 regressions: explicit DIR FILE compatibility, absolute symlink exclusion, negated-only CLI preserving config files, malformed baseline protection, partial copyInclude sibling hints, and redundant slash normalization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-r1-regressions-'));
  try {
    mkdirSync(join(dir, 'src/generated/keep'), { recursive: true });
    mkdirSync(join(dir, 'src/generated/sdk'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r1-proj', type: 'module' }));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n');
    symlinkSync(resolve(dir, 'src/a.ts'), resolve(dir, 'src/alias.ts'));

    // 1. Explicit `analyze src a.ts` and `analyze src '*.ts'` preserve `src` as PROJECT when trailing args match inside `src`.
    assert.deepEqual(resolveAnalyzePositionals(['src', 'a.ts'], dir), { project: 'src', files: ['a.ts'] });
    assert.deepEqual(resolveAnalyzePositionals(['src', '*.ts'], dir), { project: 'src', files: ['*.ts'] });
    // While `analyze src` (no trailing args) defaults to ".".
    assert.deepEqual(resolveAnalyzePositionals(['src'], dir), { project: '.', files: ['src'] });

    // 2. Absolute symlink path preserves lexical link name both when PROJECT is omitted and when `.` is explicit.
    const absAlias = resolve(dir, 'src/alias.ts');
    const symPos = resolveAnalyzePositionals([absAlias], dir);
    assert.deepEqual(symPos, { project: '.', files: ['src/alias.ts'] });
    assert.deepEqual(filterExcludedFiles(dir, symPos.files, ['src/alias.ts']), []);
    assert.throws(
      () => validateAndExpandInputs(dir, [absAlias], { exclude: ['src/alias.ts'] }),
      /All selected source files were excluded/,
    );

    // 3. Negated-only CLI args keep config `files` instead of widening to entire project.
    const mergedNeg = mergeProjectConfig({ files: ['src/a.ts', 'src/b.ts'] }, {}, ['!src/b.ts']);
    assert.deepEqual(mergedNeg.files, ['src/a.ts', 'src/b.ts', '!src/b.ts']);
    const expNeg = validateAndExpandInputs(dir, mergedNeg.files, mergedNeg.values);
    assert.deepEqual(expNeg.files, ['src/a.ts']);

    // 4. Malformed existing baseline refuses to overwrite and preserves original bytes.
    const badBaseline = resolve(dir, 'bad-baseline.json');
    writeFileSync(badBaseline, '{ broken json with manual reason\n');
    assert.throws(() => writeBaseline(badBaseline, []), /Invalid baseline JSON/);
    assert.equal(readFileSync(badBaseline, 'utf8'), '{ broken json with manual reason\n');

    // 5. Partial copyInclude still hints on un-included sibling (even with same basename), `#` subpath imports, and Node ESM absolute paths.
    const hints = detectGitignoreBaselineHints({
      status: 'error',
      errors: [
        'Failed to resolve import "#generated/sdk/client"',
        'Failed to resolve import "@/generated/keep/ok"',
      ],
    }, ['src/generated'], ['src/generated/keep']);
    assert.equal(hints.length, 1);
    assert.match(hints[0], /#generated\/sdk\/client/);
    assert.match(hints[0], /--copy-include src\/generated/);

    const sameBasenameHints = detectGitignoreBaselineHints({
      status: 'error',
      errors: ['Failed to resolve import "./client"'],
    }, ['src/generated'], ['src/generated/keep/client.ts']);
    assert.equal(sameBasenameHints.length, 0);

    const nodeAbsHints = detectGitignoreBaselineHints({
      status: 'error',
      errors: ["Cannot find module '/tmp/tmt-xyz/project/src/generated/sdk/client.js'"],
    }, ['src/generated'], ['src/generated/keep/client.ts']);
    assert.equal(nodeAbsHints.length, 1);
    assert.match(nodeAbsHints[0], /src\/generated/);

    // 6. Redundant slashes in exclude patterns normalize cleanly.
    assert.deepEqual(filterExcludedFiles(dir, ['src/a.ts', 'src/b.ts'], ['src//a.ts']), ['src/b.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
