import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-default-overload.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [signatures, flavor, dialect] = row.split('\t');
  test('default function overload ' + row.replaceAll('\t', ' '), async () => {
    const declaration = 'export default ' + (flavor === 'Async' ? 'async ' : '') + 'function read';
    const returnType = type => flavor === 'Async' ? 'Promise<' + type + '>' : type;
    const jsx = dialect === 'TSX' ? 'export const view = () => <i/>;\n' : 'export const previous = 1;\n';
    const source = jsx + declaration + '(value: number): ' + returnType('number') + ';\n' +
      (signatures === 'Multiple' ? declaration + '(value: string): ' + returnType('string') + ';\n' : '') +
      '/* keep the implementation comment */\n' +
      declaration + '(value: number | string): ' + returnType('number | string') + ' { return value; }\n';
    const emitted = compile(source, { file: 'overload.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(emitted.backend, 'pulse', source);
    assert.equal(emitted.code.match(/export default/g).length, 1);
    assert.equal(emitted.code.split('\n').length, source.split('\n').length);
    assert.match(emitted.code, /keep the implementation comment/);
    const { default: read } = await import('data:text/javascript;base64,' + Buffer.from(emitted.code).toString('base64'));
    assert.equal(await read('value'), 'value');
    assert.equal(read.name, 'read');
    assert.equal(read.constructor.name, flavor === 'Async' ? 'AsyncFunction' : 'Function');
  });
}

test('an assertion overload is erased before the default implementation', () => {
  const source = 'export default function assert(value: unknown): asserts value;\n' +
    'export default function assert(value: unknown) { if (!value) throw new Error(); }';
  const emitted = compile(source);
  assert.equal(emitted.backend, 'pulse');
  assert.doesNotMatch(emitted.code, /asserts value/);
});

test('incomplete or mismatched default overloads do not commit', () => {
  const signature = 'export default function read(value: number): number;';
  for (const suffix of ['', '\nexport default function write(value: number) { return value; }']) {
    assert.notEqual(compile(signature + suffix).backend, 'pulse');
  }
});
