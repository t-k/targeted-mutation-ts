import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-erased-class-member.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const prefixes = { Local: '', Exported: 'export ', Default: 'export default ' };
const members = {
  DeclaredField: 'declare erased?: number',
  AbstractField: 'protected abstract erased: number',
  AbstractMethod: 'public abstract erased<T>(value: T): T',
};

for (const row of rows) {
  test('committed class member erasure ' + row.replaceAll('\t', ' '), async () => {
    const [placement, member, dialect] = row.split('\t');
    const marker = member === 'DeclaredField' ? '' : 'abstract /* class annotation */ ';
    const exportList = placement === 'Local' ? '\nexport { Record };' : '';
    const jsx = dialect === 'TSX' ? '\nexport const render = () => <i/>;' : '';
    const source = prefixes[placement] + marker + 'class Record {\n  first = 1;\n  ' + members[member] +
      '\n  second = this.first + 1;\n}' + exportList + jsx;
    const result = compile(source, { file: 'entry.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    if (marker) assert.match(result.code, /\/\* class annotation \*\//);
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    const Record = placement === 'Default' ? module.default : module.Record;
    const record = new Record();
    assert.deepEqual(Object.entries(record), [['first', 1], ['second', 2]]);
    assert.equal('erased' in record, false);
  });
}

test('runtime fields and methods named declare and abstract still emit', async () => {
  const source = 'export class Record { declare: number = 42; abstract() { return this.declare; } }';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { Record } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(new Record().abstract(), 42);
});
