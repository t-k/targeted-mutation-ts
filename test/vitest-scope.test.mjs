import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const file = 'subject.ts';
const source = 'export const yes = (n: number) => n >= 18;';
const rows = readFileSync(new URL('../verification/pict/vitest-dogfood.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

function fixture(config, assets, callback) {
  const root = mkdtempSync(join(tmpdir(), 'tmt-vitest-scope-'));
  try {
    for (const dir of ['test', 'asset', '.worktrees']) mkdirSync(join(root, dir));
    writeFileSync(join(root, file), source);
    writeFileSync(join(root, 'asset', 'sample'), 'fixture asset');
    writeFileSync(join(root, '.worktrees', 'sample'), 'unrelated worktree');
    writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["test/default-*.test.ts"] } };');
    writeFileSync(join(root, 'vitest.scope.config.mjs'), 'export default { test: { include: ["test/custom-*.test.ts"] } };');
    for (const setting of ['default', 'custom']) {
      for (let index = 1; index <= 3; index++) {
        const assertions = index === 2 ? 2 : 1;
        const testFile = join(root, 'test', `${setting}-${index}.test.ts`);
        const body = setting === config.toLowerCase()
          ? `expect(yes(18)).toBe(true); expect(existsSync('asset/sample')).toBe(${assets === 'Keep'}); expect(existsSync('.worktrees/sample')).toBe(false);`
          : `throw new Error('Wrong Vitest configuration');`;
        writeFileSync(testFile, `import {expect,it} from 'vitest'; import {existsSync} from 'node:fs'; import {yes} from '../subject';\n` +
          Array.from({ length: assertions }, (_, position) => `it('${index}-${position}', () => { ${body} });`).join('\n'));
      }
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root, flags, sources = [file]) {
  return spawnSync(process.execPath, ['bin/tmt.mjs', 'analyze', root, ...sources, ...flags], { encoding: 'utf8', timeout: 25_000 });
}

for (const row of rows) {
  const [config, tests, assets] = row.split('\t');
  test(`PICT Vitest ${config}/${tests}/${assets}`, () => fixture(config, assets, root => {
    const prefix = config.toLowerCase();
    const flags = [
      ...(config === 'Custom' ? ['--config', 'vitest.scope.config.mjs'] : []),
      ...(tests === 'All' ? [] : ['--test', `test/${prefix}-1.test.ts`]),
      ...(tests === 'Two' ? ['--test', `test/${prefix}-2.test.ts`] : []),
      ...(assets === 'Exclude' ? ['--copy-exclude', 'asset'] : []),
    ];
    const result = run(root, flags);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.baseline.tests, { All: 4, One: 1, Two: 3 }[tests]);
    assert.equal(report.instrumented.status, 'passed');
    assert.equal(report.mutants[0].status, 'killed');
    assert.equal(readFileSync(join(root, file), 'utf8'), source);
    assert.equal(readFileSync(join(root, 'asset', 'sample'), 'utf8'), 'fixture asset');
  }));
}

test('reports a selected test excluded by the configured suite', () => fixture('Default', 'Keep', root => {
  const result = run(root, ['--test', 'test/default-1.test.ts', '--test', 'test/custom-1.test.ts']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Vitest test selection mismatch/);
}));

test('rejects a copy exclusion outside the workspace', () => fixture('Default', 'Keep', root => {
  const result = run(root, ['--copy-exclude', '..']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Copy exclusion must be inside the project/);
}));

test('audits a generated witness in the selected test file only', () => fixture('Custom', 'Keep', root => {
  const selected = 'test/custom-1.test.ts';
  writeFileSync(join(root, selected), "import {expect,it} from 'vitest'; import {yes} from '../subject'; it('checks above the boundary', () => expect(yes(20)).toBe(true));");
  const result = run(root, ['--config', 'vitest.scope.config.mjs', '--test', selected, '--audit']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.baseline.tests, 1);
  assert.equal(report.mutants[0].status, 'survived');
  assert.equal(report.mutants[0].audit.status, 'agreed');
  assert.deepEqual(report.diagnostics[0].verification, { baselineWithWitness: 'passed', rewriteWithWitness: 'failed' });
}));

test('applies copy exclusions to auto-discovery and rejects explicit overlap', () => fixture('Default', 'Exclude', root => {
  writeFileSync(join(root, 'asset/sample.ts'), source);
  const result = run(root, ['--copy-exclude', 'asset'], []);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).extraction.map(entry => entry.file), [file]);
  const explicit = run(root, ['--copy-exclude', 'asset'], ['asset/sample.ts']);
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /Source is excluded from trial copies: asset\/sample\.ts/);
}));

test('rejects exclusions under a symlink and exclusions of the dependency projection', () => fixture('Default', 'Keep', root => {
  symlinkSync('asset', join(root, 'linked'), 'dir');
  const throughLink = run(root, ['--copy-exclude', 'linked/sample']);
  assert.equal(throughLink.status, 1);
  assert.match(throughLink.stderr, /Copy exclusion must not traverse a symbolic link/);
  mkdirSync(join(root, 'node_modules'));
  const dependency = run(root, ['--copy-exclude', 'node_modules']);
  assert.equal(dependency.status, 1);
  assert.match(dependency.stderr, /Copy exclusion cannot target node_modules/);
}));

test('detects an extra collected module even when it registers no tests', () => fixture('Default', 'Keep', root => {
  writeFileSync(join(root, 'test/default-1.test.ts.extra.test.ts'), 'export {};');
  writeFileSync(join(root, 'vitest.config.mjs'), 'export default { test: { include: ["test/default-*.test.ts"], passWithNoTests: true } };');
  const result = run(root, ['--test', 'test/default-1.test.ts']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Vitest test selection mismatch.*unexpected: test\/default-1\.test\.ts\.extra\.test\.ts/);
}));
