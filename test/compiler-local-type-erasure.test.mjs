import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-local-type-erasure.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

for (const row of rows) {
  const [form, scope, dialect] = row.split('\t');
  test('local type declaration erasure ' + row.replaceAll('\t', ' '), async () => {
    const declaration = {
      Alias: 'type Local = { value: number };',
      Interface: 'interface Local { value: number }',
      Consecutive: 'type NumberAlias = number;\ninterface Local { value: NumberAlias }',
    }[form];
    const body = `${declaration}\nconst output: Local = { value: input };\nreturn output.value;`;
    const source = 'export function run(input: number) {\n' +
      (scope === 'Block' ? `if (input) { ${body} } return 0;\n` : body + '\n') + '}';
    const result = compile(source, { file: dialect === 'TS' ? 'input.ts' : 'input.tsx' });
    assert.equal(result.backend, 'pulse');
    assert.doesNotMatch(result.code, /Local|NumberAlias/);
    assert.equal((await load(result.code)).run(42), 42);
  });
}

test('erasing a local type declaration cannot join adjacent expressions', async () => {
  const source = 'export function run() {\nlet count = 0;\nconst call = () => { count += 10; };\n' +
    'call\ntype Boundary = number\n(count += 1);\nreturn count;\n}';
  const actual = compile(source);
  const reference = compile(source, { sourceMap: true });
  assert.equal(actual.backend, 'pulse');
  assert.equal((await load(actual.code)).run(), 1);
  assert.equal((await load(reference.code)).run(), 1);
});

test('local type erasure declines an uncertain directive or naked control body', () => {
  for (const source of [
    'export function run() { type Local = number; "use client"; return 1; }',
    'export function run() { if (true) type Local = number; return 1; }',
  ]) assert.notEqual(compile(source).backend, 'pulse');
});
