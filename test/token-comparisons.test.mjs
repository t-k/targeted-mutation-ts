import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const rows = readFileSync(new URL('../verification/pict/condition-tokens.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  test('token conditions ' + row.replaceAll('\t', ' / '), () => {
    const [condition, operator, operand, trivia] = row.split('\t');
    const op = { LT: '<', LE: '<=', GT: '>', GE: '>=' }[operator];
    const left = { Identifier: 'item', Property: 'item.length', Number: '12' }[operand];
    const gap = trivia === 'Comment' ? ' /* > */ ' : ' ';
    const prefix = trivia === 'Unicode' ? '/* 🐈 */ ' : '';
    const expr = left + gap + op + gap + 'limit';
    const source = prefix + ({ If: `if (${expr}) {}`, While: `while (${expr}) {}`, For: `for (let i = 0; ${expr}; i++) {}` }[condition]);
    const result = extract(source, { dialect: 'ts' });
    assert.equal(result.fallback, 'tokens');
    assert.deepEqual(result.candidates, extractFallback(source, { dialect: 'ts' }).candidates);
  });
}

test('ambiguous operators and unsupported syntax use the AST without partial results', () => {
  for (const source of [
    'if (a < b) {} const x = f<T>(a);',
    'if (a < b) {} const x = (a < b) < c;',
    'if (a + b < c) {}',
    'if ((a < b)) {}',
    'if (a < b && c > d) {}',
    'if (a < b) {} const x = `x ${a > b}`;',
  ]) {
    const result = extract(source, { dialect: 'ts' });
    assert.notEqual(result.fallback, 'tokens', source);
    assert.deepEqual(result.candidates, extractFallback(source, { dialect: 'ts' }).candidates, source);
  }
});

test('diagnostics and TSX remain on the existing path', () => {
  for (const [source, dialect] of [['if (a < b) {} const x;', 'ts'], ['if (a < b) {} let x; let x;', 'ts'], ['const x = <T n={a < b} />;', 'tsx']]) {
    const result = extract(source, { dialect });
    assert.notEqual(result.fallback, 'tokens');
    const oracle = extractFallback(source, { dialect });
    assert.deepEqual(result.candidates, oracle.candidates);
    assert.deepEqual(result.diagnostics, oracle.diagnostics);
  }
});

test('regex contents do not become comparison tokens', () => {
  const source = 'if (a < b) {} const x = /[<]/;';
  const result = extract(source, { dialect: 'ts' });
  assert.equal(result.fallback, 'tokens');
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('a leading ambient const type reference permits direct condition extraction', () => {
  for (const ending of ['; ', '\n', '']) {
    const source = `declare const defs: Record<string, any>${ending}${ending ? 'for (let i = 0; i < segments.length; i++) {}' : ''}`;
    const result = extract(source, { dialect: 'ts' });
    if (ending) assert.equal(result.fallback, 'tokens');
    assert.deepEqual(result.candidates, extractFallback(source, { dialect: 'ts' }).candidates);
  }
});

test('type-like syntax outside the narrow ambient declaration stays on the AST path', () => {
  for (const source of [
    'type X = Record<string, any>; if (a < b) {}',
    'declare let defs: Record<string, any>; if (a < b) {}',
    'declare const defs: Record<string, Array<number>>; if (a < b) {}',
    'declare const defs: Record<string, any> & Extra; if (a < b) {}',
    'declare const defs: Record<string, any>; const x = f<T>(); if (a < b) {}',
    'const x = 0; declare const defs: Record<string, any>; if (a < b) {}',
  ]) {
    const result = extract(source, { dialect: 'ts' });
    assert.notEqual(result.fallback, 'tokens', source);
    assert.deepEqual(result.candidates, extractFallback(source, { dialect: 'ts' }).candidates, source);
  }
});

const ambientRows = readFileSync(new URL('../verification/pict/ambient-condition.tsv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
for (const row of ambientRows) {
  test('ambient type condition ' + row.replaceAll('\t', ' / '), () => {
    const [terminator, arguments_, condition] = row.split('\t');
    const end = terminator === 'Newline' ? '\n' : '; ';
    const args = arguments_ === 'One' ? 'string' : 'string, any';
    const body = { If: 'if (i < segments.length) {}', While: 'while (i < segments.length) {}', For: 'for (let i = 0; i < segments.length; i++) {}' }[condition];
    const source = `declare const defs: Record<${args}>${end}${body}`;
    const result = extract(source, { dialect: 'ts' });
    assert.equal(result.fallback, 'tokens');
    assert.deepEqual(result.candidates, extractFallback(source, { dialect: 'ts' }).candidates);
  });
}
