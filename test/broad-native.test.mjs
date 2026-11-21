import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { extract, extractFallback } from '../src/extract.mjs';

const inputs = {
  Plain: 'function ready(state: { count: number }) { if (state.count /* > */ >= 3) return true; }',
  Nested: 'const name = "🧪"; const fit = (a < b) <= (c > d);',
  Logical: 'const label = "🐈"; export const view = <button disabled={saving || (!valid)}>{label}</button>;',
  None: 'const label = (value: string) => value.trim(); label("no comparison");',
};
const rows = readFileSync(new URL('../verification/pict/broad-native.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [dialect, mode, candidate, validity] = row.split('\t');
  test(`broad native: ${dialect} ${mode} ${candidate} ${validity}`, () => {
    const source = Buffer.from(inputs[candidate] + {
      Valid: '', Syntax: '\nconst =', Semantic: '\nconst checked = 1; let checked = 2;',
    }[validity]);
    const options = { dialect: dialect.toLowerCase(), mode: mode.toLowerCase(), logical: true, requireNative: true };
    const reference = extractFallback(source, options);
    const result = extract(source, options);
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
    assert.equal(result.path, reference.path === 'diagnostic' ? 'diagnostic' : mode === 'Module' ? 'native' : 'fallback');
    if (result.path === 'native') assert.ok(result.metrics.astNodes > 0);
  });
}

test('the broad native result precedes any Yuku load in a fresh process', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'yuku-parser') throw new Error('Unexpected Yuku load');
      return nextResolve(specifier, context);
    } });
    const { extract } = await import(${JSON.stringify(module)});
    const source = 'import { result } from "lib"; export function run() { return result?.value < 4; }';
    const result = extract(Buffer.from(source), { requireNative: true });
    assert.equal(result.path, 'native');
    assert.equal(result.candidates.length, 1);
    assert.throws(() => extract('let x; let x;'), /Unexpected Yuku load/);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});

test('module early errors keep exact fallback diagnostics and discard candidate prefixes', () => {
  for (const suffix of [
    'function bad(eval: number) {}',
    'function bad() { import "late"; }',
    'export { missing };',
    'let value = 010;',
    'let value = "\\01";',
    'delete name;',
    'if (true) function declaration() {}',
    'while (false) function declaration() {}',
    'named: function declaration() {}',
    'static: while (true) { break static; }',
    'for (var iterator = 2 in entries) {}',
    '\n<!-- legacy comment',
    '\n--> legacy comment',
    'interface A { readonly /* trivia */ get x(): number; }',
    'type A = { readonly set x(value: number); }',
    'export class C { readonly get x() { return edge < 5; } }',
    'export class C { const constructor() {} }',
    'export class C { in constructor() {} }',
    'export class C { out constructor() {} }',
    'export class C implements void {}',
    'export class C implements null.Member {}',
    'function nested() { export const x = 1; }',
    'function nested() { export import A = B; }',
    'if (a) { export {}; }',
    '{ export default x; }',
    'function nested() { export * from "dependency"; }',
    'namespace T { function nested() { export const x = 1; } }',
    'class C { default field: string; }',
    'class C { default method() {} }',
    'const x = 1; export { x }; export { x };',
    'export function f() {} export function f() {}',
    'export function f(x: number): boolean; export { f }; export function f(x: number) { return x < 5; }',
  ]) {
    const source = `const first = x < y; ${suffix}`;
    const oracle = extractFallback(source);
    assert.equal(oracle.path, 'diagnostic', source);
    const actual = extract(source, { requireNative: true });
    assert.equal(actual.path, 'diagnostic', source);
    assert.deepEqual(actual.candidates, []);
    assert.deepEqual(actual.diagnostics, oracle.diagnostics);
  }
});

test('namespace exports and class members named default stay native', () => {
  const source = 'namespace T { export class C { default = 3; method() { return this.default < 10; } } }';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'native');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('a broad parser budget refusal extracts the full file through Yuku', () => {
  const source = 'namespace T { export const first = a < b; } /*' + '('.repeat(16_384) +
    '*/ export const second = c >= d;';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fallback');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('the broad parser has enough stack even when called from a short-stack worker', () => {
  const module = new URL('../src/extract.mjs', import.meta.url).href;
  const code = `
    import { Worker } from 'node:worker_threads';
    import assert from 'node:assert/strict';
    const worker = new Worker(\`
      import assert from 'node:assert/strict';
      import { extract } from ${JSON.stringify(module)};
      const source = 'const x = ' + '['.repeat(1000) + 'a < b' + ']'.repeat(1000) + ';';
      const result = extract(source, { requireNative: true });
      assert.equal(result.path, 'native');
      assert.equal(result.reason, 'depth-limit');
      assert.equal(result.candidates.length, 1);
    \`, { eval: true, resourceLimits: { stackSizeMb: 0.5 } });
    const exit = await new Promise((resolve, reject) => {
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    assert.equal(exit, 0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.signal ?? child.stderr);
});

test('directly exported overload declarations use native extraction', () => {
  const source = [
    'export function ready(value: number): boolean;',
    'export function ready(value: string): boolean;',
    'export function ready(value: number | string) { return Number(value) < 5; }',
  ].join('\n');
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'native');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});
