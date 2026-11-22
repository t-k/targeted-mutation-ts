import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const load = createRequire(import.meta.url);
const matrix = readFileSync(new URL('../verification/pict/native-profile.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));

test('fixture PGO preserves the normal and standalone native result records', () => {
  const profiler = process.platform === 'darwin' ?
    spawnSync('/usr/bin/xcrun', ['--find', 'llvm-profdata'], { encoding: 'utf8' }).stdout?.trim() :
    process.env.TMT_LLVM_PROFDATA;
  assert.ok(profiler, 'Provide the matching llvm-profdata executable');
  const root = mkdtempSync(join(tmpdir(), 'tmt-native-profile-'));
  const source = Buffer.from('export const keep = a < b; export const view = <Item count={n >= min} />;');
  const invalid = Buffer.from('const before = a > b; const =');
  try {
    cpSync(resolve('native'), join(root, 'native'), { recursive: true });
    cpSync(resolve('fixtures'), join(root, 'fixtures'), { recursive: true });
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    cpSync(resolve('scripts/build-native.mjs'), join(scripts, 'build-native.mjs'));
    cpSync(resolve('scripts/train-native.mjs'), join(scripts, 'train-native.mjs'));
    const outputs = [];
    for (const [index, [profile, tool, mode]] of matrix.entries()) {
      const args = [
        join(scripts, 'build-native.mjs'), ...(profile === 'Enabled' ? ['--pgo'] : []),
        ...(mode === 'Standalone' ? ['--low-only'] : []),
      ];
      const result = spawnSync(process.execPath, args, {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, TMT_LLVM_PROFDATA: tool === 'Present' ? profiler : join(root, 'missing-profiler') },
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
      const applied = profile === 'Enabled' && tool === 'Present';
      assert.equal(result.stdout.includes('Built native extractor with fixture PGO'), applied);
      const target = join(root, 'build', `variant-${index}.node`);
      renameSync(join(root, 'build/tmt.node'), target);
      const addon = load(target);
      assert.equal(!!addon.standalone, mode === 'Standalone');
      outputs.push([addon.parse(source, true, true), addon.parse(invalid, false, true)]);
    }
    for (const actual of outputs) assert.deepEqual(actual, outputs[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted compiler leaves the previous addon intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-native-profile-failure-'));
  const scripts = join(root, 'scripts');
  const build = join(root, 'build');
  try {
    mkdirSync(scripts);
    mkdirSync(build);
    cpSync(resolve('scripts/build-native.mjs'), join(scripts, 'build-native.mjs'));
    const artifact = join(build, 'tmt.node');
    writeFileSync(artifact, 'last usable addon');
    const compiler = join(root, 'compiler');
    writeFileSync(compiler, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.argv[process.argv.lastIndexOf('-o') + 1], 'incomplete addon');
process.exitCode = 3;
`);
    chmodSync(compiler, 0o700);
    const result = spawnSync(process.execPath, [join(scripts, 'build-native.mjs')], {
      cwd: root, env: { ...process.env, CC: compiler }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 3, result.error?.message ?? result.stderr);
    assert.equal(readFileSync(artifact, 'utf8'), 'last usable addon');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
