import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    ['function f(n: number) { return\n n < 2; }', 'fast'],
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

const signatures = {
  Simple: '(queue: Queue): void',
  Generic: '<Item>(queue: Map<string, Item>): void',
  Nested: '<Item>(queue: Map<string, Map<number, Item>>): void',
};
const expressions = {
  Call: 'queue.peek().size < limit',
  Arguments: 'queue.pick((left < right), value).size >= 0',
  NonNull: 'queue.keys().next().value! > limit',
};
const expressionRows = readFileSync(new URL('../verification/pict/module-expressions.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of expressionRows) {
  const [signature, expression, suffix] = row.split('\t');
  test(`Low* module expressions: ${signature} ${expression} ${suffix}`, () => {
    const source = `export function scan${signatures[signature]} { return ${expressions[expression]};${suffix === 'Valid' ? ' }' : ''}`;
    const result = extract(source, { requireNative: true });
    const reference = extractFallback(source);
    assert.equal(result.path, suffix === 'Valid' ? 'fast' : 'diagnostic');
    assert.deepEqual(result.candidates, reference.candidates);
    assert.deepEqual(result.diagnostics, reference.diagnostics);
  });
}

test('native extracts from a bounded map update with a generic signature and nested methods', () => {
  const source = [
    'export function remember<T>(entries: Map<string, T>, key: string, value: T): void {',
    '  entries.set(key, value);',
    '  while (entries.size > 32) { entries.delete(entries.keys().next().value!); }',
    '}',
  ].join('\n');
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'fast');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates, extractFallback(source).candidates);
});

test('a generic call is never exposed as two relational arguments', () => {
  const source = 'function f() { return foo(make < T, U > (value)) < cap; }';
  const reference = extractFallback(source);
  const result = extract(source, { requireNative: true });
  assert.equal(reference.candidates.length, 1);
  assert.deepEqual(result.candidates, reference.candidates);
  assert.deepEqual(result.diagnostics, reference.diagnostics);
});

test('a type keyword cannot take generic arguments', () => {
  const source = 'export function f(x: undefined<T>) { return x < y; }';
  const result = extract(source, { requireNative: true });
  assert.equal(result.path, 'diagnostic');
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, extractFallback(source).diagnostics);
});

test('a call following a numeric atom on a new line still owns the complete operand span', () => {
  for (const start of ['return ', '']) {
    const source = `export function f() { ${start}1\n(value) < cap; }`;
    const result = extract(source, { requireNative: true });
    assert.equal(result.path, 'fast');
    assert.deepEqual(result.candidates, extractFallback(source).candidates);
  }
});

test('call depth and candidate allocation preserve complete results at their limits', () => {
  for (const depth of [64, 65]) {
    const source = 'const result = ' + 'pick('.repeat(depth) + 'a < b' + ')'.repeat(depth) + ';';
    const result = extract(source, { requireNative: true });
    assert.equal(result.path, depth === 64 ? 'fast' : 'native');
    if (depth > 64) assert.equal(result.reason, 'depth-limit');
    assert.deepEqual(result.candidates, extractFallback(source).candidates);
  }
  for (const count of [16, 17, 4_096, 4_097]) {
    const args = Array(count).fill('(a < b)').join(', ');
    const result = extract(`const result = pick(${args});`, { requireNative: true });
    assert.equal(result.path, count <= 4_096 ? 'fast' : 'fallback');
    assert.equal(result.candidates.length, count);
    assert.deepEqual(result.candidates, extractFallback(`const result = pick(${args});`).candidates);
  }
});

test('the standalone CLI extracts without Cargo, Oxc, or installed npm dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmt-standalone-'));
  try {
    for (const dir of ['bin', 'src']) cpSync(new URL(`../${dir}/`, import.meta.url), join(root, dir), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    cpSync(new URL('../scripts/build-native.mjs', import.meta.url), join(root, 'scripts/build-native.mjs'));
    cpSync(new URL('../native/', import.meta.url), join(root, 'native'), {
      recursive: true, filter: path => !path.endsWith('/syntax') && !path.endsWith('/syntax.h'),
    });
    const built = spawnSync(process.execPath, ['scripts/build-native.mjs', '--low-only'], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMT_CARGO: join(root, 'absent-cargo') },
    });
    assert.equal(built.status, 0, built.error?.message ?? built.stderr);
    const source = 'import { limit } from "./settings"; export function ready(n: number) { return n < limit; }';
    writeFileSync(join(root, 'source.ts'), source);
    const native = spawnSync(process.execPath, ['bin/tmt.mjs', 'extract', 'source.ts'], { cwd: root, encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    const result = JSON.parse(native.stdout);
    assert.equal(result.path, 'fast');
    assert.deepEqual(result.candidates, extractFallback(source).candidates);
    writeFileSync(join(root, 'source.ts'), source + '\ninterface Shape { size(): number; }');
    const unsupported = spawnSync(process.execPath, ['bin/tmt.mjs', 'extract', 'source.ts'], { cwd: root, encoding: 'utf8' });
    assert.equal(unsupported.status, 1, unsupported.stderr);
    const refusal = JSON.parse(unsupported.stdout);
    assert.equal(refusal.path, 'diagnostic');
    assert.equal(refusal.reason, 'outside-l1');
    assert.deepEqual(refusal.candidates, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('module binding and parameter limits preserve the complete extraction', () => {
  for (const count of [64, 65]) {
    const module = Array.from({ length: count - 1 }, (_, index) => `const local${index} = 0;`).join('\n') +
      '\nexport const result = local0 < limit;';
    const params = Array.from({ length: count }, (_, index) => `p${index}: number`).join(', ');
    const fn = `export function result(${params}) { return p0 < limit; }`;
    for (const source of [module, fn]) {
      const actual = extract(source, { requireNative: true });
      assert.equal(actual.path, count === 64 ? 'fast' : 'native');
      assert.deepEqual(actual.candidates, extractFallback(source).candidates);
    }
  }
});
