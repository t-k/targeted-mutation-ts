import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-arrow-result.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [head, result, dialect] = row.split('\t');
  test('arrow return type ' + row.replaceAll('\t', ' '), async () => {
    const params = { Empty: '()', Parameters: '(value: number)', AsyncGeneric: 'async <T,>(value: T)' }[head];
    const type = { Simple: 'number', MultilineObject: '{\n  value: number;\n}',
      MultilineUnion: '\n  number\n  | string' }[result];
    const value = head === 'Empty' ? '42' : 'value';
    const body = result === 'MultilineObject' ? '({ value: ' + value + ' })' : value;
    const jsx = dialect === 'TSX' ? 'export const view = () => <i/>;\n' : '';
    const source = jsx + 'export const read = ' + params + ' /* retain */: ' + type + ' /* tail */ => ' + body + ';\n';
    const emitted = compile(source, { file: 'arrow.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(emitted.backend, 'pulse', source);
    assert.equal(emitted.code.split('\n').length, source.split('\n').length);
    assert.match(emitted.code, /\/\* retain \*\//);
    assert.match(emitted.code, /\/\* tail \*\//);
    const { read } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
    assert.equal(read.length, head === 'Empty' ? 0 : 1);
    assert.deepEqual(await read(42), result === 'MultilineObject' ? { value: 42 } : 42);
  });
}

test('a conditional colon does not publish a speculative return type', async () => {
  const source = 'export const read = (flag: boolean) => flag ? (1) : (2);';
  const emitted = compile(source);
  assert.equal(emitted.backend, 'pulse');
  const { read } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
  assert.equal(read(false), 2);
  assert.equal(read(true), 1);
});

test('nested defaults retain their delimiters and CRLF inside erased return types', async () => {
  const source = 'export const read = (value = (): /* erased\r\n content */ number => 42)' +
    ': {\r\n value: number;\r\n} => ({ value: value() });\r\n';
  const emitted = compile(source);
  assert.equal(emitted.backend, 'pulse');
  assert.equal(emitted.code.match(/\r\n/g).length, source.match(/\r\n/g).length);
  const { read } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
  assert.deepEqual(read(), { value: 42 });
});
