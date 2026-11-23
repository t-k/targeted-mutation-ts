import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';

const samples = {
  Module: 'import type { Input } from "fixture"; export function pick(input: Input): number { const a: number = input.value; return a; }',
  Script: '// export const marker = 0\nconst local: number = 1; function run() { return this; }',
  Invalid: 'export function pick(x: number, x: number) { return x; } export const broken =',
  Empty: '#!/usr/bin/env node\n/* license */\nimport type { Input } from "unused";\nexport interface Box { input: Input; }',
  Runtime: 'export enum Mode { Ready = read() } export const next = Mode.Ready;',
};
const rows = readFileSync(new URL('../verification/pict/compiler-bridge.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);
for (const row of rows) {
  const [source, target, map] = row.split('\t');
  test('native erasure bridge ' + row.replaceAll('\t', ' '), async () => {
    const input = samples[source];
    const result = compile(input, { target: target === 'Modern' ? 'esnext' : 'es2018', sourceMap: map === 'On' });
    const bridged = (source === 'Module' || source === 'Empty') && target === 'Modern' && map === 'Off';
    assert.equal(result.backend, bridged ? (source === 'Empty' ? 'pulse' : 'node-strip') : 'typescript');
    if (source === 'Invalid') assert.equal(result.code, null);
    if (bridged && source === 'Module') {
      const module = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
      assert.equal(module.pick({ value: 42 }), 42);
    }
    if (bridged && source === 'Empty') assert.match(result.code, /^#!.*\n\/\* license \*\//);
    if (source === 'Script') assert.match(result.code, /"use strict"/);
  });
}

test('erasure needs an original ESM declaration and a surviving ESM marker', () => {
  for (const source of [
    'import type { X } from "fixture";\nconst local: number = 42;\nconsole.log(local);',
    '"export const x = 1";\nconst local: number = 1;',
    'import("fixture"); const local: number = 1;',
    'import.meta.url; const local: number = 1;',
    '/// <reference />\nexport const value: Set<number> = new Set();',
  ]) assert.notEqual(compile(source).backend, 'node-strip', source);
});

test('later module markers survive erasure and runtime text is not a triple-slash directive', async () => {
  const source = 'import type { X } from "fixture";\nconst prefix: string = "a:///b";\n' +
    'export function read(_value: X): string { return prefix; }';
  const lowered = compile(source);
  assert.equal(lowered.backend, 'node-strip');
  const module = await import('data:text/javascript;base64,' + Buffer.from(lowered.code).toString('base64'));
  assert.equal(module.read(null), 'a:///b');
});

test('a hashbang can precede a later module marker', () => {
  const result = compile('#!/usr/bin/env node\nconst value: number = 1;\nexport function read() { return value; }');
  assert.equal(result.backend, 'node-strip');
  assert.match(result.code, /^#!\/usr\/bin\/env node/);
});

test('parameter properties can lower without TypeScript while preserving constructor order', async () => {
  const source = [
    'const log: string[] = [];',
    'class Base { constructor() { log.push("base"); } }',
    'export class Widget extends Base {',
    '  observed = log.push("field");',
    '  constructor(public value: number) { super(); log.push("body"); }',
    '}',
    'export function read() { return log.slice(); }',
  ].join('\n');
  const result = compile(source);
  if (Number(process.versions.node.split('.')[0]) <= 25) assert.equal(result.backend, 'node-transform');
  const baseline = compile(source, { sourceMap: true });
  for (const code of [result.code, baseline.code]) {
    const m = await import('data:text/javascript;base64,' + Buffer.from(code + (code === result.code ? '\n// first' : '\n// second')).toString('base64'));
    const instance = new m.Widget(42);
    assert.equal(instance.value, 42);
    assert.equal(instance.observed, 2);
    assert.deepEqual(m.read(), ['base', 'field', 'body']);
  }
});


test('a fully erased module retains an explicit ESM marker and its comments', async () => {
  const result = compile(samples.Empty.replace(/^#!.*\n/, ''), { file: 'input.mts' });
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /\/\* license \*\//);
  assert.match(result.code, /export \{\};\n$/);
  const empty = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.deepEqual(Object.keys(empty), []);
});

test('type erasure preserves globals, runtime exports and Unicode position padding', async () => {
  const input = 'declare global { interface Window { readonly name: string } }\n' +
    'interface Config { /** 構成 */ value: number }\nexport function read(x: Config) { return x.value; }';
  const result = compile(input);
  assert.equal(result.backend, 'node-strip');
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(loaded.read({ value: 42 }), 42);
});

test('a validated ordinary script emits TypeScript strict semantics', () => {
  const source = 'declare const ambient: string; function read() { return this; }';
  const result = compile(source);
  assert.equal(result.backend, 'node-strip');
  assert.match(result.code, /^"use strict";/);
  assert.equal(Function(result.code + '\nreturn read()')(), undefined);
  const existing = compile('"use\\x20strict"; function read() { return this; }');
  assert.notEqual(existing.backend, 'node-strip');
});

test('parameter properties accept identifiers and object keys containing runtime keywords', () => {
  if (Number(process.versions.node.split('.')[0]) > 25) return;
  const result = compile('export class Box { constructor(public enumerable: number) {} } ' +
    'export const value: object = { namespace: "demo" };');
  assert.equal(result.backend, 'node-transform');
});

test('a static import list can contain hundreds of specifiers', () => {
  const imports = Array.from({ length: 180 }, (_, index) => 'member' + index).join(',');
  const source = 'import {' + imports + '} from "unused"; export function get(): number { return 42; }';
  assert.equal(compile(source).backend, 'node-strip');
});

test('modern JavaScript scripts and modules do not need TypeScript', async () => {
  const script = '/* license */\n"use strict";\nvar result = (function () { return this; })();';
  const emitted = compile(script, { file: 'plain.js' });
  assert.equal(emitted.backend, 'javascript');
  assert.equal(emitted.code, script);
  const sloppy = compile('var result = (function () { return this; })();', { file: 'plain.js' });
  assert.match(sloppy.code, /^"use strict";/);
  const module = 'export const value = 42;';
  const written = compile(module, { file: 'module.mjs' });
  assert.equal(written.backend, 'javascript');
  assert.equal(written.code, module);
});

test('syntax validation is independent of the mutation candidate capacity', async () => {
  const statements = 'result += (0 < 1) + (2 >= 3);\n'.repeat(160);
  const source = 'export let result: number = 0;\n' + statements;
  const result = compile(source);
  assert.equal(result.backend, 'node-strip');
  const actual = await import('data:text/javascript;base64,' + Buffer.from(result.code).toString('base64'));
  assert.equal(actual.result, 160);
  assert.equal(compile(source + 'export { missing };').code, null);
  assert.equal(compile(source + 'export const broken =').code, null);
});

test('JavaScript pass-through declines TypeScript syntax and ambiguous strict directives', () => {
  for (const source of ['export const bad: number = 0;', '"use strict" + effect();']) {
    assert.notEqual(compile(source, { file: 'plain.js' }).backend, 'javascript');
  }
});

test('JavaScript pass-through rejects Annex B HTML comment syntax', () => {
  for (const text of ['<!-- ignored\nconsole.log(1);', ' --> ignored\nconsole.log(1);', '/* ignored */ --> ignored\nvar x = 1;']) {
    assert.equal(compile(text, { file: 'plain.js' }).code, null);
  }
  const ordinary = '"use strict";\n// arrow --> example\nvar text = "-->";';
  const result = compile(ordinary, { file: 'plain.js' });
  assert.equal(result.backend, 'javascript');
  assert.equal(result.code, ordinary);
});

test('plain JavaScript scripts do not load compiler addons on the first call', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/src/compiler.cjs') &&
          /(?:compiler(?:-module)?\\.node|source-text\\.mjs)$/.test(specifier)) throw new Error(specifier);
      return next(specifier, context);
    } });
    const { compile } = await import('./src/compiler.mjs');
    const source = Buffer.from('/* 東京 */ const n = 42;');
    const result = compile(source, { file: 'script.js' });
    assert.equal(result.backend, 'javascript');
    assert.equal(result.code, '"use strict";\\n' + source.toString());
    Object.defineProperty(source, 'length', { value: 1 });
    assert.equal(compile(source, { file: 'script.js' }).code, result.code);
    assert.equal(compile(Buffer.from([0xc0, 0x80]), { file: 'script.js' }).diagnostics[0].code, 'INVALID_ENCODING');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('type erasure diagnoses local exports whose runtime bindings disappeared', () => {
  for (const trivia of [' /* list */ ', ' // list of bindings\n']) {
    const source = 'export const value = 42; interface OnlyType { x: number } export' + trivia + '{ OnlyType };';
    for (const sourceMap of [false, true]) {
      const result = compile(source, { sourceMap });
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'UNBOUND_RUNTIME_EXPORT');
    }
  }
  for (const text of ['export { X } from "elsewhere";', 'export const A = 42; export { A as B };']) {
    assert.notEqual(compile(text).code, null);
  }
});
