import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMutations } from '../src/builtin-mutations.mjs';
import { analyzeConventional } from '../src/conventional.mjs';
import { targetedGap } from '../src/targeted-gaps.mjs';
import { createTypeContext } from '../src/type-equivalence.mjs';
import { createCopy, withCopy } from '../src/vitest.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));

const falsyAdviceRows = readFileSync(new URL('../verification/pict/nullish-falsy-advice.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const copyReuseRows = readFileSync(new URL('../verification/pict/related-copy-reuse.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

// --- Issue 1: --related reuses its temporary workspace copy ---

test('Issue 1: createCopy claim() enforces single-consumer ownership and idempotent dispose()', () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-claim-src-'));
  try {
    writeFileSync(join(project, 'index.js'), 'export const x = 1;\n');
    const copy = createCopy(project);
    const firstTemp = copy.temp;
    assert.ok(existsSync(firstTemp));

    let seenFirst = null;
    withCopy(project, (_root, temp) => {
      seenFirst = temp;
      assert.equal(temp, firstTemp);
    }, { reuseCopy: copy });
    assert.equal(seenFirst, firstTemp);
    assert.equal(existsSync(firstTemp), false, 'Consumer must dispose claimed copy');

    // A second withCopy receiving the same handle must NOT reuse it; it creates a fresh copy.
    let seenSecond = null;
    withCopy(project, (_root, temp) => {
      seenSecond = temp;
      assert.notEqual(temp, firstTemp);
      assert.ok(existsSync(temp));
    }, { reuseCopy: copy });
    assert.ok(seenSecond && seenSecond !== firstTemp);
    assert.equal(existsSync(seenSecond), false);

    // Calling dispose() again is a safe no-op.
    copy.dispose();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Issue 1: CLI --related --progress copies the project once (reusing workspace for analysis)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-related-once-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'related-once', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    // Only a nullish-fallback edit (no comparison boundary), so only analyzeConventional runs.
    writeFileSync(join(dir, 'src/value.ts'), 'export function fallback(x: string | undefined) { return x ?? "default"; }\n');
    writeFileSync(join(dir, 'test/value.test.ts'), [
      "import { expect, test } from 'vitest';",
      "import { fallback } from '../src/value.ts';",
      "test('uses fallback for undefined', () => { expect(fallback(undefined)).toBe('default'); expect(fallback('ok')).toBe('ok'); });",
    ].join('\n') + '\n');

    const res = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/value.ts', '--related', '--progress', '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const copyLines = res.stderr.split('\n').filter(line => line.includes('Copying project to temporary workspace...'));
    assert.equal(copyLines.length, 1, `Expected exactly 1 project copy, got ${copyLines.length}:\n${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated');
    assert.deepEqual(report.selection.tests, ['test/value.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue 1 & 4: PICT related-copy-reuse matrix verifies single copy, no temp leak, and >20 related warning', async () => {
  for (const [relatedMode, consumerPath, selectedCount, signalInterrupt] of copyReuseRows) {
    if (signalInterrupt === 'Sigterm') {
      // Tested via dedicated child process signal test below to avoid flaky timing in matrix loop.
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), 'tmt-reuse-matrix-'));
    const childTmp = mkdtempSync(join(tmpdir(), 'tmt-reuse-tmp-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'test'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'reuse-matrix', type: 'module' }));
      symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');

      if (consumerPath === 'NoSites') {
        writeFileSync(join(dir, 'src/target.ts'), 'export const VERSION = "1.0.0";\n');
      } else {
        writeFileSync(join(dir, 'src/target.ts'), 'export function pick(x: string | undefined) { return x ?? "fallback"; }\n');
      }

      const testCount = selectedCount === 'Large' ? 21 : 1;
      for (let i = 0; i < testCount; i++) {
        writeFileSync(join(dir, `test/t${i}.test.ts`), [
          "import { expect, test } from 'vitest';",
          "import * as target from '../src/target.ts';",
          `test('case ${i}', () => { expect(target).toBeTruthy(); });`,
        ].join('\n') + '\n');
      }
      writeFileSync(join(dir, 'test/unrelated.test.ts'), "import { expect, test } from 'vitest';\ntest('u', () => { expect(1).toBe(1); });\n");

      const args = [cli, 'analyze', dir, 'src/target.ts', '--progress', '--format', 'json'];
      if (relatedMode === 'On') args.push('--related');
      if (consumerPath === 'Audit') args.push('--audit');
      if (consumerPath === 'DisjointTestError') args.push('--test', 'test/unrelated.test.ts');

      const res = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: childTmp, TEMP: childTmp, TMP: childTmp },
      });
      const leaked = readdirSync(childTmp).filter(name => name.startsWith('tmt-'));
      assert.equal(leaked.length, 0, `Leaked temp dirs for ${relatedMode}/${consumerPath}/${selectedCount}: ${leaked.join(', ')}`);

      if (relatedMode === 'On' && consumerPath === 'DisjointTestError') {
        assert.equal(res.status, 1);
        assert.match(res.stderr, /No Vitest test files matched both --related/);
        continue;
      }

      assert.equal(res.status, 0, `${relatedMode}/${consumerPath}/${selectedCount}: ${res.stderr}`);
      if (relatedMode === 'On' && selectedCount === 'Large') {
        assert.match(res.stderr, /Warning: --related selected 21 test files\. Consider narrowing with --test <glob>/);
        const warningIdx = res.stderr.indexOf('Warning: --related selected 21 test files.');
        const baselineIdx = res.stderr.indexOf('Running baseline tests...');
        if (baselineIdx !== -1) {
          assert.ok(warningIdx < baselineIdx, 'Warning must appear before baseline tests run');
        }
      } else if (relatedMode === 'On' && selectedCount === 'Small') {
        assert.doesNotMatch(res.stderr, /Warning: --related selected/);
      }

      if (relatedMode === 'On' && consumerPath === 'Conventional') {
        const copyCount = res.stderr.split('\n').filter(line => line.includes('Copying project to temporary workspace...')).length;
        assert.equal(copyCount, 1, `Expected 1 copy for ${relatedMode}/${consumerPath}/${selectedCount}, got ${copyCount}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(childTmp, { recursive: true, force: true });
    }
  }
});

test('Issue 1: SIGTERM during reused copy execution cleans up temporary directory', async () => {
  const project = mkdtempSync(join(tmpdir(), 'tmt-reuse-sig-'));
  try {
    writeFileSync(join(project, 'index.js'), 'export const x = 1;\n');
    const vitestModule = fileURLToPath(new URL('../src/vitest.mjs', import.meta.url));
    const script = `
      import { createCopy, withCopy } from ${JSON.stringify(vitestModule)};
      const copy = createCopy(${JSON.stringify(project)});
      try {
        await withCopy(${JSON.stringify(project)}, async (_root, temp) => {
          process.stdout.write('TEMP:' + temp + '\\n');
          await new Promise(resolveWait => setTimeout(resolveWait, 30_000));
        }, { reuseCopy: copy });
      } finally {
        copy.dispose();
      }
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
    assert.ok(tempPath && existsSync(tempPath));
    child.kill('SIGTERM');
    const code = await new Promise(resolveExit => child.once('exit', c => resolveExit(c)));
    assert.equal(code, 143);
    assert.equal(existsSync(tempPath), false, 'Reused copy temp dir must be removed on SIGTERM');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- Issue 2: Time-based progress updates during long-running mutant execution ---

test('Issue 2: analyzeConventional emits time-based progress updates during slow mutant runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-progress-timer-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'slow-progress', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'src/math.ts'), [
      'export function calc(a: number, b: number) {',
      '  const x = a + b;',
      '  const y = a - b;',
      '  const z = x * y;',
      '  return z;',
      '}',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'test/math.test.ts'), [
      "import { expect, test } from 'vitest';",
      "import { calc } from '../src/math.ts';",
      "test('slow check', async () => {",
      '  await new Promise(r => setTimeout(r, 250));',
      '  expect(calc(3, 2)).toBe(5);',
      '});',
    ].join('\n') + '\n');

    const messages = [];
    const result = await analyzeConventional(dir, ['src/math.ts'], {
      mutators: 'targeted',
      concurrency: 1,
      progressIntervalMs: 150,
      onProgress: message => messages.push(message),
    });
    assert.equal(result.evaluation, 'evaluated');
    const mutantProgress = messages.filter(m => m.startsWith('Mutants: '));
    assert.ok(mutantProgress.length >= 2, `Expected multiple time-based/incremental mutant progress updates, got:\n${messages.join('\n')}`);
    assert.ok(messages.some(m => /\(\d+s elapsed\)/.test(m)), `Expected elapsed-time heartbeat message, got:\n${messages.join('\n')}`);
    // Verify in-worker incremental count actually rises above 0 before final completion (0 < K < N).
    const counts = mutantProgress
      .map(m => /^Mutants: (\d+)\/(\d+) completed/.exec(m))
      .filter(Boolean)
      .map(([, done, total]) => [Number(done), Number(total)]);
    assert.ok(counts.some(([done, total]) => done > 0 && done < total),
      `Expected incremental in-worker mutant count (0 < done < total), got:\n${messages.join('\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Issue 3: Narrow nullish-fallback/v1 advice using TypeScript types under --type-check ---

const tsTypeMap = {
  NumberUndef: 'number | undefined',
  StringUndef: 'string | undefined',
  BoolUndef: 'boolean | undefined',
  BigIntUndef: 'bigint | undefined',
  StringNumberUndef: 'string | number | undefined',
  AnyOrUnknown: 'unknown',
};

const rhsExprMap = {
  Zero: '0',
  EmptyString: '""',
  FalseLit: 'false',
  ZeroN: '0n',
  NaNLit: 'NaN',
  NonFalsyPure: '"fallback"',
  ImpureCall: 'getDefault()',
};

const rightFalsyLabelMap = {
  Zero: '0',
  EmptyString: "''",
  FalseLit: 'false',
  ZeroN: '0n',
  NaNLit: 'NaN',
};

const possibleFalsyByType = {
  NumberUndef: ['0', 'NaN'],
  StringUndef: ["''"],
  BoolUndef: ['false'],
  BigIntUndef: ['0n'],
  StringNumberUndef: ['0', "''", 'NaN'],
  AnyOrUnknown: null,
};

function formatExpectedList(values) {
  return values.length === 1 ? values[0] : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

test('Issue 3: PICT nullish-falsy-advice matrix narrows falsy candidates accurately under --type-check', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-falsy-advice-'));
  try {
    for (const typeCheck of ['On', 'Off']) {
      const sub = resolve(dir, typeCheck);
      mkdirSync(resolve(sub, 'src'), { recursive: true });
      writeFileSync(resolve(sub, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
        include: ['src'],
      }));
      const rows = falsyAdviceRows.filter(([, , tc]) => tc === typeCheck);
      const lines = [
        'declare function getDefault(): any;',
        ...rows.map(([leftType, rightSide, , operator], idx) => {
          const op = operator === 'Nullish' ? '??' : '||';
          return `export function fn${idx}(x: ${tsTypeMap[leftType]}) { return x ${op} ${rhsExprMap[rightSide]}; }`;
        }),
      ];
      const file = 'src/cases.ts';
      const source = lines.join('\n') + '\n';
      writeFileSync(resolve(sub, file), source);

      const eqv = typeCheck === 'On' ? createTypeContext(sub, [file]).forFile(file) : null;
      const mutations = collectMutations(source, file, { targeted: true, typeEquivalence: eqv });

      for (let idx = 0; idx < rows.length; idx++) {
        const [leftType, rightSide, , operator] = rows[idx];
        const lineStart = source.indexOf(`export function fn${idx}(`);
        const lineEnd = source.indexOf('\n', lineStart);
        const matching = mutations.filter(m => m.name === 'nullish-fallback/v1' && m.start >= lineStart && m.end <= lineEnd);
        const rightFalsy = rightFalsyLabelMap[rightSide];
        const typedFalsy = typeCheck === 'On' ? possibleFalsyByType[leftType] : null;
        const suppressed = typedFalsy !== null && typedFalsy.length === 1 && typedFalsy[0] === rightFalsy;

        if (suppressed) {
          assert.equal(matching.length, 0, `Expected suppressed for ${leftType}/${rightSide}/${typeCheck}/${operator}`);
          continue;
        }
        assert.equal(matching.length, 1, `Expected 1 mutation for ${leftType}/${rightSide}/${typeCheck}/${operator}`);
        const [m] = matching;
        const gap = targetedGap({
          id: `m${idx}`,
          mutatorName: m.name,
          location: { file, line: idx + 2, column: 1 },
          original: source.slice(m.start, m.end),
          replacement: m.replacement,
          edit: [m.start, m.end],
          status: 'survived',
          targeted: m.targeted,
        }, { agreeing: 1, differing: [], unsure: [], outside: false, outsideUnsure: false });

        const allFalsy = ['0', '0n', "''", 'false', 'NaN'];
        const base = typedFalsy ?? allFalsy;
        const expectedValues = rightFalsy ? base.filter(v => v !== rightFalsy) : base;
        const suffix = !rightFalsy && rightSide === 'NonFalsyPure' ? " and not the right side's value" : '';
        const expected = `a test in which \`x\` is ${formatExpectedList(expectedValues)}${suffix}`;
        assert.equal(gap.missing, expected, `row=${leftType}/${rightSide}/${typeCheck}/${operator}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue 3: CLI --type-check narrows rowOffsets[mid] ?? 0 suggestion to NaN only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-falsy-cli-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'falsy-cli', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['src/**/*'],
    }));
    writeFileSync(join(dir, 'src/offsets.ts'), [
      'export function getOffset(rowOffsets: Array<number | undefined>, mid: number): number {',
      '  return rowOffsets[mid] ?? 0;',
      '}',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'test/offsets.test.ts'), [
      "import { expect, test } from 'vitest';",
      "import { getOffset } from '../src/offsets.ts';",
      "test('returns offset or 0', () => { expect(getOffset([10, undefined], 0)).toBe(10); expect(getOffset([10, undefined], 1)).toBe(0); });",
    ].join('\n') + '\n');

    const withTc = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/offsets.ts', '--type-check', '--format', 'text',
    ], { encoding: 'utf8' });
    assert.equal(withTc.status, 0, withTc.stderr);
    assert.match(withTc.stdout, /add a test in which `rowOffsets\[mid\]` is NaN\b/);
    assert.doesNotMatch(withTc.stdout, /0n, ''/);

    const autoTc = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/offsets.ts', '--format', 'text',
    ], { encoding: 'utf8' });
    assert.equal(autoTc.status, 0, autoTc.stderr);
    assert.match(autoTc.stdout, /add a test in which `rowOffsets\[mid\]` is NaN\b/);
    assert.doesNotMatch(autoTc.stdout, /0n, ''/);

    const withoutTc = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/offsets.ts', '--no-type-check', '--format', 'text',
    ], { encoding: 'utf8' });
    assert.equal(withoutTc.status, 0, withoutTc.stderr);
    assert.match(withoutTc.stdout, /add a test in which `rowOffsets\[mid\]` is 0n, '', false or NaN\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Review regression tests ---

test('Review fix: --related discards reused copy when Vitest config mutates workspace during discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-related-dirty-'));
  const childTmp = mkdtempSync(join(tmpdir(), 'tmt-related-dirty-tmp-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dirty-config', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'dir');
    // Config creates a marker file inside the workspace on first load; the test asserts it is absent before test run.
    writeFileSync(join(dir, 'vitest.config.mjs'), [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const marker = resolve(process.cwd(), '.config-loaded');",
      "if (existsSync(marker)) writeFileSync(resolve(process.cwd(), '.config-loaded-twice'), '1');",
      "else writeFileSync(marker, '1');",
      'export default {};',
    ].join('\n') + '\n');
    writeFileSync(join(dir, 'src/val.ts'), 'export function f(x: string | undefined) { return x ?? "d"; }\n');
    writeFileSync(join(dir, 'test/val.test.ts'), [
      "import { existsSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "import { expect, test } from 'vitest';",
      "import { f } from '../src/val.ts';",
      "test('clean workspace on baseline', () => {",
      "  expect(existsSync(resolve(process.cwd(), '.config-loaded-twice'))).toBe(false);",
      "  expect(f(undefined)).toBe('d');",
      "  expect(f('a')).toBe('a');",
      '});',
    ].join('\n') + '\n');

    const res = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/val.ts', '--related', '--progress', '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, TMPDIR: childTmp, TEMP: childTmp, TMP: childTmp } });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.evaluation, 'evaluated');
    const copyLines = res.stderr.split('\n').filter(line => line.includes('Copying project to temporary workspace...'));
    assert.equal(copyLines.length, 2, 'Dirty workspace must trigger a fresh clean copy for analysis');
    assert.equal(readdirSync(childTmp).filter(name => name.startsWith('tmt-')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(childTmp, { recursive: true, force: true });
  }
});

test('Review fix: literal 0 type omits NaN from advice, shadowed NaN is preserved, and beginUse blocks concurrent claim', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-falsy-edge-'));
  try {
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', noEmit: true },
      include: ['src/**/*'],
    }));
    const source = [
      'export function litZero(x: 0 | undefined) { return x ?? 1; }',
      'export function litZeroSelf(x: 0 | undefined) { return x ?? 0; }',
      'export function shadowedNaN(x: number | undefined, NaN = 0) { return x ?? NaN; }',
    ].join('\n') + '\n';
    const file = 'src/edge.ts';
    writeFileSync(resolve(dir, file), source);

    const eqv = createTypeContext(dir, [file]).forFile(file);
    const mutations = collectMutations(source, file, { targeted: true, typeEquivalence: eqv })
      .filter(m => m.name === 'nullish-fallback/v1');
    assert.equal(mutations.length, 3);

    const litZeroGap = targetedGap({
      id: 'm1', mutatorName: mutations[0].name, location: { file, line: 1, column: 1 },
      original: source.slice(mutations[0].start, mutations[0].end), replacement: mutations[0].replacement,
      edit: [mutations[0].start, mutations[0].end], status: 'survived', targeted: mutations[0].targeted,
    }, { agreeing: 1, differing: [], unsure: [], outside: false, outsideUnsure: false });
    assert.equal(litZeroGap.missing, "a test in which `x` is 0 and not the right side's value");

    const litZeroSelfGap = targetedGap({
      id: 'm1b', mutatorName: mutations[1].name, location: { file, line: 2, column: 1 },
      original: source.slice(mutations[1].start, mutations[1].end), replacement: mutations[1].replacement,
      edit: [mutations[1].start, mutations[1].end], status: 'survived', targeted: mutations[1].targeted,
    }, { agreeing: 1, differing: [], unsure: [], outside: false, outsideUnsure: false });
    assert.equal(litZeroSelfGap.missing, 'a test in which `x` is -0');

    const shadowedGap = targetedGap({
      id: 'm2', mutatorName: mutations[2].name, location: { file, line: 3, column: 1 },
      original: source.slice(mutations[2].start, mutations[2].end), replacement: mutations[2].replacement,
      edit: [mutations[2].start, mutations[2].end], status: 'survived', targeted: mutations[2].targeted,
    }, { agreeing: 1, differing: [], unsure: [], outside: false, outsideUnsure: false });
    assert.equal(shadowedGap.missing, 'a test in which `x` is 0 or NaN');

    // Verify beginUse() blocks concurrent claim() and second beginUse().
    const copy = createCopy(dir);
    try {
      assert.equal(copy.beginUse(), true);
      assert.equal(copy.beginUse(), false);
      assert.equal(copy.claim(), false);
      copy.endUse();
      assert.equal(copy.claim(), true);
    } finally {
      copy.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
