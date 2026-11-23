import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function check(source, path) {
  const options = { file: 'class.ts', requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-class-expression.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [class_, member, position] of rows) {
  test(`Low* class expression ${class_} ${member} ${position}`, () => {
    const name = { Anonymous: '', Named: 'Holder ', Generic: 'Holder<T> ' }[class_];
    const body = {
      Method: 'read() { return a < b; }',
      Getter: 'get value() { return super.value >= limit; }',
      Setter: 'set value(value: unknown) { if (a <= b) this.write(value); }',
      BadArity: 'get value(v: unknown) { return a < b; }',
      Prototype: 'static get prototype() { return a < b; }',
    }[member];
    const classValue = `class ${name}extends Base { ${body} }`;
    const input = {
      Init: `const C = ${classValue};`,
      Call: `register("🧪", ${classValue});`,
      Compare: `const C = (${classValue}) < bound;`,
    }[position];
    check('const prefix = a > b; ' + input, member === 'BadArity' || member === 'Prototype' ? 'diagnostic' : 'fast');
  });
}

test('class expressions give their name an independent scope and allow typed accessors', () => {
  check('const C = class C { x = a < b; get latest(): boolean { return x < y; } };', 'fast');
  check('const C = class<T> { set value(v: T) { if (a <= b) this.write(v); } };', 'fast');
  check('class C { get class() { return a < b; } static set entry(v: number) { write(v); } }', 'fast');
  check('class C { get constructor() { return a < b; } }', 'diagnostic');
  check('const C = class { set value(...data: unknown[]) { return a < b; } };', 'diagnostic');
  check('const C = class { readonly set value(v: unknown) { return a < b; } };', 'diagnostic');
  check('const C = class extends Base { set value(v: unknown) { return a < b; } }; const =', 'diagnostic');
});

test('a bare class statement keeps declaration binding and statement-placement checks', () => {
  check('var value = a < b; class value {}', 'diagnostic');
  check('if (a < b) class Value {}', 'diagnostic');
  check('function read() { while (a < b) class Value {} }', 'diagnostic');
  check('if (a < b) (class Value { read(){ return x < y; } });', 'fast');
});

test('class accessors and heritage cannot publish candidates in compatibility errors', () => {
  for (const head of [
    'abstract get value() { return a < b; }',
    'declare get value(): boolean;',
    'async get value() { return a < b; }',
    'async set value(v: number) {}',
  ]) check(`const C = class { ${head} }; const keep = a < b;`, 'diagnostic');
  check('abstract class C { abstract get value(): boolean; } const keep = a < b;', 'fallback');
  check('declare class C { get value(): boolean; } const keep = a < b;', 'fallback');
  check('const C = class extends {}; const keep = a < b;', 'diagnostic');
  // A heritage clause is any left-hand-side expression.
  check('const C = class extends {} {}; const keep = a < b;', 'fast');
  check('const C = class extends mixin(Base)<T> { m() { return c >= d; } }; const keep = a < b;', 'fast');
});
