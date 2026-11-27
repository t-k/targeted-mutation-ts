import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decisionBinaryName } from '../src/runtime-binaries.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const platformName = `@targeted-mutation/tmt-${target}`;
const decision = decisionBinaryName();
const windows = process.platform === 'win32';
const cliArgs = process.argv.slice(2);
const portable = cliArgs.includes('--portable');
const positionals = cliArgs.filter(arg => arg !== '--portable');
const tarball = resolve(positionals[0] ?? `build/packages/targeted-mutation-${version}.tgz`);
const platformTarball = portable ? null : resolve(positionals[1] ?? `build/packages/targeted-mutation-tmt-${target}-${version}.tgz`);
const fixture = resolve('fixtures/eligibility');
const cwd = mkdtempSync(join(tmpdir(), 'tmt pack test-'));
const npm = windows ? 'npm.cmd' : 'npm';
const combinations = readFileSync(new URL('../verification/pict/runtime-dependencies.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function invoke(command, args, options) {
  const shell = windows && command.endsWith('.cmd');
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 240_000, shell, ...options });
}

function run(command, args, options) {
  const result = invoke(command, args, options);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

try {
  cpSync(fixture, join(cwd, 'fixture'), { recursive: true });
  cpSync(tarball, join(cwd, 'main-runtime.tgz'));
  const project = { name: 'tmt-pack-test', version: '1.0.0', private: true };
  if (!portable) {
    cpSync(platformTarball, join(cwd, 'native-runtime.tgz'));
    // Point npm at the staged archive while leaving the native dependency transitive.
    project.overrides = { [platformName]: 'file:./native-runtime.tgz' };
  }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(project));
  const platformPackage = join(cwd, 'node_modules', platformName);
  const install = (...packages) => {
    run(npm, ['install', ...packages, '--no-audit', '--no-fund']);
    if (portable && existsSync(platformPackage)) rmSync(platformPackage, { recursive: true, force: true });
  };
  // The syntax projection is generated from this compiler release. Other releases use the full compiler.
  run(npm, ['install', './main-runtime.tgz', 'typescript@6.0.3', '--no-audit', '--no-fund', ...(portable ? ['--omit=optional'] : [])]);
  const installed = join(cwd, 'node_modules/targeted-mutation');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  let platformManifest = null;
  if (!portable) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    if (windows) env.PATH = join(process.env.SystemRoot, 'System32');
    // Unload the addon before moving or removing its directory on Windows.
    const exports = JSON.parse(run(process.execPath, ['--eval',
      'console.log(JSON.stringify(Object.keys(require(process.argv[1]))))', join(platformPackage, 'tmt.node')], { env }));
    assert.ok(exports.includes('parse') && exports.includes('locations'));
    assert.ok(!exports.includes('syntax') && !exports.includes('standalone'));
    assert.equal(run(join(platformPackage, decision), [], { input: '[]', env }).trim(), '[]');
    const home = homedir();
    const repoRoot = resolve('.');
    const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathVariants = value => {
      const slash = value.replaceAll('\\', '/');
      return slash === value ? [value] : [value, slash];
    };
    const patternFlags = windows ? 'gi' : 'g';
    // Lean's prebuilt runtime and LLVM C++/unwind libraries are compiled on GitHub Actions under <home>/.../lean4/lean4/ or lean-llvm/lean-llvm/.
    const leanUpstream = new RegExp(`(?:${pathVariants(home).map(escapeRegExp).join('|')})[\\\\/](?:actions-runner[\\\\/]_work|_work|work)[\\\\/](?:lean4[\\\\/]lean4|lean-llvm[\\\\/]lean-llvm)[\\\\/]`, patternFlags);
    const repoPattern = new RegExp(`(?:${pathVariants(repoRoot).map(escapeRegExp).join('|')})`, windows ? 'i' : '');
    const homeSnippet = new RegExp(`(?:${pathVariants(home).map(escapeRegExp).join('|')})[^\\0\\r\\n"']{0,120}`, patternFlags);
    for (const binary of ['tmt.node', decision]) {
      const text = readFileSync(join(platformPackage, binary)).toString('latin1');
      assert.equal(repoPattern.test(text), false, `${binary} records the build repository path`);
      const scrubbed = binary === decision ? text.replace(leanUpstream, '') : text;
      const leaks = [...scrubbed.matchAll(homeSnippet)].slice(0, 5).map(m => m[0]);
      assert.equal(leaks.length, 0, `${binary} records the build machine's home directory: ${leaks.join(', ')}`);
    }
    for (const file of ['LICENSE', 'NOTICE', 'lean/LICENSE', 'lean/LICENSES', 'lean/GPL-3.0.txt', 'lean/libuv-LICENSE.txt', 'lean/libuv-LICENSE-extra.txt']) assert.ok(readFileSync(join(platformPackage, file)).length, file);
    platformManifest = JSON.parse(readFileSync(join(platformPackage, 'package.json'), 'utf8'));
    assert.equal(manifest.optionalDependencies[platformManifest.name], version);
  }
  assert.deepEqual(manifest.dependencies, { typescript: '>=5.9.3 <7' });
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.match(readFileSync(join(installed, 'LICENSE'), 'utf8'), /Apache License/);
  for (const absent of ['build/tmt.node', 'build/tmt-decide', 'build/tmt-decide.exe', 'evidence']) assert.equal(existsSync(join(installed, absent)), false, absent);
  const binSuffix = windows ? '.cmd' : '';
  for (const command of ['targeted-mutation', 'tmts']) {
    assert.equal(run(join('node_modules/.bin', `${command}${binSuffix}`), ['--version']).trim(), version);
  }
  assert.equal(existsSync(join(installed, 'build/typescript-cache')), false);
  const syntax = join(installed, 'build/typescript-syntax');
  assert.match(readFileSync(join(syntax, 'typescript-syntax.cjs'), 'utf8'), /Copyright \(c\) Microsoft Corporation/);
  assert.match(readFileSync(join(syntax, 'LICENSE.txt'), 'utf8'), /Apache License/);
  assert.ok(readFileSync(join(syntax, 'ThirdPartyNoticeText.txt')).length);
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  // The lockfile also lists the other platforms' optional packages, which npm does not install here.
  const expectedInstalled = portable
    ? ['node_modules/targeted-mutation', 'node_modules/typescript']
    : [`node_modules/${platformName}`, 'node_modules/targeted-mutation', 'node_modules/typescript'];
  assert.deepEqual(Object.keys(lock.packages).filter(path => path.startsWith('node_modules/') && existsSync(join(cwd, path))).sort(),
    expectedInstalled);
  if (!portable) {
    const nativeDependency = lock.packages[`node_modules/${platformName}`];
    assert.equal(nativeDependency.optional, true);
    assert.equal(nativeDependency.version, version);
    assert.deepEqual(platformManifest.os, [process.platform]);
    assert.deepEqual(platformManifest.cpu, [process.arch]);
    if (process.platform === 'linux') assert.deepEqual(platformManifest.libc, ['glibc']);
  }
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
  const broad = JSON.parse(run(process.execPath, ['--import', pathToFileURL(hook).href, entry, 'extract', 'broad.ts']));
  assert.equal(broad.path, 'fallback');
  assert.equal(broad.fallback, 'typescript');
  if (!portable) assert.equal(broad.metrics.astNodes, 0);
  else assert.equal(broad.reason, 'native-unavailable');
  assert.deepEqual(broad.candidates.map(candidate => candidate.operator), ['<']);
  writeFileSync(join(cwd, 'module.ts'), 'import { limit } from "./settings"; export function ready(n: number): boolean { return n < limit; }');
  const module = JSON.parse(run(process.execPath, [entry, 'extract', 'module.ts']));
  assert.equal(module.path, portable ? 'fallback' : 'fast');
  if (portable) assert.equal(module.reason, 'native-unavailable');
  assert.deepEqual(module.candidates.map(candidate => candidate.operator), ['<']);
  const condition = 'for (let i = 0; i < values.length; i++) {}';
  writeFileSync(join(cwd, 'control.ts'), condition);
  const nativeControl = JSON.parse(run(process.execPath, [entry, 'extract', 'control.ts']));
  assert.equal(nativeControl.path, portable ? 'fallback' : 'fast');
  writeFileSync(join(cwd, 'ambient.ts'), 'declare const values: Array<number>;\n' + condition);
  const nativeScript = JSON.parse(run(process.execPath, [entry, 'extract', 'ambient.ts', '--mode', 'script']));
  assert.equal(nativeScript.path, portable ? 'fallback' : 'fast');
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
    Targeted: ['fixture', 'src/eligibility.ts', '--test', 'test/eligibility.test.ts', '--spec', 'spec.json', '--deterministic', '--audit'],
    Full: ['fixture', 'src/eligibility.ts', '--mutators', 'full', '--test', 'test/eligibility.test.ts'],
    Witnesses: ['witnesses', 'src/queries.ts', '--witnesses', '--test', 'test/queries.test.ts', '--lines', 'src/queries.ts:5-5'],
  };
  install('vitest@4.0.18');
  // Built-in targeted and full profiles need no external instrumenter package.
  assert.equal(existsSync(join(cwd, 'node_modules/@stryker-mutator')), false);
  const builtIn = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--mutators', 'full', '--test', 'test/eligibility.test.ts']));
  assert.deepEqual([builtIn.evaluation, builtIn.operatorExecution], ['evaluated', 'session']);
  assert.ok(builtIn.mutants.some(mutant => mutant.mutatorName === 'ArrowFunction' && mutant.status === 'killed'));
  assert.ok(builtIn.mutants.some(mutant => mutant.mutatorName === 'EqualityOperator' && mutant.replacement === 'age < 18' && mutant.status === 'killed'));
  assert.ok(builtIn.mutants.some(mutant => mutant.rule === 'comparison-boundary/v1' && mutant.status === 'survived'));
  // The default targeted profile runs from the installed files too, with --suggest-assertions.
  const targeted = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--suggest-assertions',
    '--test', 'test/eligibility.test.ts']));
  assert.deepEqual([targeted.evaluation, targeted.operatorExecution, targeted.mutators], ['evaluated', 'session', 'targeted']);
  assert.ok(targeted.mutants.some(mutant => mutant.rule === 'comparison-boundary/v1' && mutant.status === 'survived'));
  const vitest = join(cwd, 'node_modules/vitest');
  const hiddenVitest = join(cwd, 'hidden-vitest');
  const hiddenPlatform = join(cwd, 'hidden-platform');
  const activeCombinations = portable ? combinations.filter(([, , nativeState]) => nativeState === 'Absent') : combinations;
  for (const [profile, runner, nativeState] of activeCombinations) {
    if (runner === 'Missing') renameSync(vitest, hiddenVitest);
    if (!portable && nativeState === 'Absent') renameSync(platformPackage, hiddenPlatform);
    const localModules = join(cwd, profiles[profile][0], 'node_modules');
    if (runner === 'HoistedWithLocalModules') mkdirSync(localModules);
    const result = spawnSync(process.execPath, [entry, 'analyze', ...profiles[profile]],
      { cwd, encoding: 'utf8', timeout: 240_000 });
    if (runner === 'HoistedWithLocalModules') rmSync(localModules, { recursive: true });
    if (!portable && nativeState === 'Absent') renameSync(hiddenPlatform, platformPackage);
    if (runner === 'Missing') renameSync(hiddenVitest, vitest);
    if (runner === 'Missing') {
      assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
      assert.match(result.stderr, /Install Vitest/);
      continue;
    }
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.evaluation, 'evaluated');
    if (profile === 'Targeted') {
      assert.equal(report.extraction[0].path, nativeState === 'Present' ? 'fast' : 'fallback');
      assert.equal(report.mutants[0].status, 'survived');
      assert.equal(report.mutants[0].audit.status, 'agreed');
      assert.equal(report.mutants[0].evidence, nativeState === 'Present' ? 'predicted' : 'reexecuted');
    } else if (profile === 'Witnesses') {
      assert.ok(report.diagnostics.some(gap => gap.rule === 'first-to-last-index/v1' && gap.verification.status === 'confirmed'));
    } else {
      assert.ok(report.mutants.some(mutant => mutant.mutatorName === 'ArrowFunction' && mutant.status === 'killed'));
    }
  }
  const ordered = JSON.parse(run(process.execPath, [entry, 'analyze', 'witnesses', 'src/text-order.ts',
    '--witnesses', '--test', 'test/text-order.test.ts', '--spec', 'order-spec.json']));
  assert.ok(ordered.diagnostics.some(gap => gap.rule === 'substitute-sort-key/v1' && gap.verification.status === 'confirmed'));
  const discovered = JSON.parse(run(process.execPath, [entry, 'analyze', 'witnesses', 'src/contracts.ts',
    '--witnesses', '--test', 'test/contracts.test.ts']));
  assert.ok(discovered.diagnostics.some(gap => gap.rule === 'paired-source/v1' && gap.verification.status === 'confirmed'));
  assert.ok(discovered.diagnostics.some(gap => gap.borrowedFrom?.method === 'get' && gap.verification.status === 'confirmed'));
  if (!portable) {
    const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64';
    const mismatch = mkdtempSync(join(cwd, 'mismatch-'));
    writeFileSync(join(mismatch, 'package.json'), JSON.stringify({
      name: 'tmt-platform-mismatch', version: '1.0.0', os: platformManifest.os, cpu: [wrongArch],
    }));
    const [{ filename }] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json'], { cwd: mismatch }));
    const denied = invoke(npm, ['install', `file:${relative(cwd, join(mismatch, filename))}`, '--no-audit', '--no-fund']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /EBADPLATFORM/);
    // Without a platform package both extraction and analysis fall back seamlessly to TypeScript.
    renameSync(platformPackage, hiddenPlatform);
    try {
      const portableExtract = JSON.parse(run(process.execPath, [entry, 'extract', 'module.ts']));
      assert.equal(portableExtract.path, 'fallback');
      assert.equal(portableExtract.reason, 'native-unavailable');
      assert.deepEqual(portableExtract.candidates.map(candidate => candidate.operator), ['<']);
      const portableAnalyze = JSON.parse(run(process.execPath, [entry, 'analyze', ...profiles.Targeted]));
      assert.equal(portableAnalyze.evaluation, 'evaluated');
      assert.equal(portableAnalyze.extraction[0].path, 'fallback');
    } finally {
      renameSync(hiddenPlatform, platformPackage);
    }
  }
  // The oldest supported compiler has no generated projection and uses the full parser.
  install('typescript@5.9.3');
  const older = JSON.parse(run(process.execPath, [entry, 'extract', 'broad.ts']));
  assert.equal(older.fallback, 'typescript');
  assert.deepEqual(older.candidates.map(candidate => candidate.operator), ['<']);
  const olderAnalysis = JSON.parse(run(process.execPath, [entry, 'analyze', ...profiles.Targeted]));
  assert.equal(olderAnalysis.mutants[0].evidence, portable ? 'reexecuted' : 'predicted');
  assert.equal(olderAnalysis.mutants[0].audit.status, 'agreed');
  // Verify the packed runtime also works end-to-end with Vitest 5.
  install('vitest@5.1.2');
  const vitest5BuiltIn = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--mutators', 'full', '--test', 'test/eligibility.test.ts']));
  assert.deepEqual([vitest5BuiltIn.evaluation, vitest5BuiltIn.operatorExecution], ['evaluated', 'session']);
  const vitest5Targeted = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--suggest-assertions', '--test', 'test/eligibility.test.ts']));
  assert.deepEqual([vitest5Targeted.evaluation, vitest5Targeted.operatorExecution, vitest5Targeted.mutators], ['evaluated', 'session', 'targeted']);
  const vitest5Audit = JSON.parse(run(process.execPath, [entry, 'analyze', ...profiles.Targeted]));
  assert.equal(vitest5Audit.mutants[0].evidence, portable ? 'reexecuted' : 'predicted');
  assert.equal(vitest5Audit.mutants[0].audit.status, 'agreed');
  console.log(portable
    ? 'Installed portable runtime used the TypeScript fallback and Vitest runner'
    : 'Installed runtime used the native extractor, compiled Lean decision and Vitest audit');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
