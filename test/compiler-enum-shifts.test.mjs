import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-enum-shifts.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);

for (const row of cases) {
  const [shift, operands, dialect] = row.split('\t');
  test('constant enum shift ' + row.replaceAll('\t', ' '), async () => {
    const [value, count] = { Positive: [1, 1], Signed: [-2147483648, 1],
      Wrap: [4294967297, -1], Unsigned: [-1, 0] }[operands];
    const operator = { Left: '<<', SignedRight: '>>', UnsignedRight: '>>>' }[shift];
    const expected = shift === 'Left' ? value << count :
      shift === 'SignedRight' ? value >> count : value >>> count;
    const suffix = dialect === 'TSX' ? '\nexport const view = () => <i>{Flags.Bit}</i>;' : '';
    const source = 'export enum Flags { Bit = ' + value + ' /* shift */ ' + operator + ' ' + count + ', Next }' + suffix;
    const result = compile(source, { file: 'flags.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /<<|>>/);
    const { Flags } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(Flags.Bit, expected);
    assert.equal(Flags[expected], 'Bit');
    assert.equal(Flags.Next, expected + 1);
    assert.equal(Flags[expected + 1], 'Next');
  });
}

test('operators beyond one literal shift remain on compatibility', () => {
  const result = compile('export enum Flags { A = 1 << 1 << 2, B }');
  assert.notEqual(result.backend, 'pulse');
});
