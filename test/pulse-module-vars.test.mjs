import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const options = { file: 'vars.ts', mode: 'module', requireNative: true };
const rows = readFileSync(new URL('../verification/pict/pulse-module-vars.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [visibility, binding, suffix] = row.split('\t');
  test(`Pulse module var: ${visibility} ${binding} ${suffix}`, () => {
    const names = {
      Simple: 'entry = score < cutoff', List: 'entry = (score < cutoff), other = min >= max',
      Pattern: '{ entry } = (score < cutoff ? a : b)', NoInitializer: 'entry',
    }[binding];
    const after = {
      Comparison: 'check(score >= cutoff);', DifferentScope: 'function check(entry) { return entry <= max; }',
      SameLet: 'let entry = score >= cutoff;', SameVar: 'var entry = score > cutoff;', Broken: 'const =',
    }[suffix];
    const exported = visibility === 'Exported' ? 'export ' : '';
    const source = `import 'react'; /* 海 🧪 */ ${exported}var ${names}; ${after}`;
    const actual = extract(source, options);
    const expected = extractFallback(source, options);
    assert.deepEqual(actual.candidates, expected.candidates, source);
    assert.deepEqual(actual.diagnostics, expected.diagnostics, source);
    // A var with a plain name may be declared again by another var; a pattern keeps the conflict.
    const again = suffix === 'SameVar' && binding !== 'Pattern';
    assert.equal(actual.path === 'fast', suffix === 'Comparison' || suffix === 'DifferentScope' || again, source);
  });
}

test('module var names are visible to forward extraction of a trailing named export', () => {
  const source = 'import "x"; var check = n < m; export { check };';
  const actual = extract(source, options);
  assert.equal(actual.path, 'fast');
  assert.deepEqual(actual.candidates, extractFallback(source, options).candidates);
});

test('top-level conflicts across declaration kinds and nested var remain conservative', () => {
  for (const source of [
    'let a = n < m; var a;',
    'import a from "x"; var a;',
    'function a() { return n < m; } var a;',
    'var a = n < m; class a {}',
    'import "x"; if (ok) { var a = n < m; } let a;',
  ]) {
    const actual = extract(source, options);
    const expected = extractFallback(source, options);
    assert.notEqual(actual.path, 'fast', source);
    assert.deepEqual(actual.candidates, expected.candidates, source);
    assert.deepEqual(actual.diagnostics, expected.diagnostics, source);
  }
});

test('exported var is still invalid in explicit script mode', () => {
  const script = { ...options, mode: 'script' };
  assert.equal(extract('export var x = n >= m;', script).path, 'diagnostic');
});

test('a bare less-than expression before a declarator comma retains the generic precedence check', () => {
  const source = 'import "x"; var entry = score < cutoff, other = min >= max;';
  const result = extract(source, options);
  assert.equal(result.path, 'fallback');
  assert.deepEqual(result.candidates, extractFallback(source, options).candidates);
});
