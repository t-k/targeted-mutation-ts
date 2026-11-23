import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-optional-method.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const signatures = {
  Ordinary: 'check?(): void',
  Generic: 'check?<T>(value: T): T',
  OptionalParameter: 'check?(value?: number): number',
};
const endings = { Semicolon: ';\n  next() { return 42; }', Line: '\n  next() { return 42; }', ClosingBrace: '' };

for (const row of rows) {
  test('optional method erasure ' + row.replaceAll('\t', ' '), async () => {
    const [shape, ending, dialect] = row.split('\t');
    const source = 'export class Value {\n  field?: number;\n  ' + signatures[shape] + endings[ending] + '\n}' +
      (dialect === 'TSX' ? '\nexport const render = () => <i/>;' : '');
    const result = compile(source, { file: 'entry.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    const { Value } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    const value = new Value();
    assert.deepEqual(Object.keys(value), ['field']);
    assert.equal('check' in value, false);
    if (ending !== 'ClosingBrace') assert.equal(value.next(), 42);
  });
}

test('optional methods with an implementation retain their runtime body', async () => {
  const source = 'export class Value { check?(): number { return 42; } }';
  const result = compile(source, { file: 'entry.ts' });
  assert.ok(result.code);
  const { Value } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(new Value().check(), 42);
});
