import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const rows = readFileSync(new URL('../verification/pict/compiler-lexical-regions.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const prefix = 'const React = { createElement: (_tag, _props, child) => child };\n' +
  'const identity = (value: number) => value;\n' +
  'const passthrough = (parts, value) => parts[0] + value + parts[1];\n';

for (const row of rows) {
  const [template, location, syntax] = row.split('\t');
  test('TSX lexical projection ' + row.replaceAll('\t', ' '), async () => {
    const value = syntax === 'Assertion' ? '(5 as number)' : 'identity<number>(5)';
    const base = '\x60<x as y>' + '${' + value + '}</x>\x60';
    const text = template === 'Tagged' ? 'passthrough' + base : template === 'Nested' ? '\x60${' + base + '}\x60' : base;
    const source = prefix + {
      Before: `const rendered: string = ${text};\n// preserve this as a comment\nexport const View = () => <i>{rendered}</i>;`,
      Inside: `export const View = () => <i>{${text}}</i>;\n// preserve this as a comment\nconst n: number = 0;`,
      After: `const fragment = <i>type as a word</i>;\nconst rendered: string = ${text};\n// preserve this as a comment\nexport const View = () => rendered;`,
    }[location];
    const result = compile(source, { file: 'template.tsx', jsx: 'classic' });
    assert.equal(result.backend, 'pulse', source);
    const { View } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(View(), '<x as y>5</x>');
  });
}

test('an ambiguous generic inside a template substitution stays on compatibility parsing', () => {
  const source = prefix + 'const text = `value ${identity < number > (5)}`;\nexport const View = () => <i>{text}</i>;';
  const result = compile(source, { file: 'template.tsx', jsx: 'classic' });
  assert.notEqual(result.backend, 'pulse');
  assert.ok(result.code);
});

test('division does not hide the lexical context of a later TSX comment', async () => {
  const source = prefix + 'const quotient: number = identity(10) / 2;\n' +
    '// preserve this as a comment after division\nexport const View = () => <i>{quotient}</i>;';
  const result = compile(source, { file: 'division.tsx', jsx: 'classic' });
  assert.equal(result.backend, 'pulse');
  const { View } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(View(), 5);
});

test('a comparison with a flat right operand can begin a ternary', async () => {
  const source = 'export function pick(value: number, limit: number) {\n' +
    '  return value < limit ? (value as number) : -1;\n}';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { pick } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(pick(2, 3), 2);
  assert.equal(pick(3, 2), -1);
});
