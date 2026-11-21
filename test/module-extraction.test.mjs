import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const imports = {
  None: '',
  SideEffect: 'import "猫/module";\n',
  Named: 'import { left, right, } from "./values";\n',
  Aliased: 'import { default as left, limit as right } from "./values"\n',
  TypeNamed: 'import type { Limit } from "./values";\n',
};
const declarations = {
  Const: 'export const fits: boolean = left < right;\nconst minimum = left >= 3;',
  Function: 'export function fits(left: number, right: number,): boolean { if (left < right) { return left >= 3; } return false; }',
};
const rows = readFileSync(new URL('../verification/pict/module-extraction.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [importForm, declaration, suffix] = row.split('\t');
  test(`Low* modules: ${importForm} ${declaration} ${suffix}`, () => {
    const source = imports[importForm] + declarations[declaration] + {
      Valid: '', Syntax: '\nconst =', Duplicate: '\nconst fits = true;',
    }[suffix];
    const options = { requireNative: true };
    const result = extract(source, options);
    const reference = extractFallback(source, options);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('native modules preserve ASI, binding scope, and failure diagnostics', () => {
  for (const [source, path] of [
    ['import { left } from "./x"\nexport const fits = left < 2\nconst higher = left > 0', 'fast'],
    ['import { left } from "./x" export const fits = left < 2;', 'diagnostic'],
    ['import { left } from "./x"; const left = 1 < 2;', 'fallback'],
    ['import { left as n, right as n } from "./x"; const fits = n < 2;', 'diagnostic'],
    ['function f(n: number, n: number) { return n < 2; }', 'diagnostic'],
    ['function f(n: number) { return\n n < 2; }', 'native'],
    ['import "unfinished\n"; const fits = n < 2;', 'diagnostic'],
    ['function f(n: number) { return n < 2; } return n > 2;', 'diagnostic'],
    ['const x = 1; const q = x < 2 const y = 3;', 'diagnostic'],
    ['const root = 1; function shadow(root: number) { return root < 2; }', 'fast'],
    ['export function active(n: number) { return n < 5 }', 'fast'],
    ['function f(n: keyof) { return n < 2; }', 'diagnostic'],
    ['function f(n: number): infer { return n < 2; }', 'diagnostic'],
    ['export const fits: readonly = left < right;', 'diagnostic'],
    ['export const fits: unique = left < right;', 'diagnostic'],
  ]) {
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, path, source);
    assert.deepEqual(result.candidates, reference.candidates, source);
    assert.deepEqual(result.diagnostics, reference.diagnostics, source);
  }
  const script = 'import "m"; function f(n: number) { return n < 2; }';
  assert.equal(extract(script, { requireNative: true, mode: 'script' }).path, 'diagnostic');
});

test('a complete typed module is extracted without either grammar fallback', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'yuku-parser') throw new Error('Unexpected Yuku load');
      return nextResolve(specifier, context);
    } });
    const { extract } = await import(${JSON.stringify(module)});
    const result = extract('import { limit } from "./x"; export function ready(n: number): boolean { return n >= limit }',
      { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.equal(result.metrics.astNodes, 0);
    assert.equal(result.candidates.length, 1);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});
