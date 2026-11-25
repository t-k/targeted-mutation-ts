import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { compile } from '../src/compiler.mjs';

const samples = {
  TypeScript: { file: 'input.ts', source: 'export const value: number = 42;', pattern: /42/ },
  JSX: { file: 'input.tsx', source: 'export const value = () => <div>ok</div>;', pattern: /jsx-runtime/ },
  Enum: { file: 'input.ts', source: 'export enum Flag { Ready = 42 }', pattern: /Flag\["Ready"\]\s*=\s*42/ },
  Broken: { file: 'input.ts', source: 'export const value: = 42;' },
};
const matrix = readFileSync(new URL('../verification/pict/compiler-output.tsv', import.meta.url), 'utf8')
  .trim().split(/\r?\n/).slice(1);

for (const line of matrix) {
  const [syntax, target, module, map] = line.split('\t');
  test(`compiler output: ${line.replaceAll('\t', ' ')}`, () => {
    const { file, source, pattern } = samples[syntax];
    const result = compile(source, { file, target: target === 'ES2018' ? 'es2018' : 'esnext',
      module: module === 'CJS' ? 'cjs' : 'preserve', sourceMap: map === 'On' });
    if (syntax === 'Broken') {
      assert.equal(result.code, null);
      assert.equal(result.sourceMap, null);
      assert.equal(result.diagnostics[0].severity, 'error');
      assert.ok(result.diagnostics[0].start > 0);
      return;
    }
    assert.deepEqual(result.diagnostics, []);
    assert.match(result.code, pattern);
    assert.doesNotMatch(result.code, /: number|<div>|sourceMappingURL=/);
    assert.match(result.code, module === 'CJS' ? /exports\./ : /\bexport\b/);
    assert.equal(Boolean(result.sourceMap), map === 'On');
    if (result.sourceMap) {
      assert.equal(result.sourceMap.version, 3);
      assert.deepEqual(result.sourceMap.sources, [file]);
      assert.deepEqual(result.sourceMap.sourcesContent, [source]);
    }
  });
}

test('lowering emits runnable CommonJS, including runtime TypeScript', () => {
  const source = 'enum State { Ready = 42 } export const value = ({state: State.Ready})?.state ?? 0;';
  const result = compile(source, { file: 'runtime.cts', target: 'es2018' });
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotMatch(result.code, /\?\.|\?\?/);
  const exports = {};
  vm.runInNewContext(result.code, { exports }, { timeout: 1000 });
  assert.equal(exports.value, 42);
});

test('compile supports JS, explicit JSX preservation and CJS to ESM overrides', () => {
  const js = compile('export const id = (x) => x;', { file: 'source.mjs' });
  assert.deepEqual(js.diagnostics, []);
  assert.match(js.code, /export const id/);
  const jsx = compile('export const div = <div/>;', { file: 'source.jsx', jsx: 'preserve' });
  assert.match(jsx.code, /<div\s*\/>/);
  const esm = compile('export const id = 42;', { file: 'source.cts', module: 'esm', sourceMap: true });
  assert.match(esm.code, /export const id/);
  assert.deepEqual(esm.sourceMap.sources, ['source.cts']);
});

test('strip preserves offsets and rejects TypeScript that needs runtime transforms', () => {
  const plain = 'const value: number = 42;\r\nconsole.log(value);';
  const result = compile(plain, { mode: 'strip' });
  assert.equal(result.code, 'const value         = 42;\r\nconsole.log(value);');
  assert.equal(result.sourceMap, null);
  assert.deepEqual(result.diagnostics, []);
  const runtime = compile('enum State { Ready }', { mode: 'strip' });
  assert.equal(runtime.code, null);
  assert.ok(runtime.diagnostics.length);
  assert.throws(() => compile(plain, { mode: 'strip', sourceMap: true }), /strip/);
});

test('invalid input and declaration files produce no output', () => {
  for (const [input, options] of [[Buffer.from([255]), {}], ['\ud800', {}],
    ['declare const value: number;', { file: 'ambient.d.mts' }]]) {
    const r = compile(input, options);
    assert.equal(r.code, null);
    assert.equal(r.sourceMap, null);
    assert.equal(r.diagnostics[0].severity, 'error');
  }
});

test('CLI emits compilable code or diagnostics and a nonzero exit', () => {
  const run = source => spawnSync(process.execPath, ['bin/tmt-compile.mjs', '--file', 'stdin.ts', '--source-map', '-'],
    { input: source, encoding: 'utf8', timeout: 20000 });
  const pass = run('export const value = 42;');
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /export const value = 42/);
  assert.match(pass.stdout, /sourceMappingURL=data:application\/json;base64,/);
  const fail = run('export const value = ;');
  assert.equal(fail.status, 1);
  assert.equal(fail.stdout, '');
  assert.match(fail.stderr, /stdin\.ts/);
});

test('ES6 and ES2015 produce the same program', () => {
  const source = 'export const read = (record: { name: string }) => record?.name;';
  assert.equal(compile(source, { target: 'es6' }).code, compile(source, { target: 'es2015' }).code);
  assert.ok(compile(source, { target: 'es6' }).code);
});

test('incompatible module transforms report diagnostics instead of losing runtime behavior', () => {
  for (const source of ['export = 42;', 'import lib = require("lib"); export const value = lib.read();']) {
    for (const options of [{ file: 'input.cts', module: 'esm' }, { file: 'input.mts' }]) {
      const result = compile(source, options);
      assert.equal(result.code, null);
      assert.equal(result.diagnostics[0].code, 'INCOMPATIBLE_MODULE_SYNTAX');
    }
  }
  const cjs = compile('export const value = await Promise.resolve(5);', { module: 'cjs' });
  assert.equal(cjs.code, null);
  assert.equal(cjs.diagnostics[0].code, 'INVALID_COMMONJS_OUTPUT');
});

test('JSX preserve retains JSX syntax with the requested module lowering', () => {
  const result = compile('export const element = <div/>;', { file: 'input.tsx', module: 'cjs', jsx: 'preserve' });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.code, /exports\.element.*<div\s*\/>/);
});

test('strip mode keeps its TypeScript filename contract', () => {
  for (const file of ['input.js', 'input.jsx', 'input.tsx']) {
    assert.equal(compile('const x: number = 42;', { file, mode: 'strip' }).diagnostics[0].code, 'STRIP_DIALECT');
  }
});

test('an .mts file without imports or exports is compiled as a module, and a TypeScript printer failure is a diagnostic', () => {
  for (const source of ['await 1;', 'const a: number = 1;']) {
    const result = compile(source, { file: 'input.mts' });
    assert.equal(typeof result.code, 'string', source);
    assert.doesNotMatch(result.code, /use strict/, source);
  }
  assert.match(compile('const a: number = 1;', { file: 'input.cts' }).code, /^"use strict";/);
  // TypeScript 6.0.3 fails inside its printer on a private name behind an optional chain in a return statement.
  const failed = compile('class C { #f = 1; static t(o) { return o?.c.#f; } }', { file: 'input.ts' });
  assert.equal(failed.code, null);
  assert.equal(failed.diagnostics.length > 0, true);
  assert.equal(failed.diagnostics[0].severity, 'error');
});

test('a TypeScript file of comments and white space alone is a strict script', () => {
  for (const [source, file] of [['// mock', 'a.ts'], ['/* c */\n', 'a.ts'], ['', 'a.ts'], ['  \n', 'a.tsx']]) {
    const result = compile(source, { file });
    assert.equal(result.backend, 'pulse', JSON.stringify(source));
    assert.equal(result.code, '"use strict";\n' + source);
    assert.deepEqual(compile(Buffer.from(source), { file }), result);
  }
  // A well-formed reference directive is a comment like any other.
  assert.deepEqual(compile('/// <reference path="a" />\n', { file: 'a.ts' }),
    { backend: 'pulse', code: '"use strict";\n/// <reference path="a" />\n', sourceMap: null, diagnostics: [] });
  // A hashbang, a malformed reference, an unterminated comment and a module extension take other routes.
  for (const [source, file] of [['#!/usr/bin/env node\n// a', 'a.ts'], ['/// <reference />\n', 'a.ts'], ['/* open', 'a.ts'], ['// a', 'a.mts']]) {
    assert.notEqual(compile(source, { file }).backend, 'pulse', JSON.stringify(source));
  }
});

test('review findings: a hashbang behind a byte order mark, a hashbang line ending in CRLF, and assertions that regroup operators', () => {
  // TypeScript reports a hashbang that is not at the very start of the file.
  for (const input of ['﻿#!/usr/bin/env node\nconsole.log("ok");', Buffer.from('﻿#!/usr/bin/env node\nconsole.log("ok");')]) {
    const result = compile(input, { file: 'cli.ts' });
    assert.equal(result.code, null);
    assert.equal(result.diagnostics[0].code, 18026);
  }
  // The strict directive follows the whole line break of the interpreter line, which is written with a line feed.
  const script = compile('#!/usr/bin/env node\r\nfunction main() { var status = "ok"; console.log(status); }\r\nmain();', { file: 'cli.ts' });
  assert.equal(script.code.startsWith('#!/usr/bin/env node\n"use strict";\n'), true);
  // ((a + b) as T) * c: blanking the assertion would leave a + b * c. Node's erasure does that, so it is not used.
  for (const [source, expected] of [
    ['export const v = subtotal + tax as number * quantity;', /\(subtotal \+ tax\) \* quantity/],
    ['export const v = a << b as number + c;', /\(a << b\) \+ c/],
  ]) {
    const result = compile(source, { file: 'a.ts' });
    assert.match(result.code, expected, source);
    assert.equal(compile(source, { file: 'a.ts', mode: 'strip' }).diagnostics[0].code, 'AMBIGUOUS_TYPE_ERASURE');
  }
  const element = compile('export const label = <span>{subtotal + tax as number * quantity}</span>;', { file: 'a.tsx', jsx: 'classic' });
  assert.match(element.code, /\(subtotal \+ tax\) \* quantity/);
  // An assertion with nothing arithmetic behind it is erased as before.
  assert.equal(compile('export const v = x as number;', { file: 'a.ts', mode: 'strip' }).code, 'export const v = x          ;');
});
