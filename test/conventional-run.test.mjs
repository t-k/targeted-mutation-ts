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
