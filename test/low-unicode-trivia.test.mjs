import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const contents = { ASCII: 'bounds; fake < if () {}', CJK: '雪山の境界', Emoji: '📦 → 🦋' };
const endings = { LF: '\n', CR: '\r', CRLF: '\r\n', LS: '\u2028', PS: '\u2029' };
const positions = {
  Before: comment => `${comment}const ok = a < b; record(c >= d);`,
  Between: comment => `const ok = a ${comment}< b; record(c >= d);`,
  After: comment => `const ok = a < b; ${comment}record(c >= d);`,
};
const rows = readFileSync(new URL('../verification/pict/low-unicode-trivia.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, end, position] = row.split('\t');
  test(`Low* Unicode trivia: ${kind} ${end} ${position}`, () => {
    compare(positions[position](`// ${contents[kind]}${endings[end]}`), 'fast');
  });
}

test('Unicode separators participate in restricted productions and ASI', () => {
  for (const end of [endings.LS, endings.PS]) {
    compare(`function f() { return // 🐈${end}a < b; }`, 'fast');
    compare(`let a = 1${end}++a; const b = a > 1;`, 'fast');
    compare(`const ok = a < b // 🌿${end}const limit = c >= d`, 'fast');
    compare(`function f() { throw // 🐈${end}value; }`, 'diagnostic');
    compare(`const f = async // 🐈${end}() => a < b;`, 'diagnostic');
    compare(`const ok = a < b; // 🐈${end}const =`, 'diagnostic');
  }
  compare('const ok = a < b; // 🌿', 'fast');
  compare('const ok = "// 🌿" !== s && a < b;', 'fast');
});

test('the UTF-8 input check rejects malformed bytes in line comments', () => {
  const source = Buffer.concat([Buffer.from('const ok = a < b; // '), Buffer.from([0xe2, 0x80])]);
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'diagnostic');
  assert.equal(result.reason, 'invalid-utf8');
  assert.deepEqual(result.candidates, []);
});
