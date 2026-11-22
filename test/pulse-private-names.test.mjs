import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';
import { extract } from '../src/extract.mjs';
import { extractTypeScript } from '../src/typescript-extraction.mjs';
import { extractYuku } from './support/yuku-extraction.mjs';

const matrix = readFileSync(new URL('../verification/pict/pulse-private-names.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const options = { file: 'private.js', requireNative: true };

function verify(source, expectedCount) {
  const result = extract(source, options);
  assert.equal(result.path, 'fast', source);
  assert.equal(result.candidates.length, expectedCount);
  for (const reference of [extractTypeScript(source, options), extractYuku(source, options)]) {
    assert.equal(reference.path, 'fallback', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
  }
}

for (const row of matrix) {
  const [shape, order, tail, prefix] = row.split('\t');
  test(`private class names: ${shape} ${order} ${tail} ${prefix}`, () => {
    const before = prefix === 'UTF8' ? '/* 海 🧪 */ ' : '';
    const declaration = shape === 'Method' ? '#item() { return value > limit; }' : '#item = value > limit;';
    const member = shape === 'Method' ? 'this.#item()' : 'target.#item';
    const use = shape === 'Inner'
      ? 'nested() { const Inner = class { read(target) { return target.#item < cutoff; } }; return Inner; }'
      : `read(target) { return ${member} < cutoff; }`;
    const body = {
      Before: declaration + use, Forward: use + declaration,
      Duplicate: declaration + use + declaration, Undeclared: use,
    }[order];
    const sibling = shape === 'Sibling' ? 'class Other { #item = 0; } ' : '';
    const source = `${before}${sibling}class Model { ${body} }` + (tail === 'Broken' ? ' const =' : '');
    if (tail === 'Broken' || order === 'Duplicate' || order === 'Undeclared') {
      assert.throws(() => new Script(source), SyntaxError);
      const result = extract(source, options);
      assert.equal(result.path, 'diagnostic', source);
      assert.equal(result.candidates.length, 0);
    } else {
      new Script(source);
      verify(source, 2);
    }
  });
}

test('private names handle attachments, assignment and nested shadowing within their lexical classes', () => {
  verify('class Outer { #slot; run() { this.#slot = left < right; ' +
    'const Inner = class { run() { return this.#slot > 0; } static #slot = 1; }; return Inner; } }', 2);
  verify('class Model { static read(other) { return other.#name >= 1; } static #name = 1; }', 1);
  verify('class Model { #name = 1; read() { this.#name++; return (this.#name) > 0; } }', 1);
});

test('private name restraints preserve the native publication boundary', () => {
  const declined = [
    'class A { #constructor; read() { return a < b; } }',
    'class A { #x; constructor() { delete this.#x; } } const a = x < y;',
    'class A { #x; read() { return super.#x > 0; } }',
    'class A { #x; read() { return this ?. #x > 0; } }',
    'class A { #x; read() { return #x in other; } }',
    'class A { get #x() { return 0; } set #x(value) {} } const a = x < y;',
    'class A { #\\u0078; read() { return this.#x > 0; } }',
    'class A { private #x = a < b; }',
    'class A { #x; } const escaped = thing.#x > 0;',
    'class A { inner() { return class { #x; }; } read() { return this.#x > 0; } }',
  ];
  for (const source of declined) assert.notEqual(extract(source, options).path, 'fast', source);
});

test('workspace limits decline a source with too many private-name events', () => {
  const fields = size => Array.from({ length: size }, (_, i) => `#name${i};`).join(' ');
  verify(`class A { ${fields(253)} read() { return this.#name0 > 0; } }`, 1);
  const limited = extract(`class A { ${fields(254)} read() { return this.#name0 > 0; } }`, options);
  assert.equal(limited.path, 'fallback');
  assert.equal(limited.candidates.length, 1);
});
