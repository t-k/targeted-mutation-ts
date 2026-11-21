import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = resolve(process.argv[2] ?? `build/targeted-mutation-ts-0.1.0-${process.platform}-${process.arch}.tgz`);
const fixture = resolve('fixtures/eligibility');
const cwd = mkdtempSync(join(tmpdir(), 'tmt-pack-test-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const combinations = readFileSync(new URL('../verification/pict/runtime-dependencies.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

try {
  cpSync(fixture, join(cwd, 'fixture'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"name":"tmt-pack-test","version":"1.0.0","private":true}');
  const install = (...packages) => run(npm, ['install', ...packages, '--no-audit', '--no-fund']);
  install(tarball);
  const installed = join(cwd, 'node_modules/targeted-mutation-ts');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@babel/parser': '7.29.15', typescript: '6.0.3' });
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(path => path.startsWith('node_modules/')).sort(),
    ['node_modules/@babel/helper-string-parser', 'node_modules/@babel/helper-validator-identifier',
      'node_modules/@babel/parser', 'node_modules/@babel/types', 'node_modules/targeted-mutation-ts', 'node_modules/typescript']);
  assert.deepEqual(manifest.os, [process.platform]);
  assert.deepEqual(manifest.cpu, [process.arch]);
  mkdirSync(join(installed, 'node_modules/unrelated'), { recursive: true });
  const entry = join(installed, 'bin/tmt.mjs');
  assert.match(run(process.execPath, [entry, '--help']), /tmt-ts analyze/);
  writeFileSync(join(cwd, 'fallback.ts'), 'export const a = 1; export const b = a < 2;');
  const fallback = JSON.parse(run(process.execPath, [entry, 'extract', 'fallback.ts']));
  assert.equal(fallback.path, 'fallback');
  assert.deepEqual(fallback.candidates.map(candidate => candidate.operator), ['<']);
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
        { cwd, encoding: 'utf8', timeout: 60_000 });
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
    name: 'tmt-platform-mismatch', version: '1.0.0', os: manifest.os, cpu: [wrongArch],
  }));
  const packed = spawnSync(npm, ['pack', '--ignore-scripts', '--json'], { cwd: mismatch, encoding: 'utf8', timeout: 60_000 });
  assert.equal(packed.status, 0, packed.error?.message ?? packed.stderr);
  const [{ filename }] = JSON.parse(packed.stdout);
  const denied = spawnSync(npm, ['install', join(mismatch, filename), '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /EBADPLATFORM/);
  console.log('Installed runtime used the native extractor, compiled Lean decision and Vitest audit');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
