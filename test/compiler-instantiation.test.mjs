import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-instantiation.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

for (const row of cases) {
  const [following, type, dialect] = row.split('\t');
  test('standalone instantiation ' + row.replaceAll('\t', ' '), async () => {
    const argument = type === 'Multiline' ? '<\n  number\n>' : '<number>';
    const expression = 'keep' + argument;
    const body = {
      Statement: 'const specialized = ' + expression + ';\nexport const answer = specialized(42);',
      Argument: 'export const answer = [' + expression + ', keep][0](42);',
      Comparison: 'export const answer = (' + expression + ' >= keep) ? 42 : 0;',
    }[following];
    const jsx = dialect === 'TSX' ? 'export const view = () => <i/>;\n' : '';
    const source = 'const keep = <T,>(value: T) => value;\n' + jsx + body;
    const result = compile(source, { file: 'specialized.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.split('\n').length, source.split('\n').length);
    assert.doesNotMatch(result.code, /<\s*number\s*>/);
    assert.equal((await load(result.code)).answer, 42);
  });
}

test('relational operators are preserved when there is a right operand', async () => {
  const source = 'const left: number = 1, middle: number = 2, right: number = 0;\n' +
    'export const answer = left<middle>right;';
  const result = compile(source);
  assert.match(result.code, /left\s*<\s*middle\s*>\s*right/);
  assert.equal((await load(result.code)).answer, true);
});
