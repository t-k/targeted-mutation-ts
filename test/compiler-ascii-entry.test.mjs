import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compile } from '../src/compiler.mjs';

const require = createRequire(import.meta.url);
const native = require('../build/compiler.node');
const cases = readFileSync(new URL('../verification/pict/compiler-ascii-entry.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [representation, encoding, mode] = row.split('\t');
  test('direct compiler input ' + row.replaceAll('\t', ' '), () => {
    const source = encoding === 'ASCII' ? 'export const value: number = 42;' :
      encoding === 'UTF8' ? 'export /* café */ const value: number = 42;' :
        'export /* \uD800 */ const value: number = 42;';
    const bytes = Buffer.from(source);
    if (encoding === 'Invalid') bytes[source.indexOf('\uD800')] = 0x80;
    let input = bytes;
    if (representation === 'String') input = source;
    if (representation === 'Unaligned') {
      input = Buffer.alloc(bytes.length + 1).subarray(1);
      input.set(bytes);
    }
    if (representation === 'Shared') {
      input = Buffer.from(new SharedArrayBuffer(bytes.length));
      input.set(bytes);
    }
    const result = compile(input, { mode: mode.toLowerCase() });
    if (encoding === 'Invalid') {
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'INVALID_ENCODING');
    } else {
      assert.equal(result.code, stripTypeScriptTypes(source));
    }
    if (typeof input !== 'string') {
      const direct = native.compileAscii(input);
      assert.equal(direct, encoding === 'ASCII' && representation !== 'Shared' ? result.code : undefined);
    }
  });
}

test('direct emission accepts ordinary cross-realm backing storage after validation', () => {
  const source = 'export const value: number = 42;';
  const input = Buffer.from(runInNewContext('new ArrayBuffer(size)', { size: source.length }));
  input.write(source);
  assert.equal(native.compileAscii(input), stripTypeScriptTypes(source));
  assert.equal(compile(input).code, stripTypeScriptTypes(source));
});

test('a failed direct declaration plan reaches native whole-module emission', () => {
  const source = Buffer.from('export const value = String(42);');
  assert.equal(native.compileAscii(source), null);
  assert.equal(compile(source).code, source.toString());
});
