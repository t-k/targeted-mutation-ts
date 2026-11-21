import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path) {
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const suffixes = {
  Ordinary: ['','return input.length >= limit;'],
  Async: ['async ', 'return (await input.result()).length >= limit;'],
};
const forms = {
  Declaration: (modifier, body) => `function outer(input: Item) { ${modifier}function inner(input: Item) { ${body} } return inner(input); }`,
  NamedExpression: (modifier, body) => `const check = ${modifier}function check(input: Item) { ${body} };`,
  AnonymousExpression: (modifier, body) => `const check = (${modifier}function (input: Item) { ${body} })(item);`,
  Method: (modifier, body) => `const handlers = { ${modifier}check(input: Item) { ${body} }, ready: count < limit };`,
};
const rows = readFileSync(new URL('../verification/pict/low-function-forms.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, mode, suffix] = row.split('\t');
  test(`Low* function form: ${form} ${mode} ${suffix}`, () => {
    const source = forms[form](...suffixes[mode]) + (suffix === 'Invalid' ? '\nconst =' : '');
    compare(source, suffix === 'Valid' ? 'fast' : 'diagnostic');
  });
}

test('function forms use independent parameter, lexical, and control scopes', () => {
  for (const source of [
    'function outer(input) { function inner(input = a < b) { return input >= 0; } const next = inner(input); return next < limit; }',
    'const view = { "render"(...items: Item[]) { return items.length < limit; }, async() { return value > 0; } };',
    'async function outer() { const inner = function () { return import.meta.url.length > 0; }; return await next() < cap; }',
    'const value = async\nfunction check() { return a < b; }',
    'const result = (function <T>(value: T) { return value < limit; })(input);',
  ]) compare(source, 'fast');
  for (const source of [
    'if (a < b) function check() {}',
    'while (a < b) { function check() { break; } }',
    'function outer() { function inner() {} const inner = a < b; }',
    'const view = { method(...args, invalid) { return a < b; } };',
    'const read = function (x = a < b) { "use strict"; return x; };',
    'const view = { async() { return await value > 0; } };',
    'const view = { async\nread(input) { return input < limit; } };',
  ]) compare(source, 'diagnostic');
});

test('function and method nesting contributes to extraction depth', () => {
  const options = { requireNative: true };
  const nested = extract('const f = function() { return function() { return a < b; }; };', options);
  const methods = extract('const obj = { check() { return a < b; } };', options);
  for (const result of [nested, methods]) {
    assert.equal(result.path, 'fast');
    assert.equal(result.metrics.maxDepth, 2);
  }
});
