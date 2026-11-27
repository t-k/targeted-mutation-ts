import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeOperators } from '../src/operator-analysis.mjs';
import { changedTestFiles, detectWeakenedTests } from '../src/weakened-tests.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function makeTempProject() {
  const dir = mkdtempSync(resolve(tmpdir(), 'tmt-weakened-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  mkdirSync(resolve(dir, 'test'), { recursive: true });
  symlinkSync(resolve(repoRoot, 'node_modules'), resolve(dir, 'node_modules'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(resolve(dir, '.gitignore'), 'node_modules/\n');
  writeFileSync(resolve(dir, 'src/eligibility.ts'), 'export const isAdult = (age: number) => age >= 18;\n');
  writeFileSync(resolve(dir, 'test/eligibility.test.ts'), [
    "import { expect, test } from 'vitest';",
    "import { isAdult } from '../src/eligibility.ts';",
    "test('checks adult boundary', () => {",
    '  expect(isAdult(17)).toBe(false);',
    '  expect(isAdult(18)).toBe(true);',
    '  expect(isAdult(20)).toBe(true);',
    '});',
  ].join('\n'));
  git(dir, ['init']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '--no-gpg-sign', '-m', 'initial']);
  return dir;
}

describe('weakened-test detection (--since REV)', () => {
  it('detects when a test change lets a previously caught mutant survive', async () => {
    const dir = makeTempProject();
    try {
      const baseRev = git(dir, ['rev-parse', 'HEAD']).trim();
      // Weaken the test by removing the exact boundary check (18) and touching src so --since picks it up.
      writeFileSync(resolve(dir, 'src/eligibility.ts'), '// updated\nexport const isAdult = (age: number) => age >= 18;\n');
      writeFileSync(resolve(dir, 'test/eligibility.test.ts'), [
        "import { expect, test } from 'vitest';",
        "import { isAdult } from '../src/eligibility.ts';",
        "test('checks adult boundary', () => {",
        '  expect(isAdult(17)).toBe(false);',
        '  expect(isAdult(20)).toBe(true);',
        '});',
      ].join('\n'));

      const changed = changedTestFiles(dir, baseRev);
      assert.equal(changed.files.length, 1);
      assert.equal(changed.files[0].file, 'test/eligibility.test.ts');

      const report = await analyzeOperators(dir, ['src/eligibility.ts'], { mutators: 'targeted' });
      assert.equal(report.evaluation, 'evaluated');
      const withWeakened = await detectWeakenedTests(dir, report, { since: baseRev });

      assert.ok(withWeakened.weakened, 'expected weakened summary');
      assert.ok(withWeakened.weakened.count >= 1);
      assert.ok(withWeakened.diagnostics.some(d => d.weakened?.since === baseRev));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns report unchanged with zero extra runs when no test files changed', async () => {
    const dir = makeTempProject();
    try {
      const baseRev = git(dir, ['rev-parse', 'HEAD']).trim();
      const fakeReport = { evaluation: 'evaluated', runner: 'vitest', mutants: [], diagnostics: [] };
      const out = await detectWeakenedTests(dir, fakeReport, { since: baseRev });
      assert.equal(out, fakeReport);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
