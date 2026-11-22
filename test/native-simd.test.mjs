import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const supported = ['arm64', 'x64'].includes(process.arch) && ['darwin', 'linux'].includes(process.platform);
const matrix = readFileSync(new URL('../verification/pict/native-neon-scans.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

test('the native scanner and scalar build return identical packed rows at block boundaries', {
  skip: !supported,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-scalar-scanner-'));
  const destination = join(scratch, 'scalar.node');
  try {
    const build = spawnSync(process.execPath, ['scripts/build-native.mjs', '--scalar-scans', '--output', destination], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(build.status, 0, build.error?.message ?? build.stderr);
    const reference = require(destination);
    const native = require('../build/tmt.node');
    const verify = source => assert.deepEqual(native.parse(source, false, true), reference.parse(source, false, true));
    const opening = { Line: '//', Block: '/*', SingleQuoted: "const text = '", DoubleQuoted: 'const text = "' };
    const closing = { Line: '\n', Block: '*/', SingleQuoted: "';", DoubleQuoted: '";' };
    for (const row of matrix) {
      const [token, stop, position] = row.split('\t');
      const width = { Start: 0, LastLane: 15, NextLane: 16, TwoBlocks: 33 }[position];
      const sentinel = { LF: '\n', CRLF: '\r\n', UnicodeLine: '\u2028', NonSeparatorE2: '€',
        Escape: '\\u0061', Delimiter: closing[token] }[stop];
      verify(Buffer.from(opening[token] + 'q'.repeat(width) + sentinel + 'r'.repeat(33) + closing[token] + '\nconst hit = a < b;'));
    }
    for (let lane = 0; lane < 16; lane++) {
      for (let byte = 0; byte < 256; byte++) {
        for (const token of Object.keys(opening)) {
          const prefix = Buffer.from(opening[token] + 'q'.repeat(lane));
          const suffix = Buffer.from('q'.repeat(32) + closing[token] + '\nconst hit = a > b;');
          verify(Buffer.concat([prefix, Buffer.from([byte]), suffix]));
        }
      }
    }
    for (let width = 0; width <= 48; width++) {
      for (const token of Object.keys(opening)) verify(Buffer.from(opening[token] + 'q'.repeat(width)));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('SIMD specialization declines an unfamiliar scalar function body', { skip: !supported }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-simd-shape-'));
  try {
    mkdirSync(join(scratch, 'scripts'));
    mkdirSync(join(scratch, 'native/generated'), { recursive: true });
    const script = join(scratch, 'scripts/build-native.mjs');
    writeFileSync(script, readFileSync('scripts/build-native.mjs'));
    const compiler = join(scratch, 'compiler');
    writeFileSync(compiler, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const source = args.find(arg => arg.endsWith('/Custard.c') || arg.endsWith('/Custard.simd.c'));
writeFileSync(args[args.lastIndexOf('-o') + 1], source ?? 'probe');
`);
    chmodSync(compiler, 0o700);
    const file = join(scratch, 'native/generated/Custard.c');
    const original = readFileSync('native/generated/Custard.c', 'utf8');
    const anchor = '      bool value = TmtPulseParser_line_break(input, at);';
    const changed = original.replace(anchor, anchor + '\n      value = value || fuel == 3U;');
    assert.notEqual(changed, original);
    for (const [source, expected] of [[original, /Custard\.simd\.c$/], [changed, /\/Custard\.c$/]]) {
      writeFileSync(file, source);
      const build = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, CC: compiler } });
      assert.equal(build.status, 0, build.error?.message ?? build.stderr);
      assert.match(readFileSync(join(scratch, 'build/tmt.node'), 'utf8'), expected);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
