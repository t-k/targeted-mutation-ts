import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast, file = 'types.ts') {
  const options = { file, logical: true };
  const native = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(native.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(native.candidates, reference.candidates, source);
  assert.deepEqual(native.diagnostics, reference.diagnostics, source);
}

const heads = {
  Generic: '<T extends Box<Ready> = Box<Ready>,>(value: T, ...rest: T[])',
  Constructor: 'new <T>(value: T)',
  AbstractConstructor: 'abstract\n/* retained */ new (value?: Ready)',
};
const uses = {
  Alias: signature => `type Handle = ${signature};\nconst keep = a < b;`,
  Annotation: signature => `const handle: ${signature} = value;\nconst keep = a > b;`,
  Assertion: signature => `const keep = (value as ${signature}) >= limit;`,
  TSX: signature => `const keep = <div>{(value as ${signature}) <= limit}</div>;`,
};
const tails = {
  Complete: '=> Ready<T>',
  MissingArrow: '= > Ready<T>',
  MissingReturn: '=>',
  Nested: '=> Ready<Box<T>>',
};

const rows = readFileSync(new URL('../verification/pict/low-signature-types.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [kind, use, tail] = row.split('\t');
  test(`Low* signature type: ${kind} ${use} ${tail}`, () => {
    const source = `/* 海 */\nconst before = left >= right;\n${uses[use](`${heads[kind]} ${tails[tail]}`)}`;
    compare(source, tail === 'Complete' || tail === 'Nested', use === 'TSX' ? 'types.tsx' : 'types.ts');
  });
}

test('signature types respect grouping and return type precedence', () => {
  compare('type Handle = new () => T | Ready; const keep = a < b;', true);
  compare('type Handle = new () => <T>(value: T) => Ready<T>; const keep = a < b;', true);
  compare('type Handle = (<T>(value: T) => T) | (new <U>() => U); const keep = a < b;', true);
  compare('type Handle = <T>() => T extends Ready ? True : False; const keep = a < b;', true);
  compare('type Handle = abstract; type X = api.new; const keep = a < b;', true);
  compare('const run = value as <T>(value: T) => T; const keep = a < b;', true);

  compare('type Handle = Ready | <T>() => T; const keep = a < b;', false);
  compare('type Handle = Ready & abstract new () => T; const keep = a < b;', false);
  compare('type Handle = keyof new () => T; const keep = a < b;', false);
  compare('type Handle = readonly <T>() => T; const keep = a < b;', false);
  compare('type Handle = <>() => T; const keep = a < b;', false);
  compare('type Handle = new <T>(); const keep = a < b;', false);
});
