import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-class-field-boundary.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [name, annotation, dialect] = row.split('\t');
  test('implicit typed class field boundary ' + row.replaceAll('\t', ' '), async () => {
    const key = name.toLowerCase();
    const marker = { Plain: '', Definite: '!', Optional: '?', BareOptional: '?' }[annotation];
    const type = annotation === 'BareOptional' ? '' : ': number';
    const jsx = dialect === 'TSX' ? '\nexport const view = () => <i/>;' : '';
    const source = 'export class Record {\n  ' + key + marker + type + '\n  next: number = 42\n  final = 43\n}' + jsx;
    const result = compile(source, { file: 'fields.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    const { Record } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    const record = new Record();
    assert.deepEqual(Object.keys(record), [key, 'next', 'final']);
    assert.equal(record[key], undefined);
    assert.equal(record.next, 42);
    assert.equal(record.final, 43);
  });
}

test('class field boundary preserves earlier JSX and a following JSX initializer', async () => {
  const source = 'const React = { createElement: tag => tag };\n' +
    'const before = <i/>;\nexport class Record {\n  static?: /* multiline\n comment */ number\n' +
    '  first = before\n  next: string = <b/>\n}';
  const result = compile(source, { file: 'fields.tsx', jsx: 'classic' });
  assert.equal(result.backend, 'pulse');
  assert.equal(result.code.split('\n').length, source.split('\n').length);
  const { Record } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  const record = new Record();
  assert.deepEqual(Object.keys(record), ['static', 'first', 'next']);
  assert.equal(record.first, 'i');
  assert.equal(record.next, 'b');
});
