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

test('a comparison with a flat right operand can begin a ternary or logical expression', async () => {
  for (const [tail, below, above] of [
    ['? (value as number) : -1', 2, -1],
    ['&& (value as number)', 2, false],
    ['|| (value as number)', true, 3],
  ]) {
    const source = 'export function pick(value: number, limit: number) {\n' +
      `  return value < limit ${tail};\n}`;
    const result = compile(source);
    assert.equal(result.backend, 'pulse', tail);
    const { pick } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
    assert.equal(pick(2, 3), below);
    assert.equal(pick(3, 2), above);
  }
});

test('bounded comparison lookahead respects nested delimiters and a possible type closer', async () => {
  const source = 'export const within = (value: number, limit: number) => value < (limit + 1);';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { within } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(within(4, 4), true);
  assert.equal(within(5, 4), false);

  const generic = 'function id<T>(value: T): T { return value; }\nexport const result = id < [number] > ([5]);';
  const bridged = compile(generic);
  assert.notEqual(bridged.backend, 'pulse');
  assert.ok(bridged.code);
});

test('arithmetic comparison and contextual inequality remain ordinary JavaScript', async () => {
  const source = 'export function valid(value: number, limit: number, type: number) {\n' +
    '  return value < limit + 1 && value > 0 && type !== 8;\n}';
  const result = compile(source);
  assert.equal(result.backend, 'pulse');
  const { valid } = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(valid(2, 3, 4), true);
  assert.equal(valid(2, 3, 8), false);
  assert.equal(valid(4, 3, 4), false);
});
