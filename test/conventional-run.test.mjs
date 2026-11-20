import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function temporaryProject(action) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-standard-test-'));
  try {
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function analyze(root, ...args) {
  const run = spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, 'subject.ts', '--mutators', 'standard', ...args],
    { encoding: 'utf8', timeout: 20_000 });
  return { ...run, report: run.stdout ? JSON.parse(run.stdout) : null };
}

test('runs exact scoped stock-compatible mutations with an unchanged target checkout', () => temporaryProject(root => {
  const source = `export const active = (count: number) => count > 0 ? 'yes' : 'no';
export const hidden = (count: number) => count < 10;
`;
  writeFileSync(join(root, 'subject.ts'), source);
  writeFileSync(join(root, 'tmt.config.mjs'), "export default { test: { include: ['*.spec.ts'] } };");
  writeFileSync(join(root, 'a.spec.ts'), "import { expect, it } from 'vitest'; import { active } from './subject'; it('active', () => expect(active(2)).toBe('yes'));");
  writeFileSync(join(root, 'b.spec.ts'), "import { expect, it } from 'vitest'; import { active } from './subject'; it('active', () => expect(active(0)).toBe('no'));");
  const { status, stderr, report } = analyze(root, '--config', 'tmt.config.mjs', '--test', 'a.spec.ts', '--lines', 'subject.ts:1-1');
  assert.equal(status, 0, stderr);
  assert.equal(report.baseline.tests, 1);
  assert.equal(report.evaluation, 'evaluated');
  const lower = report.mutants.find(mutant => mutant.original === 'count > 0' && mutant.replacement === 'count >= 0');
  const opposite = report.mutants.find(mutant => mutant.original === 'count > 0' && mutant.replacement === 'count <= 0');
  assert.equal(lower.status, 'survived');
  assert.equal(opposite.status, 'killed');
  assert.ok(report.mutants.every(mutant => mutant.location.line === 1));
  assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), source);
}));

test('refuses mutations following a failing baseline', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), 'export const value = 3 < 9;');
  writeFileSync(join(root, 'subject.test.ts'), "import { expect, it } from 'vitest'; import { value } from './subject'; it('fails', () => expect(value).toBe(false));");
  const { status, report } = analyze(root);
  assert.equal(status, 1);
  assert.equal(report.evaluation, 'baseline_error');
  assert.equal(report.mutants.length, 0);
}));

test('captures mutation coverage in user teardown hooks', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), 'export const check = (n: number) => n > 0;');
  writeFileSync(join(root, 'vitest.config.mjs'), "export default { test: { sequence: { hooks: 'list' } } };");
  writeFileSync(join(root, 'subject.test.ts'), "import { afterAll, expect, it } from 'vitest'; import { check } from './subject'; it('passes', () => {}); afterAll(() => expect(check(2)).toBe(true));");
  const { status, stderr, report } = analyze(root);
  assert.equal(status, 0, stderr);
  const mutant = report.mutants.find(mutant => mutant.replacement === 'n <= 0');
  assert.equal(mutant.status, 'error');
  assert.match(mutant.statusReason, /expected false to be true/);
}));

test('executes workspace-package imports from the disposable copy', () => temporaryProject(root => {
  const module = join(root, 'packages/local');
  mkdirSync(module, { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  symlinkSync('../packages/local', join(root, 'node_modules/local-library'), 'dir');
  symlinkSync(resolve('node_modules/vitest'), join(root, 'node_modules/vitest'), 'dir');
  symlinkSync('packages/local/subject.ts', join(root, 'subject.ts'), 'file');
  writeFileSync(join(module, 'package.json'), JSON.stringify({ name: 'local-library', exports: './subject.ts' }));
  writeFileSync(join(module, 'subject.ts'), 'export const check = (n: number) => n > 0;');
  writeFileSync(join(root, 'subject.test.ts'), "import { expect, it } from 'vitest'; import { check } from 'local-library'; it('checks package', () => expect(check(2)).toBe(true));");
  const { status, stderr, report } = analyze(root);
  assert.equal(status, 0, stderr);
  assert.equal(report.mutants.find(mutant => mutant.replacement === 'n <= 0').status, 'killed');
}));

test('combines standard variants with an independently evaluated integer threshold shift', () => temporaryProject(root => {
  const source = 'export const keep = (count: number) => count > 0;';
  writeFileSync(join(root, 'subject.ts'), source);
  writeFileSync(join(root, 'subject.test.ts'), "import { expect, it } from 'vitest'; import { keep } from './subject'; it('asserts two', () => expect(keep(2)).toBe(true)); it('exercises one', () => { keep(1); });");
  const { status, report, stderr } = analyze(root, '--mutators', 'all');
  assert.equal(status, 0, stderr);
  assert.equal(report.mutators, 'all');
  assert.ok(report.extraction.length > 0);
  assert.ok(report.mutants.some(variant => variant.mutatorName === 'EqualityOperator'));
  const focused = report.mutants.find(variant => variant.rule === 'comparison-tighten/v1');
  assert.equal(focused.status, 'survived');
  assert.equal(focused.replacement, '1');
  assert.deepEqual(report.diagnostics.find(gap => gap.site === focused.site).example,
    { operands: [1, 0], original: true, mutant: false });
  assert.equal(readFileSync(join(root, 'subject.ts'), 'utf8'), source);
}));

test('does not add focused variants outside complete scopes or across disabled directives', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), [
    'export const keep = (count: number) => count >', '  0;',
    '// Stryker disable next-line all', 'export const ignored = (count: number) => count < 0;',
  ].join('\n'));
  const { status, stderr, report } = analyze(root, '--mutators', 'all', '--lines', 'subject.ts:1-1', '--lines', 'subject.ts:4-4');
  assert.equal(status, 0, stderr);
  assert.ok(report.mutants.every(mutant => mutant.status === 'ignored'));
  assert.ok(report.mutants.length);
}));

test('does not collide with Unicode-escaped local bindings', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), 'export const keep = (__tmtFocusedCompar\\u0065: number) => __tmtFocusedCompar\\u0065 > 0;');
  writeFileSync(join(root, 'subject.test.ts'), "import { expect, it } from 'vitest'; import { keep } from './subject'; it('checks two', () => expect(keep(2)).toBe(true));");
  const { status, stderr, report } = analyze(root, '--mutators', 'all', '--deterministic');
  assert.equal(status, 0, stderr);
  assert.equal(report.evaluation, 'evaluated');
  assert.ok(report.mutants.some(mutant => mutant.evidence === 'predicted' && mutant.status === 'survived'));
  assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-tighten/v1' && mutant.status === 'survived'));
}));

test('reexecutes conventional variants when safe integer traces disagree on replay', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), 'export const keep = (count: number) => count > 0;');
  writeFileSync(join(root, 'subject.test.ts'), `
import { existsSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { keep } from './subject';
it('observes different integers on repeat', () => {
  const count = existsSync('marker') ? 3 : 2;
  writeFileSync('marker', '');
  expect(keep(count)).toBe(true);
});
`);
  const { status, stderr, report } = analyze(root, '--mutators', 'all', '--deterministic');
  assert.equal(status, 0, stderr);
  assert.equal(report.evaluation, 'evaluated');
  assert.ok(report.mutants.some(mutant => mutant.status === 'survived'));
  assert.ok(report.mutants.every(mutant => mutant.evidence !== 'predicted'));
}));

test('reports unsafe observations without pretending a focused trial ran', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.ts'), 'export const keep = (count: number | string) => count > 0;');
  writeFileSync(join(root, 'subject.test.ts'), "import { expect, it } from 'vitest'; import { keep } from './subject'; it('coerces the left operand', () => expect(keep('2')).toBe(true));");
  const { status, stderr, report } = analyze(root, '--mutators', 'all');
  assert.equal(status, 0, stderr);
  const focused = report.mutants.find(mutant => mutant.rule === 'comparison-tighten/v1');
  assert.equal(focused.status, 'unsupported');
  assert.equal(focused.evidence, undefined);
}));

test('keeps standard variants for native CommonJS imports in the combined profile', () => temporaryProject(root => {
  writeFileSync(join(root, 'subject.cts'), 'module.exports = (count: number) => count > 0;');
  symlinkSync('subject.cts', join(root, 'subject.ts'), 'file');
  writeFileSync(join(root, 'subject.test.ts'), "import { createRequire } from 'node:module'; import { expect, it } from 'vitest'; const keep = createRequire(import.meta.url)('./subject.cts'); it('checks two', () => expect(keep(2)).toBe(true));");
  const { status, stderr, report } = analyze(root, '--mutators', 'all');
  assert.equal(status, 0, stderr);
  assert.equal(report.baseline.status, 'passed');
  assert.ok(report.mutants.some(mutant => mutant.mutatorName === 'EqualityOperator' && mutant.status === 'killed'));
  assert.ok(report.mutants.every(mutant => mutant.rule !== 'comparison-tighten/v1'));
}));

test('does not convert erased TypeScript module markers into value imports', () => temporaryProject(root => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(join(root, 'subject.ts'), 'export type Count = number; module.exports = (count: Count) => count > 0;');
  writeFileSync(join(root, 'subject.test.ts'), "import { createRequire } from 'node:module'; import { expect, it } from 'vitest'; const keep = createRequire(import.meta.url)('./subject.ts'); it('checks two', () => expect(keep(2)).toBe(true));");
  const { status, stderr, report } = analyze(root, '--mutators', 'all');
  assert.equal(status, 0, stderr);
  assert.equal(report.baseline.status, 'passed');
  assert.ok(report.mutants.some(mutant => mutant.mutatorName === 'EqualityOperator' && mutant.status === 'killed'));
}));
