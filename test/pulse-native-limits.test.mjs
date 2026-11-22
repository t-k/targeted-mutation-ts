import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const inputs = {
  Whitespace: ['', ' ', ''],
  LineComment: ['//', 'a', ''],
  BlockComment: ['/*', 'a', '*/'],
  EmptyStatements: ['', ';', ''],
  Regex: ['const re = /', 'a', '/;'],
  Identifier: ['const ', 'a', ' = low < high;'],
};
const sizes = { Small: 64, Limit: 1024 * 1024, OverLimit: 1024 * 1024 + 1 };
const rows = readFileSync(new URL('../verification/pict/pulse-native-limits.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
const addon = new URL('../build/tmt.node', import.meta.url);

for (const [kind, size, dialect] of rows) test(`native limits ${kind} ${size} ${dialect}`, () => {
  const [prefix, byte, suffix] = inputs[kind];
  const source = `const { createRequire } = require('node:module');
const addon = createRequire(${JSON.stringify(addon.href)})('./tmt.node');
const [prefix, byte, suffix] = ${JSON.stringify([prefix, byte, suffix])};
const input = Buffer.from(prefix + byte.repeat(${sizes[size]} - prefix.length - suffix.length) + suffix);
console.log(JSON.stringify([...addon.parse(input, ${dialect === 'TSX'}, true)]));`;
  const child = spawnSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.signal ?? child.stderr);
  const [status, , astNodes, , ...candidates] = JSON.parse(child.stdout);
  const expectedStatus = size === 'OverLimit' ? 2 : 0;
  assert.equal(status, expectedStatus);
  assert.equal(astNodes, 0);
  assert.equal(candidates.length, kind === 'Identifier' && size !== 'OverLimit' ? 8 : 0);
});
