import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const cases = readFileSync(new URL('../verification/pict/compiler-contextual-values.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

for (const row of cases) {
  const [name, form, dialect] = row.split('\t');
  test('retained contextual name ' + row.replaceAll('\t', ' '), async () => {
    const key = name.toLowerCase();
    const object = form === 'Key' ? '{ ' + key + ': 42 }' : '{ "' + key + '": 42 }';
    const expression = form === 'Key' ? 'Object.values(data)[0]' : 'data' + (form === 'OptionalDot' ? '?.' : '.') + key;
    const jsx = dialect === 'TSX' ? 'export const view = () => <i/>;\n' : '';
    const source = jsx + 'const data: Record<string, number> = ' + object + ';\n' +
      'export const answer = ' + expression + ';';
    const result = compile(source, { file: 'context.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    assert.equal((await load(result.code)).answer, 42);
  });
}

test('guarded contextual names remain callable, conditional and computed', async () => {
  const source = 'const type: string = "value";\nconst namespace: boolean = true;\n' +
    'const declare = (value: number) => value;\nconst object = { value: 42 };\n' +
    'export const answer = namespace ? declare(object[type]) : 0;';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.equal((await load(result.code)).answer, 42);
});

test('an assertion is still erased rather than kept as a contextual name', async () => {
  const source = 'const options = { as: 42 } satisfies { as: number };\n' +
    'export const answer = (options.as as number);';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  assert.doesNotMatch(result.code, /satisfies\b|as number/);
  assert.equal((await load(result.code)).answer, 42);
});
