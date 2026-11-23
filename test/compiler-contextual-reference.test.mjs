import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-contextual-reference.tsv', import.meta.url), 'utf8')
  .trimEnd().split(/\r?\n/).slice(1);
const expressions = {
  Assignment: key => key,
  Conditional: key => 'flag ? 0 : ' + key,
  Group: key => '(' + key + ')',
};
const names = { As: 'as', Satisfies: 'satisfies', Type: 'type', Namespace: 'namespace' };

for (const row of rows) {
  test('committed contextual reference ' + row.replaceAll('\t', ' '), async () => {
    const [spelling, context, dialect] = row.split('\t');
    const key = names[spelling];
    const source = 'import { value as ' + key + ' } from "data:text/javascript,export%20const%20value%3D42%3B";\n' +
      'export function answer(flag: boolean): number {\n  let result;\n  result = ' +
      expressions[context](key) + '\n  if (flag) return 0;\n  return result;\n}' +
      (dialect === 'TSX' ? '\nexport const view = () => <i/>;' : '');
    const result = compile(source, { file: 'entry.' + dialect.toLowerCase(), jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    const { answer } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(answer(false), 42);
    assert.equal(answer(true), 0);
  });
}

test('the same spelling still supports type declarations and assertions in the same source', async () => {
  const source = 'type Answer = number;\n' +
    'export function answer(value: unknown): Answer {\n  const type: number = value as number;\n' +
    '  const result = type\n  if (result) return result;\n  return 0;\n}';
  const result = compile(source, { file: 'entry.ts' });
  assert.equal(result.backend, 'pulse');
  assert.doesNotMatch(result.code, /type Answer|as number/);
  const { answer } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(answer(42), 42);
});

test('extended runtime escapes keep subsequent comments outside the ambiguity scan', async () => {
  const source = "export const replacement: string = '\\ufffd';\n" +
    '// The same name appears as an import alias.\n' +
    'export const answer: number = 42;';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(loaded.replacement, '\ufffd');
  assert.equal(loaded.answer, 42);
});
