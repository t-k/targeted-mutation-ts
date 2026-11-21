import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, dialect = 'ts') {
  const actual = extract(source, { dialect, requireNative: true });
  const reference = extractFallback(source, { dialect });
  assert.equal(actual.path, path, source);
  assert.deepEqual(actual.candidates, reference.candidates, source);
  assert.deepEqual(actual.diagnostics, reference.diagnostics, source);
}

const parameters = { Single: '<T>', Comma: '<T,>', Multiple: '<T, U>',
  Constraint: '<T extends Value<U>>', Default: '<T = Value<U>>' };
const arrows = {
  Plain: types => `${types}(arg: T) => arg < max`,
  Async: types => `async ${types}(arg?: T) => await run(arg >= max)`,
  Typed: types => `${types}(arg: T = fallback): boolean => { return arg <= max; }`,
};
const rows = readFileSync(new URL('../verification/pict/low-generic-arrows.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const row of rows) {
  const [dialect, type, arrow] = row.split('\t');
  test(`Low* generic arrow: ${dialect} ${type} ${arrow}`, () => {
    const source = `/* 海 */ const before = a < b; const view = ${arrows[arrow](parameters[type])}; const after = a > b;`;
    compare(source, dialect === 'TSX' && type === 'Single' ? 'fallback' : 'fast', dialect.toLowerCase());
  });
}

test('generic arrow lookahead preserves JSX, typed calls, and comparison spans', () => {
  compare('const view = <T extends="kind">{arg < limit}</T>;', 'fast', 'tsx');
  compare('const view = <T extends Value>(arg: T) => <Box active={arg < limit} />;', 'fast', 'tsx');
  compare('const ok = async<T>(arg) >= limit;', 'fast');
  compare('const ok = (<T,>(arg: T) => arg >= limit) < max;', 'fast');
});

test('malformed generic arrows decline without publishing earlier comparisons', () => {
  for (const source of [
    'const f = <T,>(arg: T)\n=> arg < limit;',
    'const f = <T extends>(arg: T) => arg < limit;',
    'const f = async\n<T,>(arg: T) => arg < limit;',
    'const f = <T,>(arg: T) => { return arg < limit;',
  ]) compare('const before = a < b; ' + source, 'diagnostic', 'tsx');
});
