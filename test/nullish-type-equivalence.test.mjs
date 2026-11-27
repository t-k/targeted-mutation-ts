import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { targetedGap } from '../src/targeted-gaps.mjs';
import { createTypeContext } from '../src/type-equivalence.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const scenarios = readFileSync(new URL('../verification/pict/nullish-type-equivalence.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

const tsTypeOf = {
  StringNull: 'string | null',
  BooleanNull: 'boolean | null',
  BigIntNull: 'bigint | null',
  NumberNull: 'number | null',
  ObjectNull: '{ id: number } | null',
  StringUndefined: 'string | undefined',
  BooleanNullUndefined: 'boolean | null | undefined',
  AnyType: 'any',
  UnknownType: 'unknown',
  NonEmptyLiteralNull: "'a' | 'b' | null",
};

const rightExprOf = {
  EmptyString: '""',
  Zero: '0',
  ZeroN: '0n',
  FalseLit: 'false',
  NaNLit: 'NaN',
  NonFalsyLit: '"fallback"',
  NullOrUndefinedLit: 'null',
};

function expectedSuppressed(rule, leftType, rightSide, strict) {
  if (!strict) return false;
  if (leftType === 'AnyType' || leftType === 'UnknownType') return false;
  if (rule === 'EqualityStrictNull') {
    // differsFor = 'undefined': suppressed iff type cannot contain undefined
    return !['StringUndefined', 'BooleanNullUndefined'].includes(leftType);
  }
  if (rule === 'EqualityStrictUndefined') {
    // differsFor = 'null': suppressed iff type cannot contain null
    return leftType === 'StringUndefined';
  }
  if (rule === 'EqualityLooseNull') {
    // Emits two edits: 'strict' (differsFor='undefined') and 'other' (differsFor='null').
    // At least one is suppressed whenever either null or undefined is absent.
    return !['BooleanNullUndefined'].includes(leftType);
  }
  // FallbackNullish / FallbackOr
  if (leftType === 'ObjectNull' || leftType === 'NonEmptyLiteralNull') return true;
  if ((leftType === 'StringNull' || leftType === 'StringUndefined') && rightSide === 'EmptyString') return true;
  if ((leftType === 'BooleanNull' || leftType === 'BooleanNullUndefined') && rightSide === 'FalseLit') return true;
  if (leftType === 'BigIntNull' && rightSide === 'ZeroN') return true;
  // NumberNull can be NaN (NaN ?? 0 !== NaN || 0), so never suppressed.
  return false;
}

function buildExpression(rule, rightSide) {
  const rhs = rightExprOf[rightSide];
  switch (rule) {
    case 'FallbackNullish': return `x ?? ${rhs}`;
    case 'FallbackOr': return `x || ${rhs}`;
    case 'EqualityStrictNull': return 'x === null';
    case 'EqualityStrictUndefined': return 'x === undefined';
    case 'EqualityLooseNull': return 'x == null';
    default: throw new Error(`Unknown rule: ${rule}`);
  }
}

test('nullish-type-equivalence PICT matrix under strictNullChecks on and off', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-type-eqv-'));
  try {
    for (const strict of [true, false]) {
      const sub = resolve(dir, strict ? 'strict' : 'loose');
      mkdirSync(resolve(sub, 'src'), { recursive: true });
      writeFileSync(resolve(sub, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', strictNullChecks: strict, noEmit: true },
        include: ['src'],
      }));
      const filtered = scenarios.filter(([, , , mode]) => (mode === 'On') === strict);
      const lines = filtered.map(([rule, leftType, rightSide], idx) =>
        `export function fn${idx}(x: ${tsTypeOf[leftType]}) { return ${buildExpression(rule, rightSide)}; }`,
      );
      const file = 'src/cases.ts';
      const source = lines.join('\n') + '\n';
      writeFileSync(resolve(sub, file), source);

      const ctx = createTypeContext(sub, [file]);
      assert.equal(ctx.strictNullChecks, strict);
      const eqv = ctx.forFile(file);
      const mutations = collectMutations(source, file, { targeted: true, typeEquivalence: eqv });

      for (let idx = 0; idx < filtered.length; idx++) {
        const [rule, leftType, rightSide] = filtered[idx];
        const lineStart = source.indexOf(`export function fn${idx}(`);
        const lineEnd = source.indexOf('\n', lineStart);
        const lineMutations = mutations.filter(m => m.start >= lineStart && m.end <= lineEnd);
        const ruleName = rule.startsWith('Fallback') ? 'nullish-fallback/v1' : 'nullish-equality/v1';
        const matching = lineMutations.filter(m => m.name === ruleName);
        const suppressed = expectedSuppressed(rule, leftType, rightSide, strict);

        if (rule === 'EqualityLooseNull') {
          if (suppressed) {
            // Either strict or other (or both) is suppressed, so fewer than 2 nullish-equality/v1 edits.
            assert.ok(matching.length < 2, `Expected suppression for ${rule} ${leftType} strict=${strict}, got ${matching.length}`);
          } else {
            assert.equal(matching.length, 2, `Expected 2 edits for ${rule} ${leftType} strict=${strict}`);
          }
        } else if (suppressed) {
          assert.equal(matching.length, 0, `Expected ${ruleName} suppressed for ${rule} ${leftType} ${rightSide} strict=${strict}`);
        } else {
          assert.equal(matching.length, 1, `Expected ${ruleName} kept for ${rule} ${leftType} ${rightSide} strict=${strict}`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nullish-fallback/v1 advice excludes falsy right-side literal itself and keeps non-falsy intact', () => {
  const cases = [
    ['export const f = (x: unknown) => x ?? "";', "add a test in which `x` is 0, 0n, false or NaN"],
    ['export const f = (x: unknown) => x ?? 0;', "add a test in which `x` is 0n, '', false or NaN"],
    ['export const f = (x: unknown) => x ?? 0n;', "add a test in which `x` is 0, '', false or NaN"],
    ['export const f = (x: unknown) => x ?? false;', "add a test in which `x` is 0, 0n, '' or NaN"],
    ['export const f = (x: unknown) => x ?? NaN;', "add a test in which `x` is 0, 0n, '' or false"],
    ['export const f = (x: unknown) => x ?? 10;', "add a test in which `x` is 0, 0n, '', false or NaN and not the right side's value"],
  ];
  for (const [source, expectedAdvice] of cases) {
    const [m] = collectMutations(source, 'a.ts', { targeted: true }).filter(x => x.name === 'nullish-fallback/v1');
    assert.ok(m, `Expected nullish-fallback/v1 for ${source}`);
    const gap = targetedGap({
      id: 'm1', mutatorName: m.name, location: { file: 'a.ts', line: 1, column: 1 },
      original: source.slice(m.start, m.end), replacement: m.replacement, edit: [m.start, m.end],
      status: 'survived', targeted: m.targeted,
    }, { agreeing: 2, differing: [], unsure: [], outside: false, outsideUnsure: false });
    assert.equal(`add ${gap.missing}`, expectedAdvice);
  }
});

test('issue repro: --type-check skips equivalent nullish edits for strict TS state.filter fields', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-repro-nullish-'));
  try {
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['src'],
    }));
    writeFileSync(resolve(dir, 'src/bulk-selection.ts'), [
      'export interface FilterState { childId: string | null; hasArtTag: boolean | null; count: number | null; }',
      'export function toQuery(state: { filter: FilterState }) {',
      '  const childId = state.filter.childId ?? "";',
      '  const unsetArt = state.filter.hasArtTag === null;',
      '  const count = state.filter.count ?? 0;',
      '  return { childId, unsetArt, count };',
      '}',
    ].join('\n') + '\n');

    const withoutTc = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/bulk-selection.ts', '--list', '--no-type-check', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(withoutTc.status, 0, withoutTc.stderr);
    const plainMutants = JSON.parse(withoutTc.stdout).mutants;
    assert.equal(plainMutants.filter(m => m.rule === 'nullish-fallback/v1').length, 2);
    assert.equal(plainMutants.filter(m => m.rule === 'nullish-equality/v1').length, 1);

    const autoTc = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/bulk-selection.ts', '--list', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(autoTc.status, 0, autoTc.stderr);
    assert.equal(JSON.parse(autoTc.stdout).mutants.filter(m => m.rule === 'nullish-equality/v1').length, 0);

    const withTc = spawnSync(process.execPath, [cli, 'analyze', dir, 'src/bulk-selection.ts', '--list', '--type-check', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(withTc.status, 0, withTc.stderr);
    const checkedMutants = JSON.parse(withTc.stdout).mutants;
    // childId ?? "" and hasArtTag === null are suppressed; count ?? 0 (number | null can be NaN) is kept!
    assert.equal(checkedMutants.filter(m => m.rule === 'nullish-equality/v1').length, 0);
    const remainingFallback = checkedMutants.filter(m => m.rule === 'nullish-fallback/v1');
    assert.equal(remainingFallback.length, 1);
    assert.match(remainingFallback[0].original, /count \?\? 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('soundness: --type-check preserves non-equivalent mutants for indexed access, {}, void, and shadowed undefined', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-type-soundness-'));
  try {
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['src'],
    }));
    const source = [
      'enum NumEnum { One = 1 }',
      'export function idxAccess(xs: string[], i: number) { return xs[i] === null; }',
      'export function idxVar(xs: string[], i: number) { const v = xs[i]; return v === null; }',
      'export function recProp(rec: Record<string, string>) { return rec.missing === null; }',
      'export function numEnum(e: NumEnum) { return e ?? 2; }',
      'export function emptyObj(x: {}) { return x ?? 1; }',
      'export function voidReturn(fn: () => void) { return fn() ?? 1; }',
      'export function shadowedUndef(undefined: number, x: number | boolean) { return x === undefined; }',
      'export function realObj(x: { id: number } | null) { return x ?? { id: 0 }; }',
    ].join('\n') + '\n';
    writeFileSync(resolve(dir, 'src/sound.ts'), source);

    const ctx = createTypeContext(dir, ['src/sound.ts']);
    const eqv = ctx.forFile('src/sound.ts');
    const mutations = collectMutations(source, 'src/sound.ts', { targeted: true, typeEquivalence: eqv });

    const onLine = name => {
      const start = source.indexOf(`export function ${name}(`);
      const end = source.indexOf('\n', start);
      return mutations.filter(m => m.start >= start && m.end <= end);
    };
    // All unsound traps MUST remain un-suppressed:
    assert.equal(onLine('idxAccess').filter(m => m.name === 'nullish-equality/v1').length, 1, 'xs[i] === null without noUncheckedIndexedAccess');
    assert.equal(onLine('idxVar').filter(m => m.name === 'nullish-equality/v1').length, 1, 'const v = xs[i]; v === null');
    assert.equal(onLine('recProp').filter(m => m.name === 'nullish-equality/v1').length, 1, 'Record<string, string> dot property access');
    assert.equal(onLine('numEnum').filter(m => m.name === 'nullish-fallback/v1').length, 1, 'numeric enum can hold 0');
    assert.equal(onLine('emptyObj').filter(m => m.name === 'nullish-fallback/v1').length, 1, '{} can hold 0');
    assert.equal(onLine('voidReturn').filter(m => m.name === 'nullish-fallback/v1').length, 1, '() => void can return false');
    assert.equal(onLine('shadowedUndef').filter(m => m.name === 'nullish-equality/v1').length, 1, 'shadowed undefined parameter');
    // Genuine object with required non-prototype property IS suppressed:
    assert.equal(onLine('realObj').filter(m => m.name === 'nullish-fallback/v1').length, 0, '{ id: number } | null is never falsy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
