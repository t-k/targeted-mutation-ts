import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractYuku } from '../src/extract.mjs';

const badge = 'export const Badge = (n: number) => <Tag title="🐈 > 2" hi={n /* < */ >= 3} />';
const fast = { requireNative: true };

test('the badge uses the generated native path and returns the exact UTF-8 spans', () => {
  const result = extract(badge, { dialect: 'tsx', ...fast });
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, [{
    rule: 'comparison-boundary/v1', operator: '>=', replacement: '>',
    edit: [72, 74], left: [62, 63], right: [75, 76],
  }]);
  assert.equal(result.metrics.astNodes, 0);
  assert.deepEqual(result.candidates, extractYuku(badge, { dialect: 'tsx' }).candidates);
});

const rows = readFileSync(new URL('../verification/pict/m1-extraction.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  test('PICT ' + row.replaceAll('\t', ' / '), () => {
    const [dialect, context, op, trivia] = row.split('\t');
    const operator = { LT: '<', LE: '<=', GT: '>', GE: '>=' }[op];
    const compare = '7 /* comment <= */ ' + operator + ' 8';
    const expression = {
      Value: compare, Parenthesized: '((' + compare + '))', Arrow: '(n: number) => n ' + operator + ' 8',
      Attribute: '<Badge title="🐈 >" valid={' + compare + '} />',
    }[context];
    const source = 'const value = ' + expression + ';' + (trivia === 'CRLF' ? '\r\n' : '');
    const options = { dialect: dialect.toLowerCase(), ...fast };
    const result = extract(source, options);
    assert.equal(result.path, 'fast');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].operator, operator);
    assert.deepEqual(result.candidates, extractYuku(source, options).candidates);
  });
}

test('nested comparisons retain lexical order and parenthesized operand spans', () => {
  const src = 'const x = (2 < 3) <= (4 > 7);';
  const result = extract(src, fast);
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates.map(site => site.operator), ['<', '<=', '>']);
  assert.deepEqual(result.candidates, extractYuku(src).candidates);
});

test('unsupported constructs fall back to Yuku for complete analysis', () => {
  for (const [src, dialect, count] of [
    ['const x = f<number>(2) < 3;', 'ts', 1],
    ['const x = /[<]/.test("a") && 3 / 4 > 0;', 'ts', 1],
    ['const x = `x > < ${2 >= 3}`;', 'ts', 1],
    ['const x = <A><B valid={3 < 5} /></A>;', 'tsx', 1],
    ['const x = ' + '('.repeat(65) + '2 >= 3' + ')'.repeat(65), 'ts', 1],
    ['const x = 2 < 3; const y = 7 > 5;', 'ts', 2],
  ]) {
    const result = extract(src, { dialect, ...fast });
    assert.equal(result.path, 'fallback', src);
    assert.equal(result.candidates.length, count);
  }
});

test('an invalid suffix never returns the first declaration as success', () => {
  for (const source of ['const x = 1 >= 3; const =', 'const x = 1 >= 3; /*', 'const x = 1 >= 3; @']) {
    const result = extract(source, fast);
    assert.equal(result.path, 'diagnostic');
    assert.deepEqual(result.candidates, []);
    assert.ok(result.diagnostics.length);
  }
});

test('empty files, resource caps, script mode, and invalid UTF-8 have distinct paths', () => {
  assert.equal(extract(' // trivia\r\n', fast).path, 'fast');
  assert.equal(extract(' '.repeat(1_048_577), fast).reason, 'source-limit');
  assert.equal(extract('export const x = 1 < 3', { mode: 'script', ...fast }).path, 'diagnostic');
  assert.equal(extract(Buffer.from([0xff]), fast).path, 'diagnostic');
});

test('legal identifier reads and ArrayBuffer inputs use the native parser', () => {
  for (const word of ['eval', 'arguments']) {
    const source = 'const item = ' + word + ' < 2';
    const encoded = new TextEncoder().encode(source);
    for (const input of [Buffer.from(encoded), encoded, encoded.buffer]) {
      const result = extract(input, fast);
      assert.equal(result.path, 'fast');
      assert.deepEqual(result.candidates, extractYuku(input).candidates);
    }
  }
  assert.equal(extract('const eval = 2 < 3', fast).path, 'diagnostic');
});

test('native grammar recognizes web-standard hyphenated JSX attribute names', () => {
  const source = 'export const button = (age: number) => <button aria-label="Continue" disabled={age < 18} />;';
  const result = extract(source, { dialect: 'tsx', ...fast });
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, extractYuku(source, { dialect: 'tsx' }).candidates);
});

const encodingRows = readFileSync(new URL('../verification/pict/extraction-bytes.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of encodingRows) {
  test('encoding ' + row.replaceAll('\t', ' / '), () => {
    const [kind, text, syntax] = row.split('\t');
    const caption = text === 'ASCII' ? 'yes' : '🐈';
    const prefix = syntax === 'Fallback' ? 'const other = 1;\n' : '';
    const source = prefix + 'const view = <Tag text="' + caption + '" show={2 <= 3} />;';
    const storage = Uint8Array.from([...Buffer.from(source), ...(text === 'Invalid' ? [255] : [])]);
    const input = {
      String: source + (text === 'Invalid' ? '\ud800' : ''),
      Buffer: Buffer.from(storage),
      Uint8: storage,
      DataView: new DataView(storage.buffer),
      ArrayBuffer: storage.buffer,
    }[kind];
    const result = extract(input, { dialect: 'tsx', ...fast });
    const reference = extractYuku(input, { dialect: 'tsx' });
    assert.deepEqual(result.candidates, reference.candidates);
    assert.equal(result.path, text === 'Invalid' ? 'diagnostic' : syntax === 'L1' ? 'fast' : 'fallback');
  });
}

test('native byte input is validated without decoding it to a JavaScript string', () => {
  const decode = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = () => { throw new Error('Unexpected UTF-16 conversion'); };
  try {
    const result = extract(Buffer.from('const x = 17 >= 18'), fast);
    assert.equal(result.path, 'fast');
    assert.equal(result.candidates[0].operator, '>=');
  } finally {
    TextDecoder.prototype.decode = decode;
  }
});

test('candidate capacity grows once while preserving order and never leaks a partial failure', () => {
  const options = { dialect: 'tsx', ...fast };
  for (const count of [16, 17, 4096, 4097]) {
    const source = 'const view = <Tag ' + Array.from({ length: count }, (_, index) =>
      'a' + index + '={' + index + ' < ' + (index + 1) + '}').join(' ') + ' />;';
    const result = extract(source, options);
    assert.equal(result.path, count === 4097 ? 'fallback' : 'fast');
    if (count === 4097) assert.equal(result.reason, 'candidate-limit');
    assert.equal(result.candidates.length, count);
    assert.deepEqual(result.candidates, extractYuku(source, options).candidates);
  }
});
