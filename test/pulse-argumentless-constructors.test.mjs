import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'constructor.js', mode: 'script', requireNative: true };
function compare(source, fast) {
  const result = extract(source, options);
  const reference = extractFallback(source, options);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  assert.equal(result.path === 'fast', fast, source);
}

const rows = readFileSync(new URL('../verification/pict/pulse-argumentless-constructors.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [target, trivia, boundary] = row.split('\t');
  test(`Pulse argumentless constructor: ${target} ${trivia} ${boundary}`, () => {
    const name = target === 'Qualified' ? 'library.Set' : 'Set';
    const expression = trivia === 'Comment' ? `new ${name} /* 👍 < */` : `new ${name}`;
    const text = {
      Statement: `const values = ${expression};`,
      Eof: `const values = ${expression}`,
      Object: `const data = { values: ${expression}, check: a < b };`,
      Argument: `register(${expression}, a < b);`,
      NextDeclaration: `let values = ${expression}\nlet check = a < b;`,
      Broken: `const values = ${expression}\nconst =;`,
    }[boundary];
    compare(`/* 海 */ const before = x <= y; ${text}`, boundary !== 'Broken');
  });
}

test('argumentless construction leaves optional and other ambiguous continuations to compatibility', () => {
  for (const source of [
    'const value = new C?.factory();',
    'const value = new C<T>;',
    'const value = new C < limit;',
    'const value = new C in handlers;',
    'const value = new C /* unterminated',
  ]) compare(source, false);
  compare('const value = (new C) < limit;', true);
  // A parenthesized operand ends at its closing parenthesis.
  compare('const value = new (C);', true);
  compare('const value = f(new (a.b), x < 1);', true);
  compare('const value = new C[flag > limit];', true);
  compare('const value = new C\n(1 < limit);', true);
});

test('the right operand ends before trailing constructor trivia', () => {
  const source = '/* 海 */ const check = x < new library.C /* tail */;';
  compare(source, true);
  const [{ right }] = extract(source, options).candidates;
  assert.equal(Buffer.from(source).toString('utf8', ...right), 'new library.C');
});

test('a control statement or function declaration can follow a bare constructor across a newline', () => {
  compare('const seen = new Set\nfor (const item of values) seen.add(item < limit);', true);
  compare('const seen = new Set /*\n*/ function check() { return n < limit; }', true);
  compare('store.seen = new Set\n/* attribute */store.matches = n < limit;', true);
  compare('const seen = new Set for (const item of values) seen.add(item < limit);', false);
});
