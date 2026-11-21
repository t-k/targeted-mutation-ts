import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function rows(name) {
  return readFileSync(new URL(`../verification/pict/${name}.tsv`, import.meta.url), 'utf8')
    .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
}

function verify(source, path) {
  const options = { requireNative: true, file: 'subject.ts' };
  const result = extract(source, options);
  const expected = extractYuku(source, options);
  assert.deepEqual(result.candidates, expected.candidates, source);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', expected.path === 'diagnostic', source);
}

for (const [context, item, suffix] of rows('low-grouped-sequence')) {
  test(`Low* grouped sequence ${context} ${item} ${suffix}`, () => {
    const first = { Boundary: 'x <= y', Update: 'checks++', Nested: '((x < y), 1)' }[item];
    const end = { Valid: 'value >= cap', Trailing: 'value >= cap,', Empty: ',value >= cap', Broken: 'value >=' }[suffix];
    const body = `(${first}, ${end})`;
    const input = {
      Initializer: `const result = ${body} > bound;`,
      Arrow: `const run = () => ${body};`,
      Condition: `if (${body}) { const result = a < b; }`,
    }[context];
    verify('/* 🧪 */ const keep = a < b; ' + input, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('grouped sequences preserve arrow ambiguity, in expressions and non-assignability', () => {
  verify('const f = (x, y) => x < y; const read = ((x > y, x in a), y <= z);', 'fast');
  verify('const f = (a < T, U > value); const keep = a < b;', 'fallback');
  verify('const out = (...data, a < b);', 'diagnostic');
  verify('const out = (advance(), item) += 1; const keep = a < b;', 'diagnostic');
});

for (const [context, parameter, suffix] of rows('low-readonly-parameter')) {
  test(`Low* readonly constructor parameter ${context} ${parameter} ${suffix}`, () => {
    const prefix = { Base: 'class C { constructor', Derived: 'class C extends Base { constructor', Method: 'class C { run' }[context];
    const args = {
      Readonly: 'readonly /* argument */ key: string',
      Binding: 'readonly: string',
      Default: 'readonly key: boolean = a < b',
      Destructure: 'readonly { key }: Options',
    }[parameter];
    const body = context === 'Derived' ? 'super();' : '';
    const input = `${prefix}(${args}) { ${body} const keep = x < y; } }`;
    const path = suffix === 'Broken' || parameter === 'Destructure' || context === 'Method' && parameter !== 'Binding' ? 'diagnostic' : 'fast';
    verify('/* 🧪 */ ' + input + (suffix === 'Broken' ? ' const =' : ''), path);
  });
}

test('readonly constructor parameters bind names and preserve delimiter validation', () => {
  verify('class C { constructor(readonly x: number, x: string) { if (a < b) {} } }', 'diagnostic');
  verify('class C { constructor(readonly x: number) { let x; if (a < b) {} } }', 'diagnostic');
  verify('class C { constructor(readonly: number, readonly x: number,) { if (a < b) {} } }', 'fast');
  verify('class C { constructor(readonly value: number) { if (a < b) {} } } const broken =', 'diagnostic');
});

test('static constructor-named methods and async instance constructors retain their grammar', () => {
  for (const name of ['constructor', '"constructor"']) {
    verify(`class C { static ${name}(readonly x: number) { if (a < b) {} } }`, 'diagnostic');
    verify(`class C extends Base { static ${name}(x: number) { super(); if (a < b) {} } }`, 'diagnostic');
    verify(`class C { async ${name}(readonly x: number) { if (a < b) {} } }`, 'diagnostic');
    verify(`class C { static async ${name}(x: number) { if (a < b) {} } }`, 'fast');
    verify(`class C { ${name}(readonly x: number) { if (a < b) {} } }`, 'fast');
  }
});
