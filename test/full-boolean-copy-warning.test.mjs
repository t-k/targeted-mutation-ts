import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { collectComparisons } from '../src/analysis.mjs';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderBuiltinSwitches } from '../src/builtin-switches.mjs';
import { usage } from '../src/cli-output.mjs';
import { listCandidates } from '../src/shard.mjs';
import { withCopy } from '../src/vitest.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = resolve('node_modules');

function readPict(name) {
  const rows = readFileSync(new URL(`../verification/pict/${name}.tsv`, import.meta.url), 'utf8').trim().split('\n').slice(1);
  const seeds = readFileSync(new URL(`../verification/pict/${name}.seed.tsv`, import.meta.url), 'utf8').trim().split('\n').slice(1);
  return { rows, seeds };
}

// --- Issue 1: --mutators full includes targeted rules and preserves inner built-in switches ---

test('Issue 1: PICT full-profile-targeted table contains all required seeds', () => {
  const { rows, seeds } = readPict('full-profile-targeted');
  const set = new Set(rows);
  for (const seed of seeds) assert.ok(set.has(seed), `Missing seed: ${seed}`);
});

test('Issue 1: PICT full-profile-targeted covers Session, List, and SourceRewrite paths', () => {
  const { rows } = readPict('full-profile-targeted');
  const logicalAndSpreadSrc = [
    'export function combine(a: string | undefined, b: string | undefined, base: { x: number; y: number }) {',
    '  const chosen = a || b;',
    '  const next = { ...base, x: 1, y: 2 };',
    '  return chosen ? next.x : next.y;',
    '}',
  ].join('\n') + '\n';
  const logicalAndSpreadTest = [
    "import { expect, it } from 'vitest';",
    "import { combine } from './subject';",
    "it('uses fallback y when both missing', () => {",
    '  expect(combine(undefined, undefined, { x: 1, y: 2 })).toBe(2);',
    '});',
  ].join('\n') + '\n';

  const observedInnerSrc = [
    'export function inspect(arr: number[], text: string, val: number) {',
    '  const last = arr[arr.length - 1];',
    '  const tail = arr.at(-1);',
    "  const hit = ['alpha', 'beta'].includes(text);",
    '  const anchored = /^foo$/.test(text);',
    '  const clamped = Math.min(Math.max(val, 0), 10);',
    '  return { last, tail, hit, anchored, clamped };',
    '}',
  ].join('\n') + '\n';
  const observedInnerTest = [
    "import { expect, it } from 'vitest';",
    "import { inspect } from './subject';",
    "it('runs inspect', () => {",
    "  expect(inspect([1, 2], 'alpha', 5)).toEqual({ last: 2, tail: 2, hit: true, anchored: false, clamped: 5 });",
    '});',
  ].join('\n') + '\n';

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tmt-full-targeted-')));
  try {
    symlinkSync(repoNodeModules, join(scratch, 'node_modules'), 'junction');
    const projects = {};
    for (const [shape, src, spec] of [
      ['LogicalAndSpread', logicalAndSpreadSrc, logicalAndSpreadTest],
      ['ObservedWithInnerBuiltin', observedInnerSrc, observedInnerTest],
    ]) {
      const dir = join(scratch, shape);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'subject.ts'), src);
      writeFileSync(join(dir, 'subject.test.ts'), spec);
      projects[shape] = dir;
    }

    // Collect targeted baseline gaps for LogicalAndSpread to assert full is a superset.
    const targetedRun = spawnSync(process.execPath, [
      cli, 'analyze', projects.LogicalAndSpread, 'subject.ts', '--mutators', 'targeted', '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(targetedRun.status, 0, targetedRun.stderr + targetedRun.stdout);
    const targetedReport = JSON.parse(targetedRun.stdout);
    const targetedGapKeys = new Set(targetedReport.diagnostics.map(g => `${g.rule}:${g.location.line}:${g.location.column}`));
    assert.ok(targetedGapKeys.size >= 2, 'Expected targeted gaps on LogicalAndSpread');

    for (const line of rows) {
      const [profileName, execPath, siteShape] = line.split('\t');
      const mutators = profileName === 'Full' ? 'full' : 'targeted';
      const dir = projects[siteShape];
      const expectedTargetedRule = siteShape === 'LogicalAndSpread' ? 'ignored-operand/v1' : 'sequence-end/v1';
      const expectedBuiltinRule = siteShape === 'LogicalAndSpread' ? 'LogicalOperator' : 'ArithmeticOperator';

      if (execPath === 'List') {
        const listed = listCandidates(dir, ['subject.ts'], { mutators });
        const names = new Set(listed.mutants.map(m => m.mutatorName ?? m.rule));
        assert.ok(names.has(expectedTargetedRule), `${line}: missing ${expectedTargetedRule} in list`);
        assert.equal(names.has(expectedBuiltinRule), mutators === 'full', `${line}: builtin ${expectedBuiltinRule} mismatch in list`);
      } else if (execPath === 'SourceRewrite') {
        const { subjects } = collectComparisons(dir, ['subject.ts'], { mutators });
        const names = new Set(subjects.flatMap(s => s.sites.map(site => site.rule)));
        assert.ok(names.has(expectedTargetedRule), `${line}: missing ${expectedTargetedRule} in SourceRewrite`);
        assert.equal(names.has(expectedBuiltinRule), mutators === 'full', `${line}: builtin ${expectedBuiltinRule} mismatch in SourceRewrite`);
      } else if (execPath === 'Session') {
        const run = spawnSync(process.execPath, [
          cli, 'analyze', dir, 'subject.ts', '--mutators', mutators, '--format', 'json',
        ], { encoding: 'utf8', timeout: 120_000 });
        assert.equal(run.status, 0, `${line}: ${run.stderr + run.stdout}`);
        const report = JSON.parse(run.stdout);
        assert.equal(report.evaluation, 'evaluated', line);
        const names = new Set(report.mutants.map(m => m.mutatorName ?? m.rule));
        assert.ok(names.has(expectedTargetedRule), `${line}: missing ${expectedTargetedRule} in session`);
        assert.equal(names.has(expectedBuiltinRule), mutators === 'full', `${line}: builtin ${expectedBuiltinRule} mismatch in session`);
        if (mutators === 'full' && siteShape === 'LogicalAndSpread') {
          const fullGapKeys = new Set(report.diagnostics.map(g => `${g.rule}:${g.location.line}:${g.location.column}`));
          for (const key of targetedGapKeys) {
            assert.ok(fullGapKeys.has(key), `Full profile dropped targeted gap: ${key}`);
          }
          assert.ok(report.diagnostics.some(g => g.rule === 'ignored-operand/v1'));
          assert.ok(report.diagnostics.some(g => g.rule === 'spread-property-drop/v1'));
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Issue 1: full-profile renderBuiltinSwitches lifts inner built-in switches outside observed probes', () => {
  const source = [
    'function inspect(arr, text, val) {',
    '  const last = arr[arr.length - 1];',
    '  const tail = arr.at(-1);',
    "  const hit = ['alpha', 'beta'].includes(text);",
    '  const anchored = /^foo$/.test(text);',
    '  const clamped = Math.min(Math.max(val, 0), 10);',
    '  return [last, tail, hit, anchored, clamped];',
    '}',
  ].join('\n') + '\n';

  const rendered = renderBuiltinSwitches(Buffer.from(source), 'inspect.js', () => true, { targeted: true });
  const live = rendered.mutants.filter(m => m.status !== 'ignored');
  assert.ok(live.some(m => m.mutatorName === 'ArithmeticOperator' && m.original === 'arr.length - 1'));
  assert.ok(live.some(m => m.mutatorName === 'UnaryOperator' && m.original === '-1'));
  assert.ok(live.some(m => m.mutatorName === 'ArrayDeclaration' && m.original === "['alpha', 'beta']"));
  assert.ok(live.some(m => m.mutatorName === 'StringLiteral' && m.original === "'alpha'"));
  assert.ok(live.some(m => m.mutatorName === 'Regex'));
  assert.ok(live.some(m => m.mutatorName === 'MethodExpression' && m.original === 'Math.max(val, 0)'));

  // Every live mutant ID must be present in the instrumented code (either in a switch or in the probe table).
  for (const mutant of live) {
    assert.ok(rendered.output.includes(JSON.stringify(mutant.id)),
      `Mutant ${mutant.mutatorName} (${mutant.original} -> ${mutant.replacement}) missing switch in rendered output`);
  }

  // Verify the instrumented code executes identically to the original when no mutant is active,
  // and that inner built-in mutants actually change behavior when activated.
  const runWith = activeMutant => {
    const ctx = vm.createContext({ __stryker__: activeMutant ? { activeMutant } : {} });
    return vm.runInContext(`${rendered.output}\ninspect([10, 20, 30], 'alpha', 5);`, ctx, { timeout: 2_000 });
  };
  assert.deepEqual([...runWith(undefined)], [30, 30, true, false, 5]);

  const arith = live.find(m => m.mutatorName === 'ArithmeticOperator' && m.original === 'arr.length - 1');
  assert.equal(runWith(arith.id)[0], undefined, 'arr[arr.length + 1] should be undefined');

  const unary = live.find(m => m.mutatorName === 'UnaryOperator' && m.original === '-1');
  assert.equal(runWith(unary.id)[1], 20, 'arr.at(+1) should be 20');

  const arrDecl = live.find(m => m.mutatorName === 'ArrayDeclaration' && m.original === "['alpha', 'beta']");
  assert.equal(runWith(arrDecl.id)[2], false, '[].includes("alpha") should be false');

  const innerMax = live.find(m => m.mutatorName === 'MethodExpression' && m.original === 'Math.max(val, 0)');
  assert.equal(runWith(innerMax.id)[4], 0, 'Math.min(Math.min(5, 0), 10) should be 0');
});

// --- Issue 2: Boolean(expr) recognized by onlyTruthUsed ---

test('Issue 2: PICT boolean-truth-context table contains all required seeds', () => {
  const { rows, seeds } = readPict('boolean-truth-context');
  const set = new Set(rows);
  for (const seed of seeds) assert.ok(set.has(seed), `Missing seed: ${seed}`);
});

test('Issue 2: PICT boolean-truth-context accurately classifies onlyTruthUsed for Boolean wrappers', () => {
  const { rows } = readPict('boolean-truth-context');
  const opMap = { Or: '||', And: '&&', Nullish: '??' };

  for (const line of rows) {
    const [wrapper, arity, shadowed, operator] = line.split('\t');
    const op = opMap[operator];
    const expr = `a ${op} b`;
    const extraArg = arity === 'Two' ? ', extra' : '';
    let wrapped;
    if (wrapper === 'BooleanCall') wrapped = `Boolean(${expr}${extraArg})`;
    else if (wrapper === 'ParenBooleanCall') wrapped = `(Boolean)(${expr}${extraArg})`;
    else if (wrapper === 'NewBoolean') wrapped = `new Boolean(${expr}${extraArg})`;
    else if (wrapper === 'OptionalBoolean') wrapped = `Boolean?.(${expr}${extraArg})`;
    else if (wrapper === 'NestedLogicalInBoolean') wrapped = `Boolean((${expr}) && c${extraArg})`;
    else wrapped = expr;

    let code;
    if (shadowed === 'Param') {
      code = `export function f(Boolean: any, a: any, b: any, c: any, extra: any) { return ${wrapped}; }\n`;
    } else if (shadowed === 'LocalConst') {
      code = `export function f(a: any, b: any, c: any, extra: any) { const Boolean = (x: any) => x; return ${wrapped}; }\n`;
    } else if (shadowed === 'Import') {
      code = `import { Boolean } from './custom';\nexport function f(a: any, b: any, c: any, extra: any) { return ${wrapped}; }\n`;
    } else {
      code = `export function f(a: any, b: any, c: any, extra: any) { return ${wrapped}; }\n`;
    }

    const mutations = collectMutations(code, 'sample.ts', { targeted: true });
    const ignoredMutant = mutations.find(m => m.name === 'ignored-operand/v1' && m.targeted?.operator === op && m.targeted?.form === 'right');
    assert.ok(ignoredMutant, `${line}: expected ignored-operand/v1 right mutant`);

    const expectedBoolean = shadowed === 'None' && arity === 'One' &&
      (wrapper === 'BooleanCall' || wrapper === 'ParenBooleanCall' || wrapper === 'NestedLogicalInBoolean');
    assert.equal(ignoredMutant.targeted.boolean, expectedBoolean, `${line}: expected boolean=${expectedBoolean}`);
  }

  // Special nesting edge: `Boolean((a || b) ?? c)` -> inner `a || b` is LHS of `??`, where truthiness alone is NOT enough.
  const nestedNullish = 'export const g = (a: any, b: any, c: any) => Boolean((a || b) ?? c);\n';
  const mNested = collectMutations(nestedNullish, 'nested.ts', { targeted: true });
  const innerOr = mNested.find(m => m.name === 'ignored-operand/v1' && m.targeted?.operator === '||' && m.targeted?.form === 'right');
  const outerNullish = mNested.find(m => m.name === 'ignored-operand/v1' && m.targeted?.operator === '??' && m.targeted?.form === 'right');
  assert.equal(innerOr.targeted.boolean, false);
  assert.equal(outerNullish.targeted.boolean, true);

  // Review regression checks: ImportEqualsDeclaration, Unicode-escaped binding, assignments (bare, destructuring, for-of), and type-only import.
  const reviewCases = [
    ['import Boolean = require("./id");\nexport const f = (a: any, b: any) => Boolean(a || b);\n', false],
    ['export function f(a: any, b: any) { const \\u0042oolean = (x: any) => x; return \\u0042oolean(a || b); }\n', false],
    ['export function f(a: any, b: any) { (globalThis as any); Boolean = ((x: any) => x) as any; return Boolean(a || b); }\n', false],
    ['export function f(a: any, b: any) { [Boolean] = [((x: any) => x) as any]; return Boolean(a || b); }\n', false],
    ['export function f(a: any, b: any, obj: any) { ({ Boolean } = obj); return Boolean(a || b); }\n', false],
    ['export function f(a: any, b: any, xs: any[]) { for (Boolean of xs) return Boolean(a || b); return false; }\n', false],
    ['export function f(a: any, b: any, obj: any) { let x; ({ Boolean: x } = obj); return [x, Boolean(a || b)]; }\n', true],
    ['import type { Boolean } from "./types";\nexport const f = (a: any, b: any) => Boolean(a || b);\n', true],
    ['import { type Boolean } from "./types";\nexport const f = (a: any, b: any) => Boolean(a || b);\n', true],
  ];
  for (const [src, expected] of reviewCases) {
    const ms = collectMutations(src, 'review.ts', { targeted: true });
    const right = ms.find(m => m.name === 'ignored-operand/v1' && m.targeted?.form === 'right');
    assert.ok(right, `Expected ignored-operand/v1 for: ${src}`);
    assert.equal(right.targeted.boolean, expected, `Unexpected boolean=${right.targeted.boolean} for: ${src}`);
  }

  // Review regression check: erased TS wrappers (`satisfies`, `as`, `<T>`) around called/deleted element access must not be probed.
  const wrappedEl = [
    'export function callAndDelete(arr: any[]) {',
    '  const a = (arr[0] satisfies Function)();',
    '  const b = (arr[0] as Function)();',
    '  const c = (<Function>arr[0])();',
    '  delete (arr[0] satisfies unknown);',
    '  delete (<unknown>arr[0]);',
    '  return [a, b, c];',
    '}',
  ].join('\n') + '\n';
  const elMutations = collectMutations(wrappedEl, 'wrapped.ts', { targeted: true });
  assert.equal(elMutations.filter(m => m.name === 'sequence-end/v1').length, 0);
});

test('Issue 2: Boolean(a || b) with undefined operands reports INPUT GAP rather than ASSERTION GAP', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-boolean-wrapper-'));
  try {
    const project = join(scratch, 'project');
    mkdirSync(project, { recursive: true });
    symlinkSync(repoNodeModules, join(scratch, 'node_modules'), 'junction');
    writeFileSync(join(project, 'store.ts'), [
      'export function hasKey(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {',
      '  return Boolean(a || b);',
      '}',
    ].join('\n') + '\n');
    writeFileSync(join(project, 'store.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { hasKey } from './store';",
      "it('returns false when both scopes are undefined', () => {",
      '  expect(hasKey(undefined, undefined)).toBe(false);',
      '});',
    ].join('\n') + '\n');

    const run = spawnSync(process.execPath, [
      cli, 'analyze', project, 'store.ts', '--format', 'json',
    ], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const report = JSON.parse(run.stdout);
    const rightGap = report.diagnostics.find(g => g.rule === 'ignored-operand/v1' && g.mutations?.[0]?.replacement?.includes('false'));
    assert.ok(rightGap, 'Expected ignored-operand/v1 gap for right operand');
    assert.equal(rightGap.kind, 'INPUT GAP');
    assert.match(rightGap.missing, /truthy/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- Issue 3: Large copy warning and --help mention --copy-exclude-gitignore / copyExcludeGitignore ---

test('Issue 3: large copy warning guides --copy-exclude-gitignore and copyExcludeGitignore alongside --copy-exclude', () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-large-copy-gitignore-hint-'));
  try {
    writeFileSync(join(project, 'a.bin'), Buffer.alloc(600));
    writeFileSync(join(project, 'b.bin'), Buffer.alloc(600));
    const warnings = [];
    withCopy(project, () => {}, {
      largeCopyBytes: 500,
      onLargeCopy: info => warnings.push(info),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /--copy-exclude-gitignore/);
    assert.match(warnings[0].message, /"copyExcludeGitignore": true/);
    assert.match(warnings[0].message, /--copy-exclude <PATH>/);
    assert.match(warnings[0].message, /"copyExclude"/);
    assert.match(warnings[0].message, /targeted-mutation\.config\.json/);
    assert.match(usage, /copyExcludeGitignore/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
