import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { renderText } from '../src/cli-output.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const pictRows = readFileSync(new URL('../verification/pict/short-circuit-equivalence.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function runVitestAnalysis(files, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-short-circuit-'));
  try {
    mkdirSync(join(dir, 'src/util'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sc-eqv', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'junction');
    for (const [relPath, content] of Object.entries(files)) {
      writeFileSync(join(dir, relPath), content);
    }
    const run = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/util/databaseId.ts', '--no-type-check', '--concurrency', '1', '--format', 'json', ...extraArgs,
    ], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, `STDERR:\n${run.stderr}\nSTDOUT:\n${run.stdout}`);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Issue 3 repro: `if (db == null || typeof db !== "object") return undefined;` emits 0 gaps when null/undefined/object are tested, and still catches missing null test', () => {
  const source = [
    'export function extractDatabaseId(db: unknown): string | undefined {',
    '  if (db == null || typeof db !== "object") return undefined;',
    '  return "database" in db ? (db as { database?: string }).database : "default";',
    '}',
  ].join('\n') + '\n';

  const fullReport = runVitestAnalysis({
    'src/util/databaseId.ts': source,
    'test/databaseId.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { extractDatabaseId } from '../src/util/databaseId.ts';",
      "it('returns undefined for null/undefined and primitives', () => {",
      '  expect(extractDatabaseId(null)).toBeUndefined();',
      '  expect(extractDatabaseId(undefined)).toBeUndefined();',
      '  expect(extractDatabaseId("not-an-obj")).toBeUndefined();',
      '});',
      "it('extracts database id from object', () => {",
      '  expect(extractDatabaseId({ database: "main" })).toBe("main");',
      '});',
    ].join('\n') + '\n',
  }, ['--lines', 'src/util/databaseId.ts:2']);

  assert.equal(fullReport.diagnostics.length, 0, `Expected 0 diagnostics, got:\n${renderText(fullReport)}`);
  assert.ok(fullReport.mutants.every(m => m.status === 'killed'), `Expected all mutants killed, got: ${JSON.stringify(fullReport.mutants)}`);

  // Removing the `null` test must still let `db === undefined` (`other`, differsFor: 'null') survive as INPUT GAP!
  const missingNullReport = runVitestAnalysis({
    'src/util/databaseId.ts': source,
    'test/databaseId.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { extractDatabaseId } from '../src/util/databaseId.ts';",
      "it('only tests undefined and object, forgetting null', () => {",
      '  expect(extractDatabaseId(undefined)).toBeUndefined();',
      '  expect(extractDatabaseId("str")).toBeUndefined();',
      '  expect(extractDatabaseId({ database: "main" })).toBe("main");',
      '});',
    ].join('\n') + '\n',
  }, ['--lines', 'src/util/databaseId.ts:2']);

  // Note: on `null`, `typeof null !== "object"` is false; without `db == null`, `(null).database` throws TypeError,
  // unless downstream handles it. Verify `db === undefined` WAS generated as a mutant candidate!
  assert.ok(
    missingNullReport.mutants.some(m => m.rule === 'nullish-equality/v1' && m.replacement === 'db === undefined'),
    'Must keep `db === undefined` (`other`) candidate so missing null handling is tested',
  );
});

test('Issue 3 static AST equivalence covers De Morgan typeof-object and explicit null/undefined pairs while preserving unsound cases', () => {
  const equivalentCases = [
    'export const f = (db: unknown) => db == null || typeof db !== "object";\n',
    'export const f = (db: unknown) => db === null || typeof db !== "object";\n',
    'export const f = (db: unknown) => typeof db !== "object" || db == null;\n',
    'export const f = (db: unknown) => typeof db !== "object" || db === null;\n',
    'export const f = (db: unknown) => db != null && typeof db === "object";\n',
    'export const f = (db: unknown) => typeof db === "object" && db != null;\n',
    'export const f = (db: unknown) => db === null || db === undefined;\n',
    'export const f = (db: unknown) => db !== null && db !== undefined;\n',
  ];
  for (const src of equivalentCases) {
    const nullishMutants = collectMutations(src, 'a.ts', { targeted: true }).filter(m => m.name === 'nullish-equality/v1');
    const eqvUndefined = nullishMutants.filter(m => m.targeted.differsFor === 'undefined' || m.targeted.form === 'loose');
    assert.equal(eqvUndefined.length, 0, `Expected differsFor=undefined/loose suppressed for: ${src.trim()}, got ${JSON.stringify(eqvUndefined)}`);
  }

  // `typeof db === "object" && db != null` MUST still emit `db !== undefined` (`differsFor: 'null'`)!
  const looseAnd = collectMutations('export const f = (db: unknown) => typeof db === "object" && db != null;\n', 'a.ts', { targeted: true })
    .filter(m => m.name === 'nullish-equality/v1');
  assert.equal(looseAnd.length, 1);
  assert.equal(looseAnd[0].replacement, 'db !== undefined');

  // Unsound cases that MUST NOT be suppressed statically:
  const unsoundCases = [
    // Property access (getter may return undefined first, then object second!)
    'export const f = (o: { db: unknown }) => o.db == null || typeof o.db !== "object";\n',
    // Impure call between guard terms (`db == null || touch() || typeof db !== "object"`)
    'let c = 0; const touch = () => (c++, false); export const f = (db: unknown) => db == null || touch() || typeof db !== "object";\n',
    // Shadowed local `undefined`
    'export function f(db: unknown, undefined: unknown) { return db == null || typeof db !== "object"; }\n',
    // Non-boolean value context on && where right side isn't boolean (`db != null && typeof db === "object"` IS boolean,
    // whereas `db == null || getFallback()` is not typeof check anyway)
    'export const f = (db: unknown) => db == null || db === "";\n',
  ];
  for (const src of unsoundCases) {
    const nullishMutants = collectMutations(src, 'a.ts', { targeted: true }).filter(m => m.name === 'nullish-equality/v1');
    assert.ok(
      nullishMutants.some(m => m.targeted.form === 'strict' || m.targeted.form === 'loose'),
      `Must preserve strict/loose nullish-equality mutant for unsound case: ${src.trim()}`,
    );
  }
});

test('Issue 3: PICT matrix for pure short-circuit absorption vs side-effect preservation', () => {
  // Batch scenarios into a single Vitest fixture project so all 25 PICT rows execute in one fast Vitest session!
  const subjectLines = ['export let sideEffects = 0;', 'export const bump = () => { sideEffects++; return true; };'];
  const testLines = [
    "import { expect, it } from 'vitest';",
    "import * as mod from '../src/util/databaseId.ts';",
  ];

  pictRows.forEach(([pattern, testInput, context], idx) => {
    const fn = `case_${idx}`;
    const wrap = expr => context === 'IfCondition'
      ? `{ if (${expr}) return 'hit'; return 'miss'; }`
      : `{ return ${expr}; }`;

    if (pattern === 'LooseNullOrTypeofNotObj') {
      subjectLines.push(`export function ${fn}(x: unknown) ${wrap('x == null || typeof x !== "object"')}`);
    } else if (pattern === 'TypeofNotObjOrStrictNull') {
      subjectLines.push(`export function ${fn}(x: unknown) ${wrap('typeof x !== "object" || x === null')}`);
    } else if (pattern === 'LooseNotNullAndTypeofObj') {
      subjectLines.push(`export function ${fn}(x: unknown) ${wrap('x != null && typeof x === "object"')}`);
    } else if (pattern === 'ExplicitNullOrUndefined') {
      subjectLines.push(`export function ${fn}(x: unknown) ${wrap('x === null || x === undefined')}`);
    } else if (pattern === 'TwoVarPureOr') {
      subjectLines.push(`export function ${fn}(a: number, b: number) ${wrap('a === 0 || b === 0')}`);
    } else if (pattern === 'TwoVarPureAnd') {
      subjectLines.push(`export function ${fn}(a: number, b: number) ${wrap('a !== 0 && b !== 0')}`);
    } else if (pattern === 'ImpureCallOr') {
      subjectLines.push(`export function ${fn}(a: number) ${wrap('a === 0 || bump()')}`);
    } else if (pattern === 'GetterPropOr') {
      subjectLines.push(`export function ${fn}(a: number, box: { flag: boolean }) ${wrap('a === 0 || box.flag')}`);
    } else if (pattern === 'ShadowedUndefinedOr') {
      subjectLines.push(`export function ${fn}(x: unknown, shadowed: unknown) { const undefined = shadowed; ${context === 'IfCondition' ? 'if (x == null || typeof x !== "object") return \'hit\'; return \'miss\';' : 'return x == null || typeof x !== "object";'} }`);
    }

    const expectedHit = context === 'IfCondition' ? "'hit'" : 'true';
    const expectedMiss = context === 'IfCondition' ? "'miss'" : 'false';

    if (['LooseNullOrTypeofNotObj', 'TypeofNotObjOrStrictNull'].includes(pattern)) {
      if (testInput === 'DistinguishingAbsorbed') {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(null)).toBe(${expectedHit}); expect(mod.${fn}(undefined)).toBe(${expectedHit}); expect(mod.${fn}("s")).toBe(${expectedHit}); expect(mod.${fn}({ a: 1 })).toBe(${expectedMiss}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}({ a: 1 })).toBe(${expectedMiss}); });`);
      }
    } else if (pattern === 'ExplicitNullOrUndefined') {
      if (testInput === 'DistinguishingAbsorbed') {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(null)).toBe(${expectedHit}); expect(mod.${fn}(undefined)).toBe(${expectedHit}); expect(mod.${fn}("s")).toBe(${expectedMiss}); expect(mod.${fn}({ a: 1 })).toBe(${expectedMiss}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}({ a: 1 })).toBe(${expectedMiss}); });`);
      }
    } else if (pattern === 'LooseNotNullAndTypeofObj') {
      if (testInput === 'DistinguishingAbsorbed') {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(null)).toBe(${expectedMiss}); expect(mod.${fn}(undefined)).toBe(${expectedMiss}); expect(mod.${fn}("s")).toBe(${expectedMiss}); expect(mod.${fn}({ a: 1 })).toBe(${expectedHit}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}({ a: 1 })).toBe(${expectedHit}); });`);
      }
    } else if (pattern === 'TwoVarPureOr') {
      if (testInput === 'DistinguishingAbsorbed') {
        // Passes (0, 0) where `a === 0` differs under `(a, 0, false)` but `a === 0 || b === 0` stays true!
        // Also keeps right-side `b === 0` covered via (1, 0) so we specifically inspect left-side `(a, 0, false)`.
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(0, 0)).toBe(${expectedHit}); expect(mod.${fn}(1, 2)).toBe(${expectedMiss}); });`);
      } else if (testInput === 'DistinguishingUnabsorbed') {
        // Calls (0, 1) WITHOUT asserting return value -> genuine ASSERTION GAP!
        testLines.push(`it('${fn}', () => { mod.${fn}(0, 1); expect(mod.${fn}(1, 2)).toBe(${expectedMiss}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(1, 2)).toBe(${expectedMiss}); });`);
      }
    } else if (pattern === 'TwoVarPureAnd') {
      if (testInput === 'DistinguishingAbsorbed') {
        // Passes (0, 0) where `a !== 0` (`false`) differs under `(a, 0, true)` (`true`) but `b !== 0` is `false`!
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(0, 0)).toBe(${expectedMiss}); expect(mod.${fn}(1, 2)).toBe(${expectedHit}); });`);
      } else if (testInput === 'DistinguishingUnabsorbed') {
        testLines.push(`it('${fn}', () => { mod.${fn}(0, 2); expect(mod.${fn}(1, 2)).toBe(${expectedHit}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(1, 2)).toBe(${expectedHit}); });`);
      }
    } else if (pattern === 'ImpureCallOr') {
      if (testInput === 'DistinguishingAbsorbed') {
        // Return value is asserted ('hit'/true), but `bump()` side effect is NOT asserted! Must stay ASSERTION GAP!
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(0)).toBe(${expectedHit}); });`);
      } else if (testInput === 'DistinguishingUnabsorbed') {
        testLines.push(`it('${fn}', () => { mod.${fn}(0); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(1)).toBe(${expectedHit}); });`);
      }
    } else if (pattern === 'GetterPropOr') {
      if (testInput === 'DistinguishingAbsorbed') {
        testLines.push(`it('${fn}', () => { let reads = 0; const box = { get flag() { reads++; return true; } }; expect(mod.${fn}(0, box)).toBe(${expectedHit}); });`);
      } else if (testInput === 'DistinguishingUnabsorbed') {
        testLines.push(`it('${fn}', () => { mod.${fn}(0, { flag: false }); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(1, { flag: false })).toBe(${expectedMiss}); });`);
      }
    } else if (pattern === 'ShadowedUndefinedOr') {
      if (testInput === 'DistinguishingUnabsorbed') {
        // Passing real JS `undefined` as `x` and `123` as shadowed `undefined`, without asserting!
        testLines.push(`it('${fn}', () => { mod.${fn}(void 0, 123); expect(mod.${fn}({ a: 1 }, 123)).toBe(${expectedMiss}); });`);
      } else {
        testLines.push(`it('${fn}', () => { expect(mod.${fn}(void 0, 123)).toBe(${expectedHit}); expect(mod.${fn}(null, 123)).toBe(${expectedHit}); expect(mod.${fn}({ a: 1 }, 123)).toBe(${expectedMiss}); });`);
      }
    }
  });

  const report = runVitestAnalysis({
    'src/util/databaseId.ts': subjectLines.join('\n') + '\n',
    'test/databaseId.test.ts': testLines.join('\n') + '\n',
  });

  pictRows.forEach(([pattern, testInput, context], idx) => {
    const lineNo = idx + 3; // lines 1-2 are sideEffects/bump
    const label = `row ${idx} (${pattern}/${testInput}/${context} at line ${lineNo})`;
    const lineGaps = report.diagnostics.filter(d => d.location?.line === lineNo);
    const lineMutants = report.mutants.filter(m => m.location?.line === lineNo);

    if (['LooseNullOrTypeofNotObj', 'TypeofNotObjOrStrictNull', 'LooseNotNullAndTypeofObj', 'ExplicitNullOrUndefined'].includes(pattern)) {
      if (testInput === 'DistinguishingAbsorbed') {
        assert.equal(lineGaps.filter(g => g.kind === 'ASSERTION GAP').length, 0, `${label}: expected 0 ASSERTION GAPs, got ${JSON.stringify(lineGaps)}`);
        assert.equal(lineGaps.filter(g => g.rule === 'nullish-equality/v1').length, 0, `${label}: expected 0 nullish-equality gaps`);
      }
    } else if (pattern === 'TwoVarPureOr') {
      const leftFalseGap = lineGaps.find(g => g.mutations?.[0]?.replacement === '(a, 0, false)');
      if (testInput === 'DistinguishingAbsorbed') {
        assert.ok(leftFalseGap, `${label}: expected survivor diagnostic for (a, 0, false)`);
        assert.equal(leftFalseGap.kind, 'INPUT GAP', `${label}: pure short-circuit absorption must be INPUT GAP, not ASSERTION GAP`);
        // Right-side `b === 0` was never reached when only (0, 0) was hit on left=true? Wait: (1, 2) reaches `b === 0`!
      } else if (testInput === 'DistinguishingUnabsorbed') {
        assert.ok(leftFalseGap, `${label}: expected survivor diagnostic for (a, 0, false)`);
        assert.equal(leftFalseGap.kind, 'ASSERTION GAP', `${label}: unabsorbed differing test must remain ASSERTION GAP`);
      }
    } else if (pattern === 'TwoVarPureAnd') {
      const leftTrueGap = lineGaps.find(g => g.mutations?.[0]?.replacement === '(a, 0, true)');
      if (testInput === 'DistinguishingAbsorbed') {
        assert.ok(leftTrueGap, `${label}: expected survivor diagnostic for (a, 0, true)`);
        assert.equal(leftTrueGap.kind, 'INPUT GAP', `${label}: pure && absorption must be INPUT GAP, not ASSERTION GAP`);
      } else if (testInput === 'DistinguishingUnabsorbed') {
        assert.ok(leftTrueGap, `${label}: expected survivor diagnostic for (a, 0, true)`);
        assert.equal(leftTrueGap.kind, 'ASSERTION GAP', `${label}: unabsorbed && differing test must remain ASSERTION GAP`);
      }
    } else if (pattern === 'ImpureCallOr' || pattern === 'GetterPropOr') {
      if (testInput === 'DistinguishingAbsorbed') {
        const leftFalseGap = lineGaps.find(g => g.mutations?.[0]?.replacement === '(a, 0, false)');
        assert.ok(leftFalseGap, `${label}: impure right side must still survive when side effect is unasserted`);
        assert.equal(leftFalseGap.kind, 'ASSERTION GAP', `${label}: impure right side MUST preserve ASSERTION GAP!`);
      }
    } else if (pattern === 'ShadowedUndefinedOr') {
      assert.ok(
        lineMutants.some(m => m.rule === 'nullish-equality/v1' && m.replacement === 'x === null'),
        `${label}: shadowed undefined must NOT statically suppress x === null`,
      );
    }
  });
});

test('Issue 3: pure guard evaluation never pollutes baseline mutantCoverage of unreached right-hand operands', () => {
  const report = runVitestAnalysis({
    'src/util/databaseId.ts': 'export function alwaysLeft(a: number, b: number) { return a === 0 || b === 0; }\n',
    'test/databaseId.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { alwaysLeft } from '../src/util/databaseId.ts';",
      "it('always short-circuits on a === 0', () => { expect(alwaysLeft(0, 0)).toBe(true); });",
    ].join('\n') + '\n',
  });
  const rightMutants = report.mutants.filter(m => m.original === 'b === 0');
  assert.ok(rightMutants.length >= 2);
  assert.ok(
    rightMutants.every(m => m.status === 'unreached'),
    `Right-hand operand mutants must remain unreached when baseline short-circuits, got: ${JSON.stringify(rightMutants)}`,
  );
  const leftFalseGap = report.diagnostics.find(d => d.mutations?.[0]?.replacement === '(a, 0, false)');
  assert.equal(leftFalseGap?.kind, 'INPUT GAP');
  assert.match(leftFalseGap.missing, /and decides `a === 0 \|\| b === 0`/);
});

test('Issue 3: non-nullish loose equality with object valueOf side effect preserves ASSERTION GAP', () => {
  const report = runVitestAnalysis({
    'src/util/databaseId.ts': 'export function looseObj(a: unknown, b: number) { return a == 1 || b === 0; }\n',
    'test/databaseId.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { looseObj } from '../src/util/databaseId.ts';",
      "it('coerces object via valueOf without asserting side effect count', () => {",
      '  let calls = 0;',
      '  const tricky = { valueOf() { calls++; return 1; } };',
      '  expect(looseObj(tricky, 0)).toBe(true);',
      '});',
    ].join('\n') + '\n',
  });
  const leftFalseGap = report.diagnostics.find(d => d.mutations?.[0]?.replacement === '(a, 1, false)');
  assert.ok(leftFalseGap);
  assert.equal(leftFalseGap.kind, 'ASSERTION GAP', 'Object ToPrimitive coercion side effect must not be absorbed');
});

test('Issue 3 review regressions: intervening reassignment, undeclared identifiers, global getters, named class undefined, left-side mutation, nested hit counts, and patched Math', async () => {
  const { renderBuiltinSwitches } = await import('../src/builtin-switches.mjs');

  // 1. Intervening reassignment between preceding guard and nullish check MUST NOT be statically suppressed,
  //    and named class expression `class undefined` MUST NOT be statically suppressed.
  const trickyStatic = [
    'export const reassignAnd = (x: unknown) => typeof x === "object" && ((x = undefined), true) && x != null;\n',
    'export const reassignOr = (x: unknown) => typeof x !== "object" || ((x = undefined), false) || x == null;\n',
    'export const undeclaredMid = (x: unknown) => x == null || (missingGlobal === 0) || typeof x !== "object";\n',
    'export const namedClassUndef = (v: unknown) => { const C = class undefined { static f(x: unknown) { return x === null || x === undefined; } }; return C.f(v); };\n',
  ];
  for (const src of trickyStatic) {
    const nullish = collectMutations(src, 'a.ts', { targeted: true }).filter(m => m.name === 'nullish-equality/v1');
    assert.ok(
      nullish.some(m => m.targeted.form === 'strict' || m.targeted.form === 'loose'),
      `Must keep strict/loose nullish mutant for: ${src.trim()}, got ${JSON.stringify(nullish)}`,
    );
  }

  // 2. In-memory baseline probe check:
  //    - `(x === 0 || missingGlobal === 0) && true` at `x = 0` must NOT throw ReferenceError during baseline!
  //    - `a === 0 || globalGetter` at `a = 0` must call globalGetter 0 times during baseline!
  //    - `(a === 0 || b === 0) && true` at `(1, 0)` must record `b === 0` coverage & observed count = 1 (never 2)!
  const probeSrc = [
    'function shortUndeclared(x) { return (x === 0 || missingGlobal === 0) && true; }',
    'function shortGlobalGetter(a) { return a === 0 || globalGetterFlag; }',
    'function nestedOnce(a, b) { return (a === 0 || b === 0) && true; }',
    'return { shortUndeclared, shortGlobalGetter, nestedOnce };',
  ].join('\n');
  const rendered = renderBuiltinSwitches(Buffer.from(probeSrc), 'probe.mjs', () => true, { targeted: true });
  const prevStryker = globalThis.__stryker__;
  const sessionSym = Symbol.for('targeted-mutation-ts/session');
  const prevSession = globalThis[sessionSym];
  let getterHits = 0;
  Object.defineProperty(globalThis, 'globalGetterFlag', {
    configurable: true,
    get() { getterHits++; return true; },
  });
  try {
    globalThis.__stryker__ = { currentTestId: 't1' };
    globalThis[sessionSym] = { phase: 'baseline' };
    const fns = new Function(rendered.output)();
    assert.equal(fns.shortUndeclared(0), true);
    assert.equal(fns.shortGlobalGetter(0), true);
    assert.equal(getterHits, 0, 'Short-circuited global getter must not run during baseline');
    assert.equal(fns.nestedOnce(1, 0), true);

    const bMutant = rendered.mutants.find(m => m.original === 'b === 0' && m.replacement === '(b, 0, false)');
    assert.ok(bMutant);
    assert.equal(globalThis.__stryker__.mutantCoverage.perTest.t1[bMutant.id], 1, 'Nested RHS coverage must be counted exactly once');
    const counts = globalThis.__stryker__.observed[bMutant.id].tests.t1;
    assert.equal(counts[0] + counts[1] + counts[2], 1, 'Nested RHS observation must be recorded exactly once');

    const globalGetterLeft = rendered.mutants.find(m => m.original === 'a === 0' && m.location.line === 2 && m.replacement === '(a, 0, false)');
    assert.equal(globalThis.__stryker__.observed[globalGetterLeft.id].tests.t1[1], 1, 'Global getter on RHS must keep leaf differ');
  } finally {
    delete globalThis.globalGetterFlag;
    globalThis.__stryker__ = prevStryker;
    globalThis[sessionSym] = prevSession;
  }

  // 3. Vitest E2E check for left-variable mutation (`let gate = true; return gate && ((gate = false, a) === 0)`)
  //    and patched `Math.ceil` side effect (`if (Math.floor(n) || true) return true`): both must remain ASSERTION GAP!
  const report = runVitestAnalysis({
    'src/util/databaseId.ts': [
      'export function mutatesLeftGate(a: number) { let gate = true; return gate && ((gate = false, a) === 0); }',
      'export function floorInOr(n: number) { if (Math.floor(n) || true) return true; return false; }',
    ].join('\n') + '\n',
    'test/databaseId.test.ts': [
      "import { expect, it } from 'vitest';",
      "import { floorInOr, mutatesLeftGate } from '../src/util/databaseId.ts';",
      "it('calls mutatesLeftGate without pinning result', () => { mutatesLeftGate(0); });",
      "it('calls floorInOr with patched Math.ceil without asserting spy count', () => {",
      '  const origCeil = Math.ceil;',
      '  let ceilCalls = 0;',
      '  Math.ceil = (x: number) => { ceilCalls++; return origCeil(x); };',
      '  try { expect(floorInOr(0.2)).toBe(true); } finally { Math.ceil = origCeil; }',
      '});',
    ].join('\n') + '\n',
  });

  const gateGap = report.diagnostics.find(d => d.location?.line === 1 && d.mutations?.[0]?.replacement?.endsWith(', false)'));
  assert.equal(gateGap?.kind, 'ASSERTION GAP', 'Mutated left gate variable must remain ASSERTION GAP');

  const ceilGap = report.diagnostics.find(d => d.location?.line === 2 && d.mutations?.[0]?.replacement === 'Math.ceil(n)');
  assert.equal(ceilGap?.kind, 'ASSERTION GAP', 'Patched Math.ceil side effect must remain ASSERTION GAP');

  // 4. Round 2 regressions:
  //    - Unbound global `db` getter (`() => db == null || typeof db !== "object"`) MUST keep `db === null` candidate!
  //    - Object method name (`({ flag(a) { return a === 0 || flag; } })`) MUST NOT treat `flag` as lexically bound!
  //    - Monkey-patched `globalThis.Boolean = x => x` on `Boolean(a === 0 && b)` at `(0, 0)` MUST NOT mark absorbed!
  const globalSubjectMutants = collectMutations('export const f = () => globalDb == null || typeof globalDb !== "object";\n', 'a.ts', { targeted: true })
    .filter(m => m.name === 'nullish-equality/v1');
  assert.ok(
    globalSubjectMutants.some(m => m.replacement === 'globalDb === null'),
    `Unbound global subject must preserve globalDb === null, got ${JSON.stringify(globalSubjectMutants)}`,
  );

  const r2Src = [
    'const obj = { flag(a) { return a === 0 || flag; } };',
    'function boolCall(a, b) { return Boolean(a === 0 && b); }',
    'return { obj, boolCall };',
  ].join('\n');
  const r2Rendered = renderBuiltinSwitches(Buffer.from(r2Src), 'r2.mjs', () => true, { targeted: true });
  const origBool = globalThis.Boolean;
  let methodGetterHits = 0;
  Object.defineProperty(globalThis, 'flag', {
    configurable: true,
    get() { methodGetterHits++; return true; },
  });
  try {
    globalThis.__stryker__ = { currentTestId: 't2' };
    globalThis[sessionSym] = { phase: 'baseline' };
    globalThis.Boolean = x => x;
    const r2Fns = new Function(r2Rendered.output)();
    assert.equal(r2Fns.obj.flag(0), true);
    assert.equal(methodGetterHits, 0, 'Object method name must not treat global `flag` getter as local');
    assert.equal(r2Fns.boolCall(0, 0), 0);

    const methodLeftFalse = r2Rendered.mutants.find(m => m.original === 'a === 0' && m.location.line === 1 && m.replacement === '(a, 0, false)');
    assert.equal(globalThis.__stryker__.observed[methodLeftFalse.id].tests.t2[1], 1, 'Method global getter must record differ');

    const boolLeftFalse = r2Rendered.mutants.find(m => m.original === 'a === 0' && m.location.line === 2 && m.replacement === '(a, 0, false)');
    assert.equal(globalThis.__stryker__.observed[boolLeftFalse.id].tests.t2[1], 1, 'Monkey-patched Boolean(x => x) returning 0 vs false must record differ');
    assert.equal(globalThis.__stryker__.observed[boolLeftFalse.id].absorbed, undefined);
  } finally {
    delete globalThis.flag;
    globalThis.Boolean = origBool;
    globalThis.__stryker__ = prevStryker;
    globalThis[sessionSym] = prevSession;
  }
});
