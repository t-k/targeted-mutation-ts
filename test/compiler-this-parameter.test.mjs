import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-this-parameter.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [form, following, dialect] = row.split('\t');
  test('type-only function receiver ' + row.replaceAll('\t', ' '), async () => {
    const suffix = { Only: '', Variable: ', value: number', Default: ', value = 5' }[following];
    const args = '(this: { count: number } /* keep the line count */\n' + suffix + ')';
    const body = ' { return this.count' + (following === 'Only' ? '' : ' + value') + '; }';
    const source = form === 'Function' ? 'export function read' + args + body :
      form === 'Method' ? 'export const read = { read' + args + body + ' }.read;' :
      'export const read = function ' + args + body + ';';
    const result = compile(source, { file: 'receiver.' + dialect.toLowerCase() });
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /this\s*:/);
    const { read } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(read.length, following === 'Variable' ? 1 : 0);
    assert.equal(read.call({ count: 37 }, ...(following === 'Variable' ? [5] : [])),
      following === 'Only' ? 37 : 42);
  });
}

test('constructor and arrow receivers stay off native erasure', () => {
  for (const source of [
    'export class C { constructor(this: C) {} }',
    'export const f = (this: { value: number }) => 1;',
  ]) assert.notEqual(compile(source).backend, 'pulse');
});
