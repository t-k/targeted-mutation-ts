import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderText } from '../src/cli-output.mjs';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const multilineRows = readFileSync(new URL('../verification/pict/multiline-edit-display.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function makeExpressions(ruleShape, lineCount) {
  if (ruleShape === 'SingleLineShort') {
    return {
      rule: 'nullish-fallback/v1',
      original: 'count ?? 10',
      replacement: '(count || 10)',
      mustIncludeOrig: 'count ?? 10',
      mustIncludeRepl: '(count || 10)',
    };
  }
  if (ruleShape === 'SwitchEmptyCase') {
    const body = lineCount === 'FourLinesLong'
      ? 'case "VERY_LONG_ACTION_IDENTIFIER_NAME_FOR_SWITCH_CLAUSE":\n  prepare();\n  commit();\n  return true;'
      : "case 38:\n  return '&amp;';";
    const repl = lineCount === 'FourLinesLong'
      ? 'case "VERY_LONG_ACTION_IDENTIFIER_NAME_FOR_SWITCH_CLAUSE":'
      : 'case 38:';
    return {
      rule: 'ConditionalExpression',
      original: body,
      replacement: repl,
      mustIncludeOrig: 'case',
      mustIncludeRepl: '(empty)',
    };
  }
  if (ruleShape === 'ArrowStub') {
    const body = lineCount === 'FourLinesLong'
      ? '(item, index) => {\n  const next = item + index;\n  validate(next);\n  return next;\n}'
      : '(a) =>\n a';
    return {
      rule: 'ArrowFunction',
      original: body,
      replacement: '() => undefined',
      mustIncludeOrig: '=>',
      mustIncludeRepl: '() => undefined',
    };
  }

  const sep = lineCount === 'SingleLine' ? ' ' : '\n  ';
  if (ruleShape === 'IgnoredRight') {
    const prefix = lineCount === 'FourLinesLong'
      ? `value != null &&${sep}typeof value === "object" &&${sep}"app" in value`
      : 'value != null';
    const leaf = lineCount === 'TwoLinesShort' ? 'typeof value === "object"' : '"database" in value';
    return {
      rule: 'ignored-operand/v1',
      original: `${prefix} &&${sep}${leaf}`,
      replacement: `(${prefix} && (${leaf}, true))`,
      mustIncludeOrig: leaf,
      mustIncludeRepl: `(${leaf}, true)`,
    };
  }
  if (ruleShape === 'IgnoredLeft') {
    const prefix = lineCount === 'FourLinesLong'
      ? `value != null &&${sep}typeof value === "object" &&${sep}"app" in value`
      : 'value != null';
    const leaf = lineCount === 'TwoLinesShort' ? 'typeof value === "object"' : '"database" in value';
    return {
      rule: 'ignored-operand/v1',
      original: `${prefix} &&${sep}${leaf}`,
      replacement: `(${prefix}, ${leaf})`,
      mustIncludeOrig: `&& ${leaf}`,
      mustIncludeRepl: `, ${leaf}`,
    };
  }
  if (ruleShape === 'NullishFallback') {
    const prefix = lineCount === 'FourLinesLong'
      ? `primaryConfig.endpoint ??${sep}secondaryConfig.endpoint ??${sep}regionalFallback.endpoint`
      : 'primaryEndpoint';
    const leaf = '"default-db"';
    return {
      rule: 'nullish-fallback/v1',
      original: `${prefix} ??${sep}${leaf}`,
      replacement: `((${prefix}) || ${leaf})`,
      mustIncludeOrig: `?? ${leaf}`,
      mustIncludeRepl: `|| ${leaf}`,
    };
  }
  if (ruleShape === 'EqualityConstant') {
    const lhs = lineCount === 'FourLinesLong'
      ? `resolveActiveProjectIdentifier(context, options)${sep}`
      : 'actualProject';
    const rhs = lineCount === 'FourLinesLong'
      ? `resolveExpectedProjectIdentifier(${sep}manifest,${sep}environment)`
      : 'expectedProject';
    return {
      rule: 'equality-constant/v1',
      original: `${lhs.trimEnd()} ===${sep}${rhs}`,
      replacement: `(${lhs.trimEnd()}, ${rhs}, true)`,
      mustIncludeOrig: '===',
      mustIncludeRepl: ', true)',
    };
  }
  // LogicalSwap
  const prefix = lineCount === 'FourLinesLong'
    ? `value != null &&${sep}typeof value === "object" &&${sep}"app" in value`
    : 'isReady';
  const leaf = '"database" in value';
  return {
    rule: 'LogicalOperator',
    original: `${prefix} &&${sep}${leaf}`,
    replacement: `(${prefix}) || ${leaf}`,
    mustIncludeOrig: `&& ${leaf}`,
    mustIncludeRepl: `|| ${leaf}`,
  };
}

test('Issue 2: PICT matrix renders changed part across --list, mutant rows, ASSERTION GAP, and INPUT GAP', () => {
  const loc = { file: 'src/util/databaseId.ts', line: 10, column: 5, start: 100, end: 200 };
  for (const [ruleShape, lineCount, surface] of multilineRows) {
    const spec = makeExpressions(ruleShape, lineCount);
    const label = `${ruleShape}/${lineCount}/${surface}`;

    if (surface === 'ListCandidate' || surface === 'EvaluatedMutant') {
      const status = surface === 'ListCandidate' ? 'listed' : 'survived';
      const evaluation = surface === 'ListCandidate' ? 'listed' : 'evaluated';
      const text = renderText({
        runner: 'vitest',
        evaluation,
        baseline: evaluation === 'evaluated' ? { status: 'passed', tests: 2 } : undefined,
        mutants: [{
          location: loc,
          rule: spec.rule,
          original: spec.original,
          replacement: spec.replacement,
          status,
        }],
        diagnostics: [],
      });
      assert.ok(text.includes(spec.mustIncludeOrig), `${label} orig missing "${spec.mustIncludeOrig}" in:\n${text}`);
      assert.ok(text.includes(spec.mustIncludeRepl), `${label} repl missing "${spec.mustIncludeRepl}" in:\n${text}`);
      assert.doesNotMatch(text, /value != null && -> \(value != null &&$/m, label);
    } else {
      const gap = surface === 'AssertionGap'
        ? {
          kind: 'ASSERTION GAP',
          location: loc,
          rule: spec.rule,
          expression: spec.original,
          mutations: [{ rule: spec.rule, original: spec.original, replacement: spec.replacement }],
          tests: [{ file: 'test/db.test.ts', name: 'checks db' }],
          example: { operands: ['true', 'true'] },
        }
        : {
          kind: 'INPUT GAP',
          location: loc,
          rule: spec.rule,
          expression: spec.original,
          mutations: [{ rule: spec.rule, original: spec.original, replacement: spec.replacement }],
          reachedBy: 2,
          missing: 'a distinguishing input',
        };
      const text = renderText({
        runner: 'vitest',
        evaluation: 'evaluated',
        baseline: { status: 'passed', tests: 2 },
        mutants: [],
        diagnostics: [gap],
      });
      assert.ok(text.includes(spec.mustIncludeOrig), `${label} gap orig missing "${spec.mustIncludeOrig}" in:\n${text}`);
      assert.ok(text.includes(spec.mustIncludeRepl), `${label} gap repl missing "${spec.mustIncludeRepl}" in:\n${text}`);
      assert.doesNotMatch(text, /`value != null &&` passes every test as `\(value != null &&`/, label);
    }
  }
});

test('Issue 2: end-to-end multiline logical candidates stay distinct in --list, text report, and preserve full JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmt-multiline-e2e-'));
  try {
    mkdirSync(join(dir, 'src/util'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'multiline-e2e', type: 'module' }));
    symlinkSync(repoNodeModules, join(dir, 'node_modules'), 'junction');
    const source = [
      'export function hasDatabaseProp(value: unknown): boolean {',
      '  return (',
      '    value != null &&',
      '    typeof value === "object" &&',
      '    "Firestore" in value &&',
      '    "database" in value',
      '  );',
      '}',
    ].join('\n') + '\n';
    writeFileSync(join(dir, 'src/util/databaseId.ts'), source);
    writeFileSync(join(dir, 'test/databaseId.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { hasDatabaseProp } from '../src/util/databaseId.ts';",
      "it('handles valid and null', () => {",
      '  expect(hasDatabaseProp(null)).toBe(false);',
      '  expect(hasDatabaseProp("str")).toBe(false);',
      '  expect(hasDatabaseProp({})).toBe(false);',
      '  expect(hasDatabaseProp({ Firestore: true, database: "default" })).toBe(true);',
      '  hasDatabaseProp({ Firestore: true });',
      '});',
    ].join('\n') + '\n');

    const listed = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/util/databaseId.ts', '--format', 'text', '--list',
    ], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const ignoredLines = listed.stdout.split('\n').filter(line => line.includes('ignored-operand/v1:'));
    assert.ok(ignoredLines.length >= 4, `Expected >= 4 ignored-operand candidates, got:\n${listed.stdout}`);
    assert.equal(new Set(ignoredLines).size, ignoredLines.length, `All listed ignored-operand lines must be distinct:\n${ignoredLines.join('\n')}`);
    assert.ok(ignoredLines.some(line => line.includes('("database" in value, true)')));

    const jsonOut = join(dir, 'reports/database-id.json');
    const analyzed = spawnSync(process.execPath, [
      cli, 'analyze', dir, 'src/util/databaseId.ts', '--concurrency', '1', '--format', 'text', '--json-out', jsonOut,
    ], { encoding: 'utf8' });
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.ok(
      analyzed.stdout.includes('survived  ignored-operand/v1: ..."Firestore" in value && "database" in value -> (..."Firestore" in value && ("database" in value, true))'),
      analyzed.stdout,
    );
    assert.ok(
      analyzed.stdout.includes('  `..."Firestore" in value && "database" in value` passes every test as `(..."Firestore" in value && ("database" in value, true))`'),
      analyzed.stdout,
    );

    const jsonReport = JSON.parse(readFileSync(jsonOut, 'utf8'));
    const fullSurvivor = jsonReport.mutants.find(m => m.rule === 'ignored-operand/v1' && m.status === 'survived' && m.replacement.includes('("database" in value, true)'));
    assert.ok(fullSurvivor);
    assert.ok(fullSurvivor.original.includes('\n'), 'JSON mutants[].original must retain full multiline source');
    assert.ok(fullSurvivor.replacement.includes('\n'), 'JSON mutants[].replacement must retain full multiline replacement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
