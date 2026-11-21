import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const expressions = {
  Precedence: 'a + 2 * b < c - 4 && d >= 3 || (mask | 32) === 0',
  Chain: 'a < b < c === d',
  Conditional: 'name.length > 1 ? name.trim() === "" ? a < b : c >= d : e > f',
  Regex: String.raw`name.length > 1 ? name.replace(/\/+$/, "") : name`,
  Unary: '!name.ready() || (typeof name === "string" && -a < +b)',
  Nested: 'pick((a < b), c) > choose(d >= e)',
};
const wrappers = {
  ModuleConst: expression => `export const answer = ${expression};`,
  Function: expression => `export function choose(name: string) { const answer = ${expression}; return answer; }`,
  Block: expression => `export function choose(name: string) { if (name.length > 0) { const answer = ${expression}; return answer; } }`,
};
const rows = readFileSync(new URL('../verification/pict/low-expression.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [expression, wrapper, suffix] = row.split('\t');
  test(`Low* expression: ${expression} ${wrapper} ${suffix}`, () => {
    const source = '/* 🐈 */\n' + wrappers[wrapper](expressions[expression]) + (suffix === 'Invalid' ? '\nconst =' : '');
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('function lexical declarations keep parameter, child, and sibling scopes distinct', () => {
  for (const [source, path] of [
    ['function f(x: number) { const x = y > z; }', 'diagnostic'],
    ['function f() { let x = y > z; const x = y < z; }', 'diagnostic'],
    ['function f(x: number) { while (x > 0) { const x = y < z; return x; } }', 'fast'],
    ['function f() { if (x > 1) { const result = a < b; } else { let result = a > b; } const result = 0; }', 'fast'],
    ['function f() { if (x > 1) { const result = a < b; const result = a > b; } }', 'diagnostic'],
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, path, source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

test('type arguments, unsupported operators and malformed literals publish no false comparisons', () => {
  for (const expression of [
    'make<T>(item) > limit',
    'make<T | U>(item) > limit',
    'make<T & U>(item) > limit',
    'choose(make<A | B, C>(item)) > limit',
    'a << 1 < b',
    'a ?? b || c < d',
    'a?.b as Count > c',
    'left < /++/',
    'left < /a++/',
    String.raw`left < "\08"`,
    String.raw`left < /a\z/u`,
  ]) {
    const source = `export function parse() { return ${expression}; }`;
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

const bodies = {
  Template: 'if (x < y) log(`value: ${a >= b}`, label);',
  Index: 'let index = values[point < threshold]; if (index > 0) log(values[index]);',
  Constructor: 'if (x < y) throw new Error(`invalid: ${n > max}`);',
  Update: 'for (let i = 0; i < array.length; i += 1) { log(array[i]); }',
};
const contexts = {
  Module: body => body,
  Function: body => `export function run() { ${body} }`,
  Async: body => `export async function run(): Promise<void> { ${body} }`,
};
const bodyRows = readFileSync(new URL('../verification/pict/low-module-body.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of bodyRows) {
  const [feature, context, suffix] = row.split('\t');
  test(`Low* module body: ${feature} ${context} ${suffix}`, () => {
    const source = 'import label, { log } from "./logger";\nimport * as meta from "./meta";\n' +
      contexts[context](bodies[feature]) + (suffix === 'Invalid' ? '\nconst =' : '');
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('module bodies preserve control and literal early errors', () => {
  for (const source of [
    'import first, { second as first } from "./x"; if (x < y) log(first);',
    'if (x < y) let y = right > left;',
    'if (x < y) throw\n new Error("unsafe newline");',
    'function f() { throw\n(x < y); }',
    'function f() { return `bad ${x < y`; }',
    String.raw`function f() { return \`bad \08\` < max; }`.replaceAll('\\`', '`'),
    'for (let i = 0; i < x; i +=) {}',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, 'diagnostic', source);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
});

test('an import and local binding with the same name stay on the reference route', () => {
  const source = 'import * as ns from "./x"; let ns = x < y;';
  const result = extract(source, { requireNative: true });
  const reference = extractFallback(source);
  assert.equal(result.path, 'fallback');
  assert.deepEqual(result.candidates, reference.candidates);
  assert.deepEqual(result.diagnostics, reference.diagnostics);
});

test('a line break before a tagged template keeps the full left operand', () => {
  for (const source of ['tag\n`x` < limit;', 'const a = tag\n`x` < limit;', 'if (check) tag\n`x` < limit;']) {
    const result = extract(source, { requireNative: true });
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, extractFallback(source).candidates, source);
  }
});

test('wider precedence preserves the direct JSX disabled disjunction rule', () => {
  for (const [attribute, path] of [
    ['disabled={x > n || count >= 2}', 'native'],
    ['disabled={(x > n || count >= 2)}', 'fast'],
    ['hidden={x > n || count >= 2}', 'fast'],
  ]) {
    const source = `const view = <button ${attribute}/>;`;
    for (const logical of [false, true]) {
      const options = { dialect: 'tsx', logical, requireNative: true };
      const result = extract(source, options);
      assert.equal(result.path, path, source);
      assert.deepEqual(result.candidates, extractFallback(source, options).candidates);
    }
  }
});
