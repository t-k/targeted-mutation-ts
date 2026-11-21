import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast) {
  const options = { file: 'class.ts', logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const modifiers = {
  Ordinary: '', Public: 'public ', PrivateReadonly: 'private readonly ', StaticProtected: 'static protected ',
  ReadonlyStatic: 'readonly static ',
};
const initializers = {
  Comparison: 'check(this.size < limit)',
  SuperProperty: 'super.count >= limit',
  FunctionArguments: 'function get() { return arguments.length < limit; }',
  ArrowSuper: '() => super.count < limit',
};
const rows = readFileSync(new URL('../verification/pict/low-class-fields.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [modifier, initializer, outcome] = row.split('\t');
  test(`Low* class field: ${modifier} ${initializer} ${outcome}`, () => {
    const expression = outcome === 'MissingValue' ? '' : initializers[initializer];
    const end = outcome === 'InvalidSuffix' ? '\nconst =' : '\nconst keep = left > right;';
    const source = `/* 海 */\nexport class Score extends Base { ${modifiers[modifier]}"field"?: Ready = ${expression}; } ${end}`;
    compare(source, outcome === 'Valid');
  });
}

test('class field punctuation and modifier boundaries', () => {
  compare('class Box { private readonly entries = new Map<Key, Value>(); public name!: Ready; protected mark?: Ready; strict = a >= b; }', true);
  compare('class Box { protected\nreadonly count = left < right; static\nname = left > right; readonly readonly = left >= right; }', true);
  compare('class Box { static readonly = a < b; readonly() { return a > b; } private constructor() {} }', true);
  compare('class Box { invalid!: Ready = left < right; }', false);
  compare('class Box { invalid!; const_: Ready; }', false);
  compare('class Box { readonly check() { return a < b; } }', false);
  compare('class Box { private static "prototype" = left < right; }', false);
  compare('class Box { public public key = left < right; }', false);
  compare('class Box { get; set = left < right; field = left > right; }', true);
  compare('class Box { "get"\nfield = left < right; }', true);
  compare('class Box { get\nfield = left < right; }', false);
  compare('class Box { private set /*\n*/ field: Ready = left < right; }', false);
  compare('class Box { readonly get\nfield!: Ready; } const keep = left > right;', false);
});

test('field expressions and nested functions restore their own contexts', () => {
  compare('class C extends Base { value = arguments.length < limit; }', false);
  compare('class C { value = ({ arguments }); } const keep = a < b;', false);
  compare('class C { value = { arguments: left < right }; next = saved.arguments >= limit; }', true);
  compare('class C { value = () => arguments.length < limit; }', false);
  compare('class C { value = (saved = arguments) => saved.length < limit; }', false);
  compare('class C { value = ({saved = arguments}) => saved.length < limit; }', false);
  compare('class C { value = new arguments(); } const keep = a < b;', false);
  compare('class C { value = () => { class Inner extends arguments.Base {} }; } const keep = a < b;', false);
  compare('class C { value = () => { class Inner extends saved.arguments {} }; } const keep = a < b;', true);
  compare('class C { value = () => { class Inner extends Base<arguments> {} }; } const keep = a < b;', true);
  compare('class C extends Base { value = super() < limit; }', false);
  compare('class C extends Base { constructor() { super(a < b); } value = () => super.count >= max; }', true);
  compare('async function wrap() { class C { value = await get(); } return a < b; }', false);
  compare('async function wrap() { class C { value = async () => await check(a < b); } return b > c; }', true);
});
