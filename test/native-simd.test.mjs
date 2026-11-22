import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const matrix = readFileSync(new URL('../verification/pict/native-neon-scans.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

test('the native scanner and scalar build return identical packed rows at block boundaries', {
  skip: process.arch !== 'arm64',
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
