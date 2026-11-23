import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

function verify(source, path) {
  const options = { file: 'generator.ts', requireNative: true };
  const result = extract(source, options);
  const reference = extractYuku(source, options);
  assert.equal(result.path, path, source);
  assert.equal(result.path === 'diagnostic', reference.path === 'diagnostic', source);
  assert.deepEqual(result.candidates, reference.candidates, source);
}

const rows = readFileSync(new URL('../verification/pict/low-generator-expression.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1).map(row => row.split('\t'));
for (const [function_, yield_, suffix] of rows) {
  test(`Low* generator expression ${function_} ${yield_} ${suffix}`, () => {
    const head = { Generator: 'function* label', AsyncGenerator: 'async /* comment */ function *', Ordinary: 'function' }[function_];
    const value = function_ === 'AsyncGenerator' ? 'await next(a < b)' : 'first < next';
    const body = { Value: `yield ${value};`, Bare: 'yield;', Delegate: `yield* data(a < b);`, Line: 'yield\u2028 x < y;' }[yield_];
    const source = `/* 🧪 */ const f = ${head}(item: Src) { ${body} }; ` +
      (suffix === 'Broken' ? 'const =' : 'const keep = a >= b;');
    verify(source, suffix === 'Broken' || function_ === 'Ordinary' ? 'diagnostic' : 'fast');
  });
}

test('generator scope survives nested functions and rejects invalid yield contexts', () => {
  verify('const gen = async function* () { const run = () => a < b; yield await n(); yield a < b; };', 'fast');
  verify('const gen = function* () { if (a < b) yield whileReady; yield; };', 'fast');
  verify('const gen = function* () { const plain = () => { yield x < y; }; yield item; };', 'diagnostic');
  verify('const gen = function* (x = yield value) { yield x; };', 'diagnostic');
  verify('const gen = function* () { class D { x = yield item; } yield item; };', 'diagnostic');
  verify('const gen = function* () { yield* ; };', 'diagnostic');
  // A yield is an expression, so an initializer and an argument take the fast path as well.
  verify('const gen = function* () { const y = yield a < b; };', 'fast');
  verify('const gen = function* () { const y = [yield a, yield]; return yield* each(c >= d); };', 'fast');
});

test('delegated yield retains the reference line-boundary diagnostic', () => {
  for (const gap of ['\n', '\r\n', '\u2028', ' /* comment\n */ ']) {
    verify('const gen = function* () { yield*' + gap + ' x < y; }; const keep = c >= d;', 'diagnostic');
  }
  verify('const gen = function* () { yield* /* comment */ each(a < b); };', 'fast');
});
