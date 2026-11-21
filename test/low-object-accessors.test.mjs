import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, fast, file = 'accessor.ts') {
  const options = { file, logical: true };
  const actual = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(actual.path, fast ? 'fast' : reference.path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const keys = { Named: 'value', Quoted: '"海"', Numeric: '0x10', Computed: '[left >= right]' };
const rows = readFileSync(new URL('../verification/pict/low-object-accessors.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [accessor, key, parameters] = row.split('\t');
  test(`Low* object accessor: ${accessor} ${key} ${parameters}`, () => {
    const getter = accessor === 'Getter';
    const args = {
      Correct: getter ? '' : 'value: Ready',
      EmptyOrExtra: getter ? 'value: Ready' : '',
      Rest: '...rest: Ready[]',
      MissingBody: getter ? '' : 'value: Ready',
    }[parameters];
    const body = parameters === 'MissingBody' ? '' : ' { return super.count < cutoff || left > right; }';
    const source = `const before = x < y;\nexport const object = { ${getter ? 'get' : 'set'} ${keys[key]}(${args}): Ready${body} };\nconst after = x > y;`;
    compare(source, parameters === 'Correct');
  });
}

test('accessor prefixes preserve ordinary get and set properties, methods and shorthands', () => {
  compare('const item = { get, set, get: (a < b), set() { return a > b; }, get get() { return a >= b; }, set set(x) { hit(x < b); } };', true);
  compare('const item = { get: a < b, set value(x) { hit(x > limit); } };', false);
  compare('const item = { get\n named(): boolean { return a < b; }, get "prototype"() { return c > d; }, get __proto__() { return c >= d; } };', true);
});

test('nonrest setter parameters use the ordinary binding and default-expression rules', () => {
  compare('const item = { set named({value}: Ready) { hit(value < limit); }, set index(value = a < b,) { hit(value > limit); }, set flag(value?: Ready) { hit(value >= limit); } };', true);
  compare('const item = { set named(first, second) { hit(first < second); } };', false);
  compare('const item = { set named(value) { return super() < cutoff; } };', false);
  compare('const item = { get named(this: Ready) { return a < b; } };', false);
});

test('an accessor can nest type parameters, JSX and template comparisons', () => {
  compare('const item = { get value<T>() { return <span>{\`${a < b}\`}</span>; } };', true, 'accessor.tsx');
  compare('const item = { get value<T>() { return a < b; }, set [left < right](v) { hit(v > limit); } };', true);
});
