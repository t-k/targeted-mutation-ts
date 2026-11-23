import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-local-overload.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [form, count, dialect] = row.split('\t');
  test('overload with a validated implementation ' + row.replaceAll('\t', ' '), async () => {
    const key = { Method: 'read', Constructor: 'constructor', Local: 'function read' }[form];
    const methodType = form === 'Constructor' ? '' : ': number';
    const signatures = key + '(value: number)' + methodType + ';\n' +
      (count === 'Multiple' ? key + '(value: 42)' + methodType + ';\n' : '');
    const name = form === 'Local' ? 'read' : 'Box';
    const implementation = key + '(value: number)' +
      (form === 'Constructor' ? ' { this.value = value; }\n' : ' { return value; }\n');
    const declaration = {
      Method: 'class Box {\n' + signatures + implementation + '}\n',
      Constructor: 'class Box {\nvalue: number;\n' + signatures + implementation + '}\n',
      Local: signatures + implementation,
    }[form];
    const invocation = { Method: 'new Box().read(42)', Constructor: 'new Box(42).value', Local: 'read(42)' }[form];
    const tail = dialect === 'TSX' ? '\nexport const view = () => <i/>;' : '';
    const source = 'export const answer = () => {\n' + declaration +
      'return { value: ' + invocation + ', name: ' + name + '.name };\n};' + tail;
    const result = compile(source, { file: 'overload.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    assert.doesNotMatch(result.code, /\bvalue\s*:\s*(?:number|42)\b/);
    const { answer } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.deepEqual(answer(), { value: 42, name });
  });
}

test('a class or local overload must match its implementation', () => {
  for (const source of [
    'export class Box { read(x: number): number; other(x: number) { return x; } }',
    'export const run = () => { function read(x: number): number; function other(x: number) { return x; } };',
  ]) assert.notEqual(compile(source).backend, 'pulse');
});
