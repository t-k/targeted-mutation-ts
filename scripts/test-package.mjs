import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = resolve(process.argv[2] ?? `build/targeted-mutation-ts-0.1.0-${process.platform}-${process.arch}.tgz`);
const fixture = resolve('fixtures/eligibility');
const cwd = mkdtempSync(join(tmpdir(), 'tmt-pack-test-'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}

try {
  cpSync(fixture, join(cwd, 'fixture'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"name":"tmt-pack-test","version":"1.0.0","private":true}');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', tarball, '--no-audit', '--no-fund']);
  const installed = join(cwd, 'node_modules/targeted-mutation-ts');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.os, [process.platform]);
  assert.deepEqual(manifest.cpu, [process.arch]);
  mkdirSync(join(installed, 'node_modules/unrelated'), { recursive: true });
  const entry = join(installed, 'bin/tmt.mjs');
  assert.match(run(process.execPath, [entry, '--help']), /tmt-ts analyze/);
  const report = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--spec', 'spec.json', '--deterministic', '--audit']));
  assert.equal(report.extraction[0].path, 'fast');
  assert.equal(report.mutants[0].evidence, 'predicted');
  assert.equal(report.mutants[0].audit.status, 'agreed');
  const standard = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/eligibility.ts', '--mutators', 'standard']));
  assert.equal(standard.evaluation, 'evaluated');
  assert.ok(standard.mutants.some(mutant => mutant.mutatorName === 'EqualityOperator' && mutant.status === 'survived'));
  writeFileSync(join(cwd, 'fixture/src/strict.ts'), 'export const positive = (count: number) => count > 0;');
  writeFileSync(join(cwd, 'fixture/test/strict.test.ts'), "import { expect, it } from 'vitest'; import { positive } from '../src/strict'; it('checks two', () => expect(positive(2)).toBe(true));");
  const combined = JSON.parse(run(process.execPath, [entry, 'analyze', 'fixture', 'src/strict.ts',
    '--mutators', 'all', '--deterministic', '--test', 'test/strict.test.ts']));
  assert.equal(combined.evaluation, 'evaluated');
  assert.ok(combined.mutants.some(mutant => mutant.evidence === 'predicted'));
  assert.ok(combined.mutants.some(mutant => mutant.rule === 'comparison-tighten/v1' && mutant.status === 'survived'));
  const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  const mismatch = mkdtempSync(join(cwd, 'mismatch-'));
  writeFileSync(join(mismatch, 'package.json'), JSON.stringify({
    name: 'tmt-platform-mismatch', version: '1.0.0', os: manifest.os, cpu: [wrongArch],
  }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
