import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-script-projection.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const scripts = {
  Ambient: 'declare const config: { value: number };\nfunction read() { return config.value; }',
  Annotation: 'function read(): number { return this === undefined ? 42 : 0; }',
  Module: 'export function read(): number { return 42; }',
};

for (const row of rows) {
  test('native script projection ' + row.replaceAll('\t', ' '), async () => {
    const [shape, dialect, representation] = row.split('\t');
    const input = representation === 'Bytes' ? Buffer.from(scripts[shape]) : scripts[shape];
    const result = compile(input, { file: 'entry.' + dialect.toLowerCase() });
    assert.ok(result.code);
    if (shape === 'Module') {
      assert.equal(result.backend, 'pulse');
      const { read } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(read(), 42);
    } else if (dialect === 'TS') {
      assert.equal(result.backend, 'pulse');
      assert.match(result.code, /^"use strict";\n/);
      assert.equal(Function('config', result.code + '\nreturn read();')({ value: 42 }), 42);
    }
  });
}

test('markerless scripts with a significant directive retain the compatibility route', () => {
  const source = '"use arbitrary";\nfunction read(): number { return 42; }';
  assert.notEqual(compile(source).backend, 'pulse');
  assert.match(compile(source).code, /"use arbitrary"/);
});
