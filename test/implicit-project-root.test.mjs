import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tmt.mjs', import.meta.url));
const repoNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const implicitRootRows = readFileSync(new URL('../verification/pict/implicit-project-root.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

test('Issue 1: PICT matrix for analyze positional project root and file syntax guidance', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-implicit-root-'));
  const external = mkdtempSync(join(tmpdir(), 'tmt-external-file-'));
  try {
    mkdirSync(join(scratch, 'src/util'), { recursive: true });
    mkdirSync(join(scratch, 'test'), { recursive: true });
    mkdirSync(join(scratch, 'packages/sub/src'), { recursive: true });
    mkdirSync(join(scratch, 'packages/sub/test'), { recursive: true });
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'root-proj', type: 'module' }));
    writeFileSync(join(scratch, 'packages/sub/package.json'), JSON.stringify({ name: 'sub-proj', type: 'module' }));
    symlinkSync(repoNodeModules, join(scratch, 'node_modules'), 'junction');
    writeFileSync(join(scratch, 'src/util/path.ts'), 'export const isRoot = (depth: number) => depth <= 0;\n');
    writeFileSync(join(scratch, 'src/util/extra.ts'), 'export const nonEmpty = (len: number) => len > 0;\n');
    writeFileSync(join(scratch, 'test/path.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { isRoot } from '../src/util/path.ts';",
      "import { nonEmpty } from '../src/util/extra.ts';",
      "it('checks depth', () => { expect(isRoot(0)).toBe(true); expect(isRoot(1)).toBe(false); expect(nonEmpty(1)).toBe(true); expect(nonEmpty(0)).toBe(false); });",
    ].join('\n') + '\n');
    writeFileSync(join(scratch, 'packages/sub/src/item.ts'), 'export const ok = (n: number) => n >= 1;\n');
    writeFileSync(join(scratch, 'packages/sub/test/item.test.ts'), [
      "import { expect, it } from 'vitest';",
      "import { ok } from '../src/item.ts';",
      "it('checks item', () => { expect(ok(1)).toBe(true); expect(ok(0)).toBe(false); });",
    ].join('\n') + '\n');

    const externalFile = join(external, 'outside.ts');
    writeFileSync(externalFile, 'export const f = (n: number) => n >= 1;\n');

    for (const [firstArg, extraFiles, mode, configFile] of implicitRootRows) {
      const configPath = join(scratch, 'targeted-mutation.config.json');
      if (configFile === 'Present') {
        writeFileSync(configPath, JSON.stringify({ files: ['src/util/path.ts'] }));
      } else {
        rmSync(configPath, { force: true });
      }

      const args = [cli, 'analyze'];
      if (firstArg === 'DotDir') args.push('.');
      else if (firstArg === 'SubDir') args.push('packages/sub');
      else if (firstArg === 'ExistingFileInCwd') args.push('src/util/path.ts');
      else if (firstArg === 'ExistingFileOutsideCwd') args.push(externalFile);
      else if (firstArg === 'GlobPattern') args.push('src/util/*.ts');
      else if (firstArg === 'MissingTsFile') args.push('src/util/missing.ts');
      else if (firstArg === 'MissingDir') args.push('no-such-directory');

      if (extraFiles === 'OneFile') {
        args.push(firstArg === 'SubDir' ? 'src/item.ts' : 'src/util/extra.ts');
      }
      if (mode === 'List') args.push('--list', '--format', 'json');
      else args.push('--format', 'json');

      // Keep full Vitest runs fast by only running full Vitest on List or minimal rows;
      // for error rows it must fail BEFORE starting any runner!
      const isValidProject = ['Omitted', 'DotDir', 'SubDir'].includes(firstArg);
      if (isValidProject && mode === 'AnalyzeJson' && firstArg !== 'SubDir') {
        args.push('--test', 'test/path.test.ts');
      }

      const run = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 60_000 });
      const label = `${firstArg}/${extraFiles}/${mode}/${configFile}`;

      if (isValidProject) {
        assert.equal(run.status, 0, `${label}: ${run.stderr}`);
        const report = JSON.parse(run.stdout);
        assert.ok(['listed', 'evaluated'].includes(report.evaluation), label);
      } else if (firstArg === 'ExistingFileInCwd') {
        assert.equal(run.status, 1, label);
        assert.doesNotMatch(run.stderr, /ENOTDIR|scandir/, label);
        const expectedCmd = extraFiles === 'OneFile'
          ? 'targeted-mutation analyze . src/util/path.ts src/util/extra.ts'
          : 'targeted-mutation analyze . src/util/path.ts';
        assert.ok(run.stderr.includes(expectedCmd), `${label}: expected "${expectedCmd}" in stderr, got: ${run.stderr}`);
      } else if (firstArg === 'ExistingFileOutsideCwd') {
        assert.equal(run.status, 1, label);
        assert.doesNotMatch(run.stderr, /ENOTDIR|scandir/, label);
        assert.match(run.stderr, /not a directory/i, label);
        assert.match(run.stderr, /targeted-mutation analyze <PROJECT> <FILE/, label);
      } else if (firstArg === 'GlobPattern') {
        assert.equal(run.status, 1, label);
        assert.match(run.stderr, /Project directory not found: src\/util\/\*\.ts/, label);
        assert.match(run.stderr, /targeted-mutation analyze \. "src\/util\/\*\.ts"/, label);
      } else if (firstArg === 'MissingTsFile') {
        assert.equal(run.status, 1, label);
        assert.match(run.stderr, /Project directory not found: src\/util\/missing\.ts/, label);
        assert.match(run.stderr, /targeted-mutation analyze \. src\/util\/missing\.ts/, label);
      } else if (firstArg === 'MissingDir') {
        assert.equal(run.status, 1, label);
        assert.match(run.stderr, /^Project directory not found: no-such-directory\n$/, label);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
