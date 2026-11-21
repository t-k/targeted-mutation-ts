import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

function compare(source, path, options = {}) {
  const result = extract(source, { ...options, requireNative: true });
  const reference = extractFallback(source, options);
  assert.equal(result.path, path, source);
  assert.deepEqual(result.candidates, reference.candidates, source);
  assert.deepEqual(result.diagnostics, reference.diagnostics, source);
}

const sources = {
  Call: 'const ok = import(count < limit ? "./a" : "./b").then(use) >= max;',
  Meta: 'function check() { return import /* note */ . meta.url.length >= 4; }',
  In: 'const ok = (key in table) < limit && count >= 2;',
  TypeDefault: 'import type Config from "./types"; const ok = check<Config>(value < limit);',
};
const rows = readFileSync(new URL('../verification/pict/low-module-forms.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [form, mode, suffix] = row.split('\t');
  test(`Low* module forms: ${form} ${mode} ${suffix}`, () => {
    compare(sources[form] + (suffix === 'Invalid' ? '\nconst =' : ''), suffix === 'Valid' ? 'fast' : 'diagnostic',
      { mode: mode.toLowerCase() });
  });
}

test('module imports distinguish type modifiers, names and call boundaries', () => {
  for (const source of [
    'import type from "x"; import(type, { with: opts },).then(use); const ok = count < limit;',
    'import type from from "types"; const ok = f<from>(value) < limit;',
    'import("./x",).then(value => value >= 2);',
    'import.meta.url < limit;',
  ]) compare(source, 'fast');
  for (const source of [
    'import type Default, { Item } from "x"; const ok = a < b;',
    'const ok = import() < limit;',
    'const ok = import("./x", options, extra) < limit;',
    'const ok = import(...values) < limit;',
    'const ok = import.other < limit;',
    'const ok = new import.meta < limit;',
    'const ok = new import.meta.url() < limit;',
    'const ok = new import.meta[member]() < limit;',
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.notEqual(result.path, 'fast', source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
  compare('const ok = import.meta.url < limit;', 'diagnostic', { mode: 'script' });
  compare('const ok = new (import.meta) < limit;', 'fallback');
});

test('in shares relational precedence without consuming a classic for delimiter', () => {
  for (const source of [
    'const ok = key in table < limit && count > 0;',
    'const ok = value < count in table;',
    'const ok = key in\ntable && value < limit;',
    'for (const item of key in table) { if (item < limit) run(); }',
    'for (let i = 0; key in table && i < max; i++) run();',
    'for (let i = (key in table); i < max; i++) run();',
    'var i = key in table; if (a < b) run(i);',
    'const ok = inside < limit;',
  ]) compare(source, 'fast');
  compare('for (let item = a in table) { if (item < limit) run(); }', 'diagnostic');
});
