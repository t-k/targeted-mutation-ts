import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const rows = readFileSync(new URL('../verification/pict/control-extraction.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
const operands = { Simple: 'i > limit', Property: 'i < values /* .noise */ .items.length',
  This: 'this._pendingRequests.size >= 0', Grouped: '(left.a < 3) <= (right.b > 7)' };
const wrappers = {
  Const: expression => `export const fits = ${expression};`,
  If: expression => `if (${expression}) { i++; } else { i--; }`,
  While: expression => `while (${expression}) { i++; }`,
  DoWhile: expression => `do { i++; } while (${expression});`,
  For: expression => `for (let i = 0; ${expression}; i++) { i++; }`,
};

for (const row of rows) {
  const [wrapper, operand, suffix] = row.split('\t');
  test(`control extraction: ${wrapper} ${operand} ${suffix}`, () => {
    const input = wrappers[wrapper](operands[operand]) + {
      Complete: '', Invalid: '\nconst =', Unsupported: '\nfunction other() { return values <number>().length < 7; }',
    }[suffix];
    const result = extract(input, { requireNative: true });
    const reference = extractFallback(input);
    assert.equal(result.path, { Complete: 'fast', Invalid: 'diagnostic', Unsupported: 'fallback' }[suffix]);
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('publishes comparisons across nested blocks and sequential statements in byte order', () => {
  const input = 'var i = 0; do { i++; } while (i < 10); for (; i < 20;) { if (this.ready > 0) { i++; } }';
  const result = extract(input, { mode: 'script', requireNative: true });
  assert.equal(result.path, 'fast');
  assert.equal(result.metrics.maxDepth, 2);
  assert.deepEqual(result.candidates, extractFallback(input, { mode: 'script' }).candidates);
  assert.deepEqual(result.candidates.map(candidate => candidate.operator), ['<', '<', '>']);
});

test('supports a top-level var loop without allowing var through a lexical loop scope', () => {
  const source = 'for (var i = 0; i < values.length; i++) {}';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fast');
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('rejects restricted bindings, malformed postfix updates, and excess statement nesting', () => {
  for (const input of [
    'for (let false = 0; false < 10; false++) {}',
    'if (a.x > 0) { eval++; }',
    'if (a.x > 0) { i\n++; }',
    'while (a.x > 0) { z+ +; }',
    'for (let i = 0; i < n; i++) { for (var i = 0; i < n; i++) {} }',
    'const true = a < b;',
  ]) {
    const result = extract(input, { requireNative: true });
    assert.equal(result.path, 'diagnostic', input);
    assert.deepEqual(result.candidates, []);
  }
  const deep = 'if (a < b) { '.repeat(70) + '}'.repeat(70);
  const result = extract(deep, { requireNative: true });
  assert.equal(result.path, 'fallback');
  assert.equal(result.reason, 'depth-limit');
  assert.equal(result.candidates.length, 70);
  assert.deepEqual(result.candidates, extractFallback(deep).candidates);
});

test('an unterminated comment rejects a deep prefix without publishing native candidates', () => {
  const input = 'if (a < b) { '.repeat(63) + '/*' + ' '.repeat(256 * 1024);
  const result = extract(input, { requireNative: true });
  assert.equal(result.path, 'diagnostic');
  assert.equal(result.metrics.maxDepth, 63);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, extractFallback(input).diagnostics);
});

test('a complete control program does not load Yuku on initial extraction', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'yuku-parser') throw new Error('Unexpected Yuku load');
      return nextResolve(specifier, context);
    } });
    const { extract } = await import(${JSON.stringify(module)});
    const result = extract('for (let i = 0; i < list.length; i++) { if (this.size > 0) {} }', { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.equal(result.candidates.length, 2);
    assert.throws(() => extract('let x; let x;', { requireNative: true }), /Unexpected Yuku load/);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
