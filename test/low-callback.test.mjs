import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const parameters = {
  Multi: '(item, index, source)',
  Typed: '(item: Value, index: number, source: Value[]): boolean',
  Record: '({ current: item, index }, source)',
  Array: '([item, index], source)',
};
const bodies = {
  Expression: 'source.size >= index && item.value > 3',
  Block: '{ const limit = 3; if (index < source.size) return item.value > limit; return false; }',
  Nested: '{ return source.map(item => { const n = item.value; return n < index; }).length > 0; }',
};
const rows = readFileSync(new URL('../verification/pict/low-callback.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [params, body, suffix] = row.split('\t');
  test(`Low* callback: ${params} ${body} ${suffix}`, () => {
    const source = 'const predicate = ' + parameters[params] + ' => ' + bodies[body] + ';' +
      (suffix === 'Invalid' ? '\nconst =' : '');
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('nested arrows preserve surrounding declarations and allow lexical shadowing', () => {
  for (const [source, path] of [
    ['function f(p: number) { run((p) => { const inner = p; return inner < 3; }); const p = 0; }', 'diagnostic'],
    ['function f(p: number) { run((p) => { const inner = p; return inner < 3; }); const inner = p; return inner > 1; }', 'fast'],
    ['const f = ({a: x, b: x}) => x < y;', 'diagnostic'],
    ['const f = (x: number, x: number) => x < y;', 'diagnostic'],
    ['const f = (x: number)\n=> x < y;', 'diagnostic'],
    ['const f = (x: number): boolean\n=> x < y;', 'diagnostic'],
    ['function f(p: number) { (x < y); const x = p; return x > 1; }', 'fast'],
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, path, source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

test('module handlers can store an arrow with ASI and still decline update continuations', () => {
  const handler = [
    'let count = 0',
    'self.onconnect = (event) => {',
    '  count++',
    '  const port = event.ports[0]',
    '  if (count >= 2) port.postMessage("pong")',
    '}',
  ].join('\n');
  const connected = extract(handler, { requireNative: true });
  assert.equal(connected.path, 'fast');
  assert.deepEqual(connected.candidates, extractFallback(handler).candidates);
  const continuation = 'const f = () => { index++\n + value < limit; };';
  const result = extract(continuation, { requireNative: true });
  assert.notEqual(result.path, 'fast');
  assert.deepEqual(result.candidates, extractFallback(continuation).candidates);
});

test('directive prologues cannot hide strict syntax errors in patterned parameters', () => {
  for (const source of [
    'const f = ({ value }) => { "use strict"; return value < limit; };',
    'const f = ([value]) => { "note"\n"use strict"\nreturn value < limit; };',
    'const f = ({}) => { "use strict"; return a < b; };',
    'function f({ value }) { "use strict"; return value < limit; }',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, 'diagnostic', source);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  }
  for (const source of [
    'const f = (value: number) => { "use strict"; return value < limit; };',
    'const f = ({ value }) => "use strict" < value;',
  ]) {
    const result = extract(source, { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.deepEqual(result.candidates, extractFallback(source).candidates);
  }
});
