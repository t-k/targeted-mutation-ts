import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeBaseline } from '../src/baseline.mjs';
import { validateExcludeRules } from '../src/builtin-mutations.mjs';
import { computeCampaignContextDetails, openCheckpoint } from '../src/checkpoint.mjs';
import { analyzeOperators } from '../src/operator-analysis.mjs';
import { mergeProjectConfig } from '../src/project-config.mjs';
import { selectScope } from '../src/scope.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = resolve(repoRoot, 'bin/tmt.mjs');
const shippingFixture = resolve(repoRoot, 'fixtures/shipping');
const pictPath = resolve(repoRoot, 'verification/pict/dogfood-2026-11-29.tsv');

function runCli(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function makeTempVitestProject(files) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-df29-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = resolve(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  symlinkSync(resolve(repoRoot, 'node_modules'), resolve(dir, 'node_modules'), 'dir');
  return dir;
}

describe('2026-11-29 dogfooding fixes', () => {
  it('DF-001: rejects out-of-range --lines with an actionable error while allowing valid no-site lines', () => {
    assert.throws(
      () => selectScope(shippingFixture, [], { lines: ['src/shipping.ts:500'] }),
      /Line 500 is out of range for src\/shipping\.ts \(\d+ lines?\)/,
    );
    assert.throws(
      () => selectScope(shippingFixture, [], { lines: ['src/shipping.ts:1-500'] }),
      /Line range 1-500 is out of range for src\/shipping\.ts \(\d+ lines?\)/,
    );
    const cliErr = runCli(['analyze', shippingFixture, '--lines', 'src/shipping.ts:500', '--format', 'text']);
    assert.equal(cliErr.status, 1);
    assert.match(cliErr.stderr, /Line 500 is out of range for src\/shipping\.ts/);

    const dir = makeTempVitestProject({
      'package.json': JSON.stringify({ name: 'df001', type: 'module' }),
      'src/shipping.ts': '// header comment\nexport const shipsFree = (yen: number) => yen >= 5000;\n',
    });
    try {
      const validEmpty = runCli(['analyze', '.', '--lines', 'src/shipping.ts:1', '--format', 'json'], dir);
      assert.equal(validEmpty.status, 0, validEmpty.stderr);
      assert.equal(JSON.parse(validEmpty.stdout).evaluation, 'no_sites');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-002: --require-exercised fails on empty scope and all-unreached edits, and unevaluated carries statusReason', () => {
    const dir = makeTempVitestProject({
      'package.json': JSON.stringify({ name: 'df002', type: 'module' }),
      'src/shipping.ts': 'export function freeShipping(subtotal: number): boolean {\n  return subtotal >= 5000;\n}\n',
      'src/quote.ts': 'export function quote(subtotal: number): number {\n  return subtotal >= 1000 ? subtotal - 100 : subtotal;\n}\n',
      'test/shipping.test.ts': [
        "import { expect, test } from 'vitest';",
        "import { freeShipping } from '../src/shipping.ts';",
        "test('shipping', () => { expect(freeShipping(4000)).toBe(false); expect(freeShipping(6000)).toBe(true); });",
      ].join('\n'),
    });
    try {
      // Unreached file without --require-exercised exits 0, but unevaluated mutant carries statusReason
      const unreachedDefault = runCli(['analyze', '.', 'src/quote.ts', '--fail-on-gaps', '--format', 'json'], dir);
      assert.equal(unreachedDefault.status, 0, unreachedDefault.stderr);
      const report = JSON.parse(unreachedDefault.stdout);
      const unevaluated = report.mutants.filter(m => m.status === 'unevaluated');
      assert.ok(unevaluated.length > 0);
      assert.ok(unevaluated.every(m => typeof m.statusReason === 'string' && m.statusReason.length > 0));

      // With --require-exercised: all-unreached exits 1 with breakdown
      const unreachedStrict = runCli(['analyze', '.', 'src/quote.ts', '--require-exercised', '--fail-on-gaps', '--format', 'text'], dir);
      assert.equal(unreachedStrict.status, 1);
      assert.match(unreachedStrict.stderr, /--require-exercised failed: 0 of \d+ selected edit\(s\) were exercised/);

      // With --require-exercised: valid no-site line exits 1 with empty scope message
      const emptyStrict = runCli(['analyze', '.', '--lines', 'src/shipping.ts:3', '--require-exercised', '--format', 'text'], dir);
      assert.equal(emptyStrict.status, 1);
      assert.match(emptyStrict.stderr, /--require-exercised failed: no edit sites in the selected scope/);

      // With --require-exercised: exercised file with gaps exits 2 when --fail-on-gaps is set
      const exercisedWithGaps = runCli(['analyze', '.', 'src/shipping.ts', '--require-exercised', '--fail-on-gaps', '--format', 'json'], dir);
      assert.equal(exercisedWithGaps.status, 2);

      // Config key requireExercised maps to require-exercised
      const merged = mergeProjectConfig({ requireExercised: true }, {}, []);
      assert.equal(merged.values['require-exercised'], true);

      // Node runner without reachability fails --require-exercised when 0 edits are killed
      writeFileSync(resolve(dir, 'test/node-unreached.test.mjs'), [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "test('unrelated', () => { assert.equal(1 + 1, 2); });",
      ].join('\n'));
      const nodeStrict = runCli(['analyze', '.', 'src/quote.ts', '--runner', 'node', '--test', 'test/node-unreached.test.mjs', '--require-exercised', '--format', 'text'], dir);
      assert.equal(nodeStrict.status, 1);
      assert.match(nodeStrict.stderr, /--runner node does not record reachability and 0 of \d+ selected edit\(s\) were killed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-003: all-skipped Vitest selection reports an actionable error message and exits 1', () => {
    const dir = makeTempVitestProject({
      'package.json': JSON.stringify({ name: 'df003', type: 'module' }),
      'src/shipping.ts': 'export function freeShipping(subtotal: number): boolean {\n  return subtotal >= 5000;\n}\n',
      'test/skipped.test.ts': [
        "import { expect, test } from 'vitest';",
        "import { freeShipping } from '../src/shipping.ts';",
        "test.skip('skipped case', () => { expect(freeShipping(5000)).toBe(true); });",
      ].join('\n'),
    });
    try {
      const sessionRun = runCli(['analyze', '.', 'src/shipping.ts', '--test', 'test/skipped.test.ts', '--format', 'text'], dir);
      assert.equal(sessionRun.status, 1);
      assert.match(sessionRun.stdout, /No runnable tests were executed \(0 passed, 1 skipped\)\./);

      const auditRun = runCli(['analyze', '.', 'src/shipping.ts', '--test', 'test/skipped.test.ts', '--audit', '--format', 'text'], dir);
      assert.equal(auditRun.status, 1);
      assert.match(auditRun.stdout, /No runnable tests were executed \(0 passed, 1 skipped\)\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-004: --write-baseline preserves existing findings on empty/partial scopes unless --replace-baseline is passed', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-df004-'));
    try {
      const file = resolve(dir, 'baseline.json');
      const diagA = { kind: 'INPUT GAP', location: { file: 'src/a.ts', line: 2, column: 1 }, rule: 'comparison-boundary/v1', expression: 'a >= 10' };
      const diagB = { kind: 'INPUT GAP', location: { file: 'src/b.ts', line: 2, column: 1 }, rule: 'comparison-boundary/v1', expression: 'b >= 20' };

      const initial = writeBaseline(file, [diagA, diagB]);
      assert.equal(initial.findings.length, 2);
      // Add a human reason to diagA
      const withReason = JSON.parse(readFileSync(file, 'utf8'));
      withReason.findings[0].reason = 'accepted legacy boundary';
      writeFileSync(file, JSON.stringify(withReason, null, 2) + '\n', 'utf8');

      // Empty scope (no_sites) preserves existing baseline byte-identically
      const beforeEmpty = readFileSync(file, 'utf8');
      const emptyRes = writeBaseline(file, [], { evaluation: 'no_sites', scopedFiles: new Set(['src/a.ts']), partialInFile: true });
      assert.equal(emptyRes.preserved, true);
      assert.equal(emptyRes.findings.length, 2);
      assert.equal(readFileSync(file, 'utf8'), beforeEmpty);

      // Partial file scope (only src/b.ts evaluated, now fixed -> 0 diagnostics) keeps src/a.ts and its reason
      const partialRes = writeBaseline(file, [], { evaluation: 'evaluated', scopedFiles: new Set(['src/b.ts']), partialInFile: false });
      assert.equal(partialRes.preserved, false);
      assert.equal(partialRes.findings.length, 1);
      assert.equal(partialRes.findings[0].file, 'src/a.ts');
      assert.equal(partialRes.findings[0].reason, 'accepted legacy boundary');
      assert.equal(partialRes.stats.removed, 1);
      assert.equal(partialRes.stats.kept, 1);

      // Explicit --replace-baseline clears even on empty scope
      const replaced = writeBaseline(file, [], { evaluation: 'no_sites', replace: true });
      assert.equal(replaced.preserved, false);
      assert.equal(replaced.findings.length, 0);
      assert.equal(replaced.stats.removed, 1);

      // CLI rejects --replace-baseline without --write-baseline
      const badFlag = runCli(['analyze', shippingFixture, '--replace-baseline']);
      assert.equal(badFlag.status, 1);
      assert.match(badFlag.stderr, /--replace-baseline requires --write-baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-005: checkpoint ignores invocation-owned outputs and reports invalidationReason when context changes', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-df005-'));
    try {
      cpSync(shippingFixture, dir, { recursive: true });
      symlinkSync(resolve(repoRoot, 'node_modules'), resolve(dir, 'node_modules'), 'dir');

      // Write reports into a non-built-in directory (out/) to prove invocation-owned exclusion works anywhere
      const args = [
        'analyze', '.', 'src/shipping.ts',
        '--checkpoint', 'out/campaign.jsonl',
        '--json-out', 'out/result.json',
        '--sarif-out', 'out/result.sarif',
        '--format', 'json',
        '--progress',
      ];
      const run1 = runCli(args, dir);
      assert.equal(run1.status, 0, run1.stderr);
      const r1 = JSON.parse(run1.stdout);
      assert.equal(r1.checkpoint.resumed, false);
      assert.ok(r1.checkpoint.recorded >= 1);

      const run2 = runCli(args, dir);
      assert.equal(run2.status, 0, run2.stderr);
      const r2 = JSON.parse(run2.stdout);
      assert.equal(r2.checkpoint.resumed, true);
      assert.equal(r2.checkpoint.reused, r1.checkpoint.recorded);
      assert.equal(r2.checkpoint.recorded, 0);
      assert.equal(r2.checkpoint.invalidationReason, undefined);

      // Modify a source file -> invalidationReason reports project files changed
      writeFileSync(resolve(dir, 'src/shipping.ts'), readFileSync(resolve(dir, 'src/shipping.ts'), 'utf8') + '\n// touch\n', 'utf8');
      const run3 = runCli(args, dir);
      assert.equal(run3.status, 0, run3.stderr);
      const r3 = JSON.parse(run3.stdout);
      assert.equal(r3.checkpoint.resumed, false);
      assert.equal(r3.checkpoint.invalidationReason, 'project files changed');
      assert.match(run3.stderr, /Checkpoint invalidated \(project files changed\)/);

      // Change analysis option -> invalidationReason reports analysis options changed
      const run4 = runCli([...args, '--deterministic'], dir);
      assert.equal(run4.status, 0, run4.stderr);
      const r4 = JSON.parse(run4.stdout);
      assert.equal(r4.checkpoint.resumed, false);
      assert.equal(r4.checkpoint.invalidationReason, 'analysis options changed');
      assert.match(run4.stderr, /Checkpoint invalidated \(analysis options changed\)/);

      // Refuses to use project config or source/test files as output path
      const badOut = runCli(['analyze', '.', 'src/shipping.ts', '--json-out', 'package.json'], dir);
      assert.equal(badOut.status, 1);
      assert.match(badOut.stderr, /Refusing to use project input file as --json-out output/);

      const badTestOut = runCli(['analyze', '.', 'src/shipping.ts', '--checkpoint', 'test/shipping.test.ts'], dir);
      assert.equal(badTestOut.status, 1);
      assert.match(badTestOut.stderr, /Refusing to use project input file as --checkpoint output/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-006: imported constant threshold generates ready suggestedTest assertions while mutable properties do not', async () => {
    const dir = makeTempVitestProject({
      'package.json': JSON.stringify({ name: 'df006', type: 'module' }),
      'src/catalog.ts': 'export const FREE_SHIPPING_THRESHOLD = 5000;\nexport const LIMITS = { min: 100 };\n',
      'src/shipping.ts': [
        "import { FREE_SHIPPING_THRESHOLD, LIMITS } from './catalog.ts';",
        'export function qualifiesForFreeShipping(subtotal: number): boolean {',
        '  return subtotal >= FREE_SHIPPING_THRESHOLD;',
        '}',
        'export const meetsMin = (qty: number): boolean => qty >= LIMITS.min;',
      ].join('\n'),
      'test/shipping.test.ts': [
        "import { expect, test } from 'vitest';",
        "import { qualifiesForFreeShipping, meetsMin } from '../src/shipping.ts';",
        "test('shipping', () => {",
        '  expect(qualifiesForFreeShipping(4000)).toBe(false);',
        '  expect(qualifiesForFreeShipping(6000)).toBe(true);',
        '  expect(meetsMin(50)).toBe(false);',
        '  expect(meetsMin(150)).toBe(true);',
        '});',
      ].join('\n'),
    });
    try {
      const report = await analyzeOperators(dir, ['src/shipping.ts'], { mutators: 'targeted' });
      assert.equal(report.evaluation, 'evaluated');
      const freeGaps = report.diagnostics.filter(d => d.location.line === 3);
      assert.equal(freeGaps.length, 2);
      const suggestions = freeGaps.map(d => d.suggestedTest).sort();
      assert.deepEqual(suggestions, [
        'expect(qualifiesForFreeShipping(4999)).toBe(false)',
        'expect(qualifiesForFreeShipping(5000)).toBe(true)',
      ]);

      // Mutable object property must not fabricate a suggestedTest
      const minGaps = report.diagnostics.filter(d => d.location.line === 5);
      assert.equal(minGaps.length, 2);
      assert.ok(minGaps.every(d => d.suggestedTest === undefined));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DF-007: validates --exclude-rule names with typo suggestions and honors focused rule exclusions consistently', async () => {
    assert.throws(
      () => validateExcludeRules(['comparison-threshhold']),
      /Unknown rule "comparison-threshhold" in --exclude-rule\. Did you mean "comparison-threshold\/v1"\?/,
    );
    assert.deepEqual(validateExcludeRules(['nullish-equality', 'comparison-threshold/v1', 'comparison-tighten/v1']), [
      'nullish-equality/v1',
      'comparison-threshold/v1',
      'comparison-tighten/v1',
    ]);

    const badCli = runCli(['analyze', shippingFixture, '--exclude-rule', 'comparison-threshhold']);
    assert.equal(badCli.status, 1);
    assert.match(badCli.stderr, /Unknown rule "comparison-threshhold".*Did you mean "comparison-threshold\/v1"\?/);

    const excludedReport = await analyzeOperators(shippingFixture, ['src/shipping.ts'], {
      mutators: 'targeted',
      'exclude-rule': ['comparison-threshold/v1'],
    });
    assert.equal(excludedReport.evaluation, 'evaluated');
    assert.ok(excludedReport.mutants.every(m => m.rule !== 'comparison-threshold/v1'));

    const listExcludedBoundary = runCli(['analyze', shippingFixture, 'src/shipping.ts', '--list', '--exclude-rule', 'comparison-boundary/v1', '--format', 'json']);
    assert.equal(listExcludedBoundary.status, 0, listExcludedBoundary.stderr);
    const listed = JSON.parse(listExcludedBoundary.stdout);
    assert.equal(listed.mutants.length, 0);

    // Excluding comparison-boundary/v1 still preserves comparison-threshold/v1 synthesis at runtime
    const excludedBoundaryReport = await analyzeOperators(shippingFixture, ['src/shipping.ts'], {
      mutators: 'targeted',
      'exclude-rule': ['comparison-boundary/v1'],
    });
    assert.equal(excludedBoundaryReport.evaluation, 'evaluated');
    assert.ok(excludedBoundaryReport.mutants.every(m => m.rule !== 'comparison-boundary/v1'));
    assert.ok(excludedBoundaryReport.mutants.some(m => m.rule === 'comparison-threshold/v1'));
  });

  it('DF-008: unparenthesized comparison inside nested ternary retains boundary and threshold mutations', async () => {
    const dir = makeTempVitestProject({
      'package.json': JSON.stringify({ name: 'df008', type: 'module' }),
      'src/delivery.ts': 'export const deliveryFee = (express: boolean, subtotal: number) => express ? 15 : subtotal >= 5000 ? 0 : 5;\n',
      'test/delivery.test.ts': [
        "import { expect, test } from 'vitest';",
        "import { deliveryFee } from '../src/delivery.ts';",
        "test('delivery', () => {",
        '  expect(deliveryFee(true, 100)).toBe(15);',
        '  expect(deliveryFee(false, 4000)).toBe(5);',
        '  expect(deliveryFee(false, 6000)).toBe(0);',
        '});',
      ].join('\n'),
    });
    try {
      const report = await analyzeOperators(dir, ['src/delivery.ts'], { mutators: 'targeted' });
      assert.equal(report.evaluation, 'evaluated');
      const rules = new Set(report.mutants.map(m => m.rule));
      assert.ok(rules.has('comparison-boundary/v1'));
      assert.ok(rules.has('comparison-threshold/v1'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers every PICT row in verification/pict/dogfood-2026-11-29.tsv', () => {
    const rows = readFileSync(pictPath, 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split('\t'));
    assert.equal(rows.length, 21);

    const dir = mkdtempSync(resolve(tmpdir(), 'tmt-df29-pict-'));
    try {
      for (let i = 0; i < rows.length; i++) {
        const [scopeKind, baselineWrite, requireExercised, exercisedOutcome, checkpointOutputs] = rows[i];

        // 1. ScopeKind: OutOfRangeLine must throw from selectScope
        if (scopeKind === 'OutOfRangeLine') {
          assert.throws(() => selectScope(shippingFixture, [], { lines: ['src/shipping.ts:999'] }), /out of range/);
        }

        // 2. BaselineWrite behavior
        if (baselineWrite !== 'None') {
          const bFile = resolve(dir, `baseline-${i}.json`);
          const existingA = { kind: 'INPUT GAP', location: { file: 'src/a.ts', line: 1, column: 1 }, rule: 'comparison-boundary/v1', expression: 'a >= 1' };
          const existingB = { kind: 'INPUT GAP', location: { file: 'src/b.ts', line: 1, column: 1 }, rule: 'comparison-boundary/v1', expression: 'b >= 2' };
          if (baselineWrite === 'MergeExisting' || baselineWrite === 'ReplaceExisting') {
            writeBaseline(bFile, [existingA, existingB]);
          }
          const evaluation = exercisedOutcome === 'NoSites' ? 'no_sites' : 'evaluated';
          const scopedFiles = scopeKind === 'Full' ? null : new Set(['src/b.ts']);
          const partialInFile = scopeKind === 'PartialLine' || scopeKind === 'EmptyLineScope';
          const res = writeBaseline(bFile, exercisedOutcome === 'ExercisedWithGap' ? [existingB] : [], {
            replace: baselineWrite === 'ReplaceExisting',
            evaluation,
            scopedFiles,
            partialInFile,
          });
          if (baselineWrite === 'MergeExisting' && evaluation === 'no_sites') {
            assert.equal(res.preserved, true);
            assert.equal(res.findings.length, 2);
          } else if (baselineWrite === 'ReplaceExisting') {
            assert.equal(res.preserved, false);
            assert.equal(res.findings.length, exercisedOutcome === 'ExercisedWithGap' ? 1 : 0);
          } else if (baselineWrite === 'MergeExisting' && (scopeKind === 'PartialFile' || scopeKind === 'PartialLine')) {
            assert.ok(res.findings.some(f => f.file === 'src/a.ts'));
          }
        }

        // 3. RequireExercised exit contract
        const mutants = exercisedOutcome === 'NoSites' ? []
          : exercisedOutcome === 'AllUnreached' ? [{ status: 'unreached' }, { status: 'unevaluated' }]
            : [{ status: exercisedOutcome === 'ExercisedWithGap' ? 'survived' : 'killed' }];
        const exercised = mutants.filter(m => ['killed', 'survived'].includes(m.status)).length;
        const shouldFailRequire = requireExercised === 'On' && (exercisedOutcome === 'NoSites' || exercised === 0);
        assert.equal(shouldFailRequire, requireExercised === 'On' && (exercisedOutcome === 'NoSites' || exercisedOutcome === 'AllUnreached'));

        // 4. CheckpointOutputs context stability & invalidation reason
        if (checkpointOutputs !== 'None') {
          const proj = resolve(dir, `ckpt-proj-${i}`);
          mkdirSync(resolve(proj, 'src'), { recursive: true });
          writeFileSync(resolve(proj, 'src/a.ts'), 'export const a = (x: number) => x >= 10;\n', 'utf8');
          const ckptPath = resolve(proj, checkpointOutputs === 'SameDirReports' ? 'reports/c.jsonl' : 'custom/c.jsonl');
          const jsonOut = resolve(proj, checkpointOutputs === 'SameDirReports' ? 'reports/r.json' : 'custom/r.json');
          const opts = { mutators: 'targeted', checkpoint: ckptPath, 'json-out': jsonOut };
          const d1 = computeCampaignContextDetails([], opts, proj);
          const store1 = openCheckpoint(ckptPath, d1.context, { filesHash: d1.filesHash, optionsHash: d1.optionsHash });
          store1.record('k1', { status: 'killed' });
          mkdirSync(dirname(jsonOut), { recursive: true });
          writeFileSync(jsonOut, '{"ok":true}\n', 'utf8');
          if (checkpointOutputs === 'ModifiedSource') {
            writeFileSync(resolve(proj, 'src/a.ts'), 'export const a = (x: number) => x >= 11;\n', 'utf8');
          }
          const d2 = computeCampaignContextDetails([], opts, proj);
          const store2 = openCheckpoint(ckptPath, d2.context, { filesHash: d2.filesHash, optionsHash: d2.optionsHash });
          if (checkpointOutputs === 'ModifiedSource') {
            assert.equal(store2.matched, false);
            assert.equal(store2.invalidationReason, 'project files changed');
          } else {
            assert.equal(store2.matched, true);
            assert.equal(store2.reused, 1);
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
