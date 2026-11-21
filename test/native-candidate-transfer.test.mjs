import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const load = createRequire(import.meta.url);
const addon = load('../build/tmt.node');
const edits = { Empty: 0, Direct: 16, Retry: 17, Capacity: 4096, OverCapacity: 4097, BadSuffix: 2 };
const rows = readFileSync(new URL('../verification/pict/native-candidate-transfer.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [outcome, dialect, encoding] = row.split('\t');
  test(`native candidate transfer: ${outcome} ${dialect} ${encoding}`, () => {
    const expression = dialect === 'TSX' ? 'visit(<Box show={x < y} />);\n' : 'visit(x < y);\n';
    const prefix = encoding === 'UTF8' ? '/* 海 🧪 */\n' : '/* ASCII */\n';
    const source = Buffer.from(prefix + expression.repeat(edits[outcome]) + (outcome === 'BadSuffix' ? 'const =' : ''));
    const native = addon.parse(source, dialect === 'TSX', true);
    assert.ok(native instanceof Uint32Array);
    const expectedStatus = outcome === 'BadSuffix' ? 1 : outcome === 'OverCapacity' ? 4 : 0;
    assert.equal(native[0], expectedStatus);
    assert.equal(native[2], 0);
    const options = { dialect: dialect.toLowerCase(), requireNative: true };
    const actual = extract(source, options);
    const reference = extractFallback(source, options);
    assert.deepEqual(actual.candidates, reference.candidates);
    assert.deepEqual(actual.diagnostics, reference.diagnostics);
    assert.equal(native.length, 4 + (expectedStatus === 0 ? 8 * edits[outcome] : 0));
    assert.equal(native[3], actual.metrics.candidateBytes);
    if (edits[outcome] > 16) assert.ok(native[3] > 0);
    if (expectedStatus === 0 && edits[outcome]) {
      const site = actual.candidates[0];
      assert.deepEqual(Array.from(native.subarray(4, 12)), [1, 2, ...site.edit, ...site.left, ...site.right]);
    }
  });
}

test('a stale native candidate layout fails before reading offsets', () => {
  const current = addon.parse;
  try {
    addon.parse = () => [0, 0, 0, 0, [1, 2, 16, 17, 14, 15, 18, 19]];
    assert.throws(() => extract('const value = a < b;'), /npm run build:native/);
  } finally {
    addon.parse = current;
  }
});
