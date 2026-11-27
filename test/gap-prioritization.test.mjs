import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderText } from '../src/cli-output.mjs';
import { analyzeOperators } from '../src/operator-analysis.mjs';
import { classifyRoundingEquivalenceText, isProvablyNonNegativeNode } from '../src/reachability.mjs';
import { targetedGap } from '../src/targeted-gaps.mjs';
import { loadTypeScript } from '../src/typescript-compiler.mjs';

const pictRows = readFileSync(new URL('../verification/pict/gap-prioritization.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

const argExprs = {
  NonNegativeLiteral: '5',
  LengthProp: 'items.length',
  NonNegDivPositiveLiteral: 'items.length / 2',
  NonNegDivVar: 'items.length / total',
  SignedVar: 'delta',
  NegativeLiteral: '-1.5',
  MathMaxNonNeg: 'Math.max(0, x) / 2',
};

for (const [argShape, roundingPair, mutantOutcome] of pictRows) {
  test(`gap prioritization PICT: ${argShape} / ${roundingPair} / ${mutantOutcome}`, () => {
    const expr = argExprs[argShape];
    const [origFn, swapFn] = {
      FloorToTrunc: ['floor', 'trunc'],
      TruncToFloor: ['trunc', 'floor'],
      FloorToCeil: ['floor', 'ceil'],
      FloorToRound: ['floor', 'round'],
    }[roundingPair];
    const code = `export function f(items, total, delta, x) { return Math.${origFn}(${expr}); }\n`;
    const mutations = collectMutations(code, 'sample.mjs', { targeted: true });
    const mut = mutations.find(m => m.name === 'rounding-swap/v1' && m.targeted?.form === swapFn);
    assert.ok(mut, `expected rounding-swap/v1 ${origFn}->${swapFn} for ${expr}`);

    const provablyNonNeg = ['NonNegativeLiteral', 'MathMaxNonNeg'].includes(argShape);
    const likelyNonNeg = ['LengthProp', 'NonNegDivPositiveLiteral', 'NonNegDivVar'].includes(argShape);
    const isFloorTrunc = roundingPair === 'FloorToTrunc' || roundingPair === 'TruncToFloor';

    if (isFloorTrunc && provablyNonNeg) {
      assert.ok(mut.ignored, `expected ${origFn}->${swapFn}(${expr}) to be ignored as equivalent`);
      assert.match(mut.ignored, /Equivalent mutant/);
    } else if (isFloorTrunc && likelyNonNeg) {
      assert.equal(mut.ignored, undefined);
      assert.equal(mut.targeted.equivalenceHint, 'likely-equivalent');
    } else {
      assert.equal(mut.ignored, undefined);
      assert.equal(mut.targeted.equivalenceHint, undefined);
    }

    if (mutantOutcome.startsWith('Timeout')) {
      const reason = {
        TimeoutHitLimit: 'Mutation hit limit reached',
        TimeoutWallClock: 'Vitest test timeout',
        TimeoutWorkerHung: 'The worker stopped answering',
      }[mutantOutcome];
      const text = renderText({
        runner: 'vitest',
        evaluation: 'evaluated',
        baseline: { status: 'passed', tests: 3 },
        mutants: [{
          location: { file: 'sample.mjs', line: 1, column: 50, start: 49, end: 60 },
          rule: 'rounding-swap/v1',
          original: `Math.${origFn}(${expr})`,
          replacement: `Math.${swapFn}(${expr})`,
          status: 'timeout',
          statusReason: reason,
        }],
        diagnostics: [],
      });
      assert.ok(text.includes(`(${reason})`), `expected timeout reason in text output: ${text}`);
    }
  });
}

test('classifyRoundingEquivalenceText handles sound non-negative expressions and rejects signed ones', () => {
  const ts = loadTypeScript();
  // 100% sound provably non-negative (never negative, never -0 divisor)
  for (const expr of ['0', 'Math.abs(x)', 'Math.abs(x) / 2', 'Math.hypot(a, b)', 'Math.clz32(x)', 'x >>> 1',
    'Math.max(0, x)', 'Math.max(0, x) / 2', 'Math.min(Math.abs(a), Math.abs(b))', 'Math.abs(a) + Math.abs(b)', 'Math.abs(a) % n', 'cond ? 1 : Math.abs(a)']) {
    assert.equal(classifyRoundingEquivalenceText(expr, ts)?.kind, 'equivalent', `expected equivalent for ${expr}`);
  }
  // Likely equivalent (always executed, never suppressed, annotated if surviving)
  for (const expr of ['arr.length', 'map.size', 'buf.byteLength', 'items.length / 2', 'items.length / total',
    'ids.length / count', 'Math.abs(x) * factor', 'Math.sqrt(x)', '({ length: -1 }).length / 2']) {
    assert.equal(classifyRoundingEquivalenceText(expr, ts)?.kind, 'likely-equivalent', `expected likely-equivalent for ${expr}`);
  }
  // Distinguishable / signed expressions (neither equivalent nor likely-equivalent)
  for (const expr of ['x', 'x / 2', 'a - b', '-items.length', 'Math.min(0, x)', 'Math.max(-1, x)', 'a + b', 'Math.max(1 / Math.sqrt(-0), -1.5)']) {
    assert.notEqual(classifyRoundingEquivalenceText(expr, ts)?.kind, 'equivalent', `must NOT suppress ${expr}`);
  }
  assert.equal(classifyRoundingEquivalenceText('x / 2', ts), null);
  assert.equal(classifyRoundingEquivalenceText('Math.max(1 / Math.sqrt(-0), -1.5)', ts), null);
  assert.equal(isProvablyNonNegativeNode(null, ts), false);
});

test('targetedGap propagates equivalenceHint and renderText displays it', () => {
  const mutant = {
    id: 'm1',
    mutatorName: 'rounding-swap/v1',
    original: 'Math.floor(items.length / total)',
    replacement: 'Math.trunc(items.length / total)',
    edit: [10, 42],
    location: { file: 'src/shard.mjs', line: 35, column: 18, start: 10, end: 42 },
    status: 'survived',
    evidence: 'reexecuted',
    targeted: {
      operator: 'floor',
      form: 'trunc',
      left: 'items.length / total',
      equivalenceHint: 'likely-equivalent',
      equivalenceReason: 'likely equivalent: Math.floor and Math.trunc agree on non-negative values; only a negative divisor or factor makes this expression negative',
    },
  };
  const gap = targetedGap(mutant, { agreeing: 2, differing: [], unsure: [], outside: false, outsideUnsure: false });
  assert.equal(gap.kind, 'INPUT GAP');
  assert.equal(gap.equivalenceHint, 'likely-equivalent');
  const text = renderText({
    runner: 'vitest',
    evaluation: 'evaluated',
    baseline: { status: 'passed', tests: 2 },
    mutants: [mutant],
    diagnostics: [gap],
  });
  assert.match(text, /note: likely equivalent: Math\.floor and Math\.trunc agree on non-negative values/);
});

test('renderText shows baseline collected files and fileErrors without duplicating errors', () => {
  const text = renderText({
    evaluation: 'baseline_error',
    baseline: {
      status: 'error',
      files: ['test/a.test.mjs', 'fixtures/playwright/e2e/checkout.spec.ts'],
      fileErrors: [{ file: 'fixtures/playwright/e2e/checkout.spec.ts', message: 'Playwright Test did not expect test() to be called here\n    at stack' }],
      errors: [
        'Playwright Test did not expect test() to be called here\n    at stack',
        'Global setup failed',
      ],
      failedTests: [],
    },
  });
  assert.match(text, /^ {2}Collected test files \(2\): test\/a\.test\.mjs, fixtures\/playwright\/e2e\/checkout\.spec\.ts$/m);
  assert.match(text, /^ {2}ERROR fixtures\/playwright\/e2e\/checkout\.spec\.ts: Playwright Test did not expect test\(\) to be called here$/m);
  assert.match(text, /^ {2}ERROR Global setup failed$/m);
  assert.equal((text.match(/Playwright Test did not expect/g) ?? []).length, 1);

  // Truncates long file list cleanly
  const manyFiles = Array.from({ length: 12 }, (_, i) => `test/f${i}.test.mjs`);
  const timeoutText = renderText({
    evaluation: 'baseline_error',
    baseline: { status: 'timeout', timeoutSeconds: 30, files: manyFiles },
  });
  assert.match(timeoutText, /Collected test files \(12\): .*and 2 more/);
});

test('analyzeOperators preserves timeout statusReason from Vitest session into focused comparison-boundary mutants', async () => {
  const site = {
    id: 's1',
    location: { file: 'src/binsearch.mjs', line: 10, column: 12, start: 100, end: 101 },
    rule: 'comparison-boundary/v1',
    operator: '<',
    edit: [100, 101],
    replacement: '<=',
  };
  const sessionMutant = {
    id: 'm1',
    mutatorName: 'EqualityOperator',
    location: site.location,
    edit: [96, 105],
    operatorSwap: [100, '<='],
    replacement: 'low <= high',
    status: 'timeout',
    statusReason: 'Mutation hit limit reached',
  };
  let capturedVerdict;
  const fakeRun = {
    analyzeConventional: async () => ({
      schemaVersion: 1, runner: 'vitest', mutators: 'targeted', evaluation: 'evaluated',
      baseline: { status: 'passed', tests: 1 }, mutants: [sessionMutant], diagnostics: [],
    }),
    prepareAnalysis: () => ({
      trials: [{ site, rule: site.rule, edit: site.edit, replacement: site.replacement }],
      skips: new Set(),
      report: { schemaVersion: 1, runner: 'vitest', extraction: [], mutants: [], diagnostics: [], evaluation: 'evaluated' },
    }),
    completeAnalysis: (_prepared, settled) => {
      capturedVerdict = settled({ site, rule: site.rule, edit: site.edit, replacement: site.replacement });
      return {
        schemaVersion: 1, runner: 'vitest', extraction: [], diagnostics: [], evaluation: 'evaluated',
        baseline: { status: 'passed', tests: 1 },
        mutants: [{ ...site, status: capturedVerdict.status, statusReason: capturedVerdict.statusReason }],
      };
    },
  };
  const out = await analyzeOperators('.', ['src/binsearch.mjs'], { mutators: 'targeted' }, fakeRun);
  assert.equal(capturedVerdict.status, 'timeout');
  assert.equal(capturedVerdict.statusReason, 'Mutation hit limit reached');
  assert.equal(out.mutants[0].statusReason, 'Mutation hit limit reached');
});
