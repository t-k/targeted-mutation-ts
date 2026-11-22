import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const tarball = resolve(process.argv[2] ?? `build/packages/targeted-mutation-${version}.tgz`);
const platformTarball = resolve(process.argv[3] ?? `build/packages/targeted-mutation-tmt-${target}-${version}.tgz`);
const fixture = resolve('fixtures/eligibility');
const cwd = mkdtempSync(join(tmpdir(), 'tmt-pack-test-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const combinations = readFileSync(new URL('../verification/pict/runtime-dependencies.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 240_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

try {
  cpSync(fixture, join(cwd, 'fixture'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"name":"tmt-pack-test","version":"1.0.0","private":true}');
  const install = (...packages) => run(npm, ['install', ...packages, '--no-audit', '--no-fund']);
  // The syntax projection is generated from this compiler release. Other releases use the full compiler.
  install(tarball, platformTarball, 'typescript@6.0.3');
  const installed = join(cwd, 'node_modules/targeted-mutation');
  const platformPackage = join(cwd, `node_modules/@targeted-mutation/tmt-${target}`);
  const load = createRequire(import.meta.url);
  const addon = load(join(platformPackage, 'tmt.node'));
  assert.equal(addon.syntax, undefined);
  assert.equal(addon.standalone, undefined);
  for (const binary of ['tmt.node', 'tmt-decide']) {
    assert.equal(readFileSync(join(platformPackage, binary)).includes(homedir()), false, `${binary} records the build machine's home directory`);
  }
  for (const file of ['LICENSE', 'NOTICE', 'lean/LICENSE', 'lean/LICENSES']) assert.ok(readFileSync(join(platformPackage, file)).length, file);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const platformManifest = JSON.parse(readFileSync(join(platformPackage, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { typescript: '>=5.9.3 <7' });
  assert.equal(manifest.optionalDependencies[platformManifest.name], version);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.match(readFileSync(join(installed, 'LICENSE'), 'utf8'), /Apache License/);
  for (const absent of ['build/tmt.node', 'build/tmt-decide', 'evidence']) assert.equal(existsSync(join(installed, absent)), false, absent);
  for (const command of ['targeted-mutation', 'tmts']) {
    assert.equal(run(join(cwd, 'node_modules/.bin', command), ['--version']), `${version}\n`);
  }
  assert.equal(existsSync(join(installed, 'build/typescript-cache')), false);
  const syntax = join(installed, 'build/typescript-syntax');
  assert.match(readFileSync(join(syntax, 'typescript-syntax.cjs'), 'utf8'), /Copyright \(c\) Microsoft Corporation/);
  assert.match(readFileSync(join(syntax, 'LICENSE.txt'), 'utf8'), /Apache License/);
  assert.ok(readFileSync(join(syntax, 'ThirdPartyNoticeText.txt')).length);
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(path => path.startsWith('node_modules/')).sort(),
    [`node_modules/@targeted-mutation/tmt-${target}`, 'node_modules/targeted-mutation', 'node_modules/typescript']);
  assert.deepEqual(platformManifest.os, [process.platform]);
  assert.deepEqual(platformManifest.cpu, [process.arch]);
  if (process.platform === 'linux') assert.deepEqual(platformManifest.libc, ['glibc']);
  mkdirSync(join(installed, 'node_modules/unrelated'), { recursive: true });
  const entry = join(installed, 'bin/tmt.mjs');
  assert.match(run(process.execPath, [entry, '--help']), /^Usage: targeted-mutation /);
  writeFileSync(join(cwd, 'broad.ts'), 'export const a = {}; export const b = a <number>().value < 2;');
  const hook = join(cwd, 'reject-full-parser.mjs');
  writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/typescript/lib/typescript.js')) throw new Error('Full compiler loaded during extraction');
  return next(url, context);
} });\n`);
  const broad = JSON.parse(run(process.execPath, ['--import', hook, entry, 'extract', 'broad.ts']));
  assert.equal(broad.path, 'fallback');
  assert.equal(broad.fallback, 'typescript');
  assert.equal(broad.metrics.astNodes, 0);
  assert.deepEqual(broad.candidates.map(candidate => candidate.operator), ['<']);
  writeFileSync(join(cwd, 'module.ts'), 'import { limit } from "./settings"; export function ready(n: number): boolean { return n < limit; }');
  const module = JSON.parse(run(process.execPath, [entry, 'extract', 'module.ts']));
  assert.equal(module.path, 'fast');
  assert.deepEqual(module.candidates.map(candidate => candidate.operator), ['<']);
  const condition = 'for (let i = 0; i < values.length; i++) {}';
  writeFileSync(join(cwd, 'control.ts'), condition);
  const nativeControl = JSON.parse(run(process.execPath, [entry, 'extract', 'control.ts']));
  assert.equal(nativeControl.path, 'fast');
  writeFileSync(join(cwd, 'ambient.ts'), 'declare const values: Array<number>;\n' + condition);
  const nativeScript = JSON.parse(run(process.execPath, [entry, 'extract', 'ambient.ts', '--mode', 'script']));
  assert.equal(nativeScript.path, 'fast');
  assert.deepEqual(nativeScript.candidates.map(candidate => candidate.operator), ['<']);
  writeFileSync(join(cwd, 'compatibility.ts'), 'namespace Model { export type Value = number; }\n' + condition);
  const compatibilityControl = JSON.parse(run(process.execPath, [entry, 'extract', 'compatibility.ts', '--mode', 'script']));
  assert.equal(compatibilityControl.fallback, 'typescript');
  assert.deepEqual(nativeControl.candidates.map(candidate => candidate.operator), ['<']);
  assert.deepEqual(compatibilityControl.candidates.map(candidate => candidate.operator), ['<']);
  writeFileSync(join(cwd, 'fixture/src/strict.ts'), 'export const positive = (count: number) => count > 0;');
  writeFileSync(join(cwd, 'fixture/test/strict.test.ts'), "import { expect, it } from 'vitest'; import { positive } from '../src/strict'; it('checks two', () => expect(positive(2)).toBe(true));");
  cpSync(resolve('fixtures/witnesses'), join(cwd, 'witnesses'), { recursive: true });
  const profiles = {
    Focused: ['fixture', 'src/eligibility.ts', '--test', 'test/eligibility.test.ts', '--spec', 'spec.json', '--deterministic', '--audit'],
    Witnesses: ['witnesses', 'src/queries.ts', '--witnesses', '--test', 'test/queries.test.ts', '--lines', 'src/queries.ts:5-5'],
    Standard: ['fixture', 'src/eligibility.ts', '--mutators', 'standard', '--test', 'test/eligibility.test.ts'],
    All: ['fixture', 'src/strict.ts', '--mutators', 'all', '--deterministic', '--test', 'test/strict.test.ts'],
  };
  install('vitest@4.0.18');
  const vitest = join(cwd, 'node_modules/vitest');
  const hiddenVitest = join(cwd, 'hidden-vitest');
  const instrumenter = join(cwd, 'node_modules/@stryker-mutator/instrumenter');
  for (const version of ['Missing', 'Incompatible', 'Compatible']) {
    if (version === 'Incompatible') {
      mkdirSync(instrumenter, { recursive: true });
      writeFileSync(join(instrumenter, 'package.json'), '{"version":"0.0.0"}');
    }
    if (version === 'Compatible') {
      rmSync(instrumenter, { recursive: true });
      install('@stryker-mutator/instrumenter@10.1.1');
    }
    for (const [profile, runner, engine] of combinations.filter(row => row[2] === version)) {
      if (runner === 'Missing') renameSync(vitest, hiddenVitest);
      const localModules = join(cwd, profiles[profile][0], 'node_modules');
      if (runner === 'HoistedWithLocalModules') mkdirSync(localModules);
      const result = spawnSync(process.execPath, [entry, 'analyze', ...profiles[profile]],
        { cwd, encoding: 'utf8', timeout: 240_000 });
      if (runner === 'HoistedWithLocalModules') rmSync(localModules, { recursive: true });
      if (runner === 'Missing') renameSync(hiddenVitest, vitest);
      const expectsEngine = profile === 'Standard' || profile === 'All';
      const missingEngine = expectsEngine && engine !== 'Compatible';
      if (missingEngine || runner === 'Missing') {
        assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
        assert.match(result.stderr, missingEngine ? /@stryker-mutator\/instrumenter@10\.1\.1/ : /Install Vitest/);
        continue;
      }
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.evaluation, 'evaluated');
      if (profile === 'Focused') {
        assert.equal(report.extraction[0].path, 'fast');
        assert.equal(report.mutants[0].evidence, 'predicted');
        assert.equal(report.mutants[0].audit.status, 'agreed');
      } else if (profile === 'Witnesses') {
        assert.ok(report.diagnostics.some(gap => gap.rule === 'first-to-last-index/v1' && gap.verification.status === 'confirmed'));
      } else if (profile === 'Standard') {
        assert.ok(report.mutants.some(mutant => mutant.mutatorName === 'EqualityOperator' && mutant.status === 'survived'));
      } else {
        assert.ok(report.mutants.some(mutant => mutant.evidence === 'predicted'));
        assert.ok(report.mutants.some(mutant => mutant.rule === 'comparison-tighten/v1' && mutant.status === 'survived'));
      }
    }
  }
  const ordered = JSON.parse(run(process.execPath, [entry, 'analyze', 'witnesses', 'src/text-order.ts',
    '--witnesses', '--test', 'test/text-order.test.ts', '--spec', 'order-spec.json']));
  assert.ok(ordered.diagnostics.some(gap => gap.rule === 'substitute-sort-key/v1' && gap.verification.status === 'confirmed'));
  const discovered = JSON.parse(run(process.execPath, [entry, 'analyze', 'witnesses', 'src/contracts.ts',
    '--witnesses', '--test', 'test/contracts.test.ts']));
  assert.ok(discovered.diagnostics.some(gap => gap.rule === 'paired-source/v1' && gap.verification.status === 'confirmed'));
  assert.ok(discovered.diagnostics.some(gap => gap.borrowedFrom?.method === 'get' && gap.verification.status === 'confirmed'));
  const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  const mismatch = mkdtempSync(join(cwd, 'mismatch-'));
  writeFileSync(join(mismatch, 'package.json'), JSON.stringify({
    name: 'tmt-platform-mismatch', version: '1.0.0', os: platformManifest.os, cpu: [wrongArch],
  }));
  const packed = spawnSync(npm, ['pack', '--ignore-scripts', '--json'], { cwd: mismatch, encoding: 'utf8', timeout: 240_000 });
  assert.equal(packed.status, 0, packed.error?.message ?? packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const denied = spawnSync(npm, ['install', join(mismatch, filename), '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 240_000 });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /EBADPLATFORM/);
  // Without a platform package the CLI parses with TypeScript and decides every trial by a real run.
  const hiddenPlatform = join(cwd, 'hidden-platform');
  renameSync(platformPackage, hiddenPlatform);
  try {
    const portable = JSON.parse(run(process.execPath, [entry, 'extract', 'module.ts']));
    assert.equal(portable.path, 'fallback');
    assert.equal(portable.reason, 'native-unavailable');
    assert.deepEqual(portable.candidates.map(candidate => candidate.operator), ['<']);
    const unassisted = JSON.parse(run(process.execPath, [entry, 'analyze', ...profiles.Focused]));
    assert.equal(unassisted.evaluation, 'evaluated');
    assert.ok(unassisted.mutants.length > 0);
    assert.ok(unassisted.mutants.every(mutant => mutant.evidence === 'reexecuted'));
  } finally {
    renameSync(hiddenPlatform, platformPackage);
  }
  // The oldest supported compiler has no generated projection and uses the full parser.
  install('typescript@5.9.3');
  const older = JSON.parse(run(process.execPath, [entry, 'extract', 'broad.ts']));
  assert.equal(older.fallback, 'typescript');
  assert.deepEqual(older.candidates.map(candidate => candidate.operator), ['<']);
  const olderAnalysis = JSON.parse(run(process.execPath, [entry, 'analyze', ...profiles.Focused]));
  assert.equal(olderAnalysis.mutants[0].evidence, 'predicted');
  assert.equal(olderAnalysis.mutants[0].audit.status, 'agreed');
  console.log('Installed runtime used the native extractor, compiled Lean decision and Vitest audit');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
