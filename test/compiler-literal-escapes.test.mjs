import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

// The native route publishes JavaScript without asking V8, so a literal it accepts must be one that V8 accepts
// in strict code. Generated literals mix every kind of escape with ordinary text.
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

const escaped = [...'0123456789abcdefghijklmnopqrstuvwxyzBDSWPKXU!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ '];
const plain = [...'abcxyz019 -=_:;,.!#%&@~<>'];

function body(next, quote) {
  let text = '';
  const count = 1 + Math.floor(next() * 6);
  for (let index = 0; index < count; index++) {
    const pick = next();
    if (pick < 0.55) text += '\\' + escaped[Math.floor(next() * escaped.length)];
    else if (pick < 0.65) text += ['\\x41', '\\x4', '\\u0041', '\\u{1F600}', '\\u{110000}', '\\u004', '\\08', '\\0', '\\\n'][Math.floor(next() * 9)];
    else text += plain[Math.floor(next() * plain.length)];
  }
  return quote === '`' ? text.replaceAll('${', '$ {') : text;
}

function strictAccepts(literal) {
  try {
    new Function('"use strict"; return ' + literal + ';');
    return true;
  } catch {
    return false;
  }
}

function nativeAccepts(literal, file) {
  const result = compile(Buffer.from(`export const value = ${literal};\n`), { file });
  return result.backend === 'pulse' || result.backend === 'javascript';
}

test('a string or template that the native route accepts is valid strict JavaScript', () => {
  let accepted = 0, valid = 0;
  for (let seed = 1; seed <= 6000; seed++) {
    const next = random(seed);
    const quote = ['"', "'", '`'][seed % 3];
    const text = body(next, quote);
    if (quote !== '`' && /(?<!\\)(?:\\\\)*["']/.test(text.replaceAll('\\' + quote, ''))) {
      // An unescaped quote would end the literal early. Escaped ones stay.
      if (text.replaceAll('\\' + quote, '').includes(quote)) continue;
    }
    if (quote === '`' && /(?<!\\)(?:\\\\)*`/.test(text)) continue;
    const literal = quote + text + quote;
    const reference = strictAccepts(literal);
    valid += reference;
    for (const file of ['literal.ts', 'literal.mjs']) {
      if (!nativeAccepts(literal, file)) continue;
      accepted++;
      assert.ok(reference, `seed ${seed} ${file}: ${literal}`);
    }
  }
  // Most valid literals are within the native lexer.
  assert.ok(accepted > valid, `${accepted} native results for ${valid} valid literals`);
});

test('a regular expression that the native route accepts is valid JavaScript with its flags', () => {
  const atoms = ['a', '\\d', '\\w+', '[a-z]', '[^;]+', '(x)', '(?:y)?', '.', '\\.', '\\/', '\\=', '\\-', '\\"', "\\'", '\\_', '\\`', '\\:', '\\!', '\\#',
    '\\%', '\\&', '\\,', '\;', '\\<', '\\>', '\\@', '\\~', '[\\=]', '[a\\-z]', '[\\_\\-]', '[\\=-z]', '[a-\\=]', '\\p{L}', '\\u{1F600}', '\\k<n>',
    '(?<n>z)', '\\1', '{', '}', ']', '\\e', '\\q', '\\$', 'b*', 'c{2,3}', '^', '$', '|'];
  const flags = ['', 'g', 'i', 'u', 'gu', 'y', 'su', 'd'];
  let accepted = 0, valid = 0;
  for (let seed = 1; seed <= 5000; seed++) {
    const next = random(seed);
    let pattern = '';
    const count = 1 + Math.floor(next() * 5);
    for (let index = 0; index < count; index++) pattern += atoms[Math.floor(next() * atoms.length)];
    const literal = '/' + pattern + '/' + flags[Math.floor(next() * flags.length)];
    const reference = strictAccepts(literal);
    valid += reference;
    for (const file of ['literal.ts', 'literal.mjs']) {
      if (!nativeAccepts(literal, file)) continue;
      accepted++;
      assert.ok(reference, `seed ${seed} ${file}: ${literal}`);
    }
  }
  assert.ok(accepted > valid / 2, `${accepted} native results for ${valid} valid literals`);
});

test('identity escapes in strings and legacy regular expressions are native', () => {
  for (const literal of ['"[foo=abc \\s]"', "'a\\s\\d\\q\\-'", '`a\\s${1}\\q`', '/^application\\/([a-z-\\.]+\\+)?json(;\\s*[a-zA-Z0-9\\-]+\\=([^;]+))*$/',
    '/\\"(.*)\\"/g', "/\\'(.*)\\'/g", '/^[a-zA-Z][a-zA-Z0-9\\-\\_]+$/', '/a\\-b/', '/[\\=\\,]/i']) {
    assert.ok(nativeAccepts(literal, 'literal.ts'), literal);
    assert.ok(strictAccepts(literal), literal);
  }
  // With the u flag an identity escape of these characters is an error, and so are these string escapes.
  for (const literal of ['/\\=/u', '/a\\-b/u', '/[\\=]/u', '"\\x4"', '"\\u004"', '"\\1"', '"\\08"', '`\\1`', '"\\8"']) {
    assert.ok(!nativeAccepts(literal, 'literal.ts'), literal);
    assert.ok(!nativeAccepts(literal, 'literal.mjs'), literal);
  }
});

test('a key that is compared as written keeps the short list of escapes', () => {
  // With an identity escape these would pass the duplicate and reserved-name checks that read the raw text.
  for (const source of [
    'export const options = { __proto__: null, "\\__proto__": null };',
    'export class User { "\\constructor"() {} constructor() {} }',
    'export class User { static "\\prototype" = {}; }',
    'import { a } from "./\\m.js";\nexport { a };',
  ]) {
    const result = compile(Buffer.from(source), { file: 'keys.ts' });
    assert.notEqual(result.backend, 'pulse', source);
  }
});
