import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { inspect } from '../scripts/audit-compiler-coverage.mjs';
import { denseCases } from '../scripts/generate-compiler-validation-cases.mjs';
import { compile } from '../src/compiler.mjs';

const ts = createRequire(import.meta.url)('typescript');

function reference(source, file) {
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true,
  } });
  assert.deepEqual(result.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], source);
  return result.outputText;
}

// Compare the normalized syntax of an emitted module with TypeScript's own emit.
function sameAsTypeScript(source, file) {
  const result = compile(Buffer.from(source), { file });
  assert.equal(typeof result.code, 'string', source);
  assert.deepEqual(inspect(ts, result.code, file), inspect(ts, reference(source, file), file), source);
  return result;
}

test('a JSX element after a keyword stays a separate token', () => {
  const forms = [
    'export function f() { return<div id="a">x</div> }',
    'export function* f() { yield<div/>; }',
    'export const f = (x) => typeof<div/>;',
    'export function f(x) { switch (x) { case<div/>: return 1 } }',
    'export const f = async () => await<div/>;',
    'export function f() { throw<div/> }',
    'export const f = (x) => x instanceof<div/>;',
    'export const f = (x) => x in<div/>;',
    'export const f = () => void<div/>;',
    'export const f = (x) => { if (x) return 1; else<div/> }',
    'export const f = () => { do<div/>; while (0) }',
    'export function f() { return<>x</> }',
  ];
  for (const source of forms) {
    for (const file of ['view.tsx', 'view.jsx']) {
      const result = sameAsTypeScript(source, file);
      assert.doesNotMatch(result.code, /[A-Za-z]_tmt|[a-z]React\.createElement/, source);
    }
    const classic = compile(Buffer.from(source), { file: 'view.tsx', jsx: 'classic' });
    assert.doesNotMatch(classic.code, /[a-z]React\.createElement/, source);
  }
});

test('contextual words bound as variables stay on the native route', () => {
  for (const word of ['as', 'type', 'namespace', 'satisfies']) {
    const source = `export function f(preload: any) {\n  const ${word} = (preload as any)?.${word};\n  let { a: [${word}2] } = preload;\n  return typeof ${word} !== "string" || ${word}.length > 0 ? ${word} : ${word}2;\n}\n`;
    assert.equal(sameAsTypeScript(source, 'words.ts').backend, 'pulse', source);
    const parameter = `export const g = (${word}: number, { ${word}: renamed }: any) => ${word} + renamed;\n`;
    assert.equal(sameAsTypeScript(parameter, 'words.ts').backend, 'pulse', parameter);
  }
});

test('an export list may name more than 64 bindings', () => {
  const names = Array.from({ length: 200 }, (_, index) => 'Name' + index);
  const types = 'export type {\n' + names.map(name => '  ' + name + ',\n').join('') + '} from "./types";\n';
  const values = 'export {\n' + names.map(name => '  ' + name.toLowerCase() + ',\n').join('') + '} from "./values";\n';
  const local = names.map(name => `const ${name.toLowerCase()} = 1;\n`).join('') +
    'export { ' + names.map(name => name.toLowerCase()).join(', ') + ' };\n';
  assert.equal(sameAsTypeScript(values + types, 'index.ts').backend, 'pulse');
  assert.equal(sameAsTypeScript(local, 'local.ts').backend, 'pulse');
});

test('a rest parameter may be a destructuring pattern', () => {
  const source = 'type Pair = [kind: "a", flag?: boolean];\n' +
    'export function f(...[kind, flag]: Pair): void { use(kind, flag); }\n' +
    'export function g(first: number, ...{ length }: string[]) { return first + length; }\n' +
    'export class C { m(...[head = 1, ...tail]: number[]) { return head + tail.length; } }\n';
  assert.equal(sameAsTypeScript(source, 'rest.ts').backend, 'pulse');
});

test('a type declaration as an unbraced statement body is never published unprojected', () => {
  for (const body of ['type S = string;', 'interface S { length: number }']) {
    for (const head of ['if (true)', 'if (false) {} else', 'for (;;)', 'while (true)', 'label:']) {
      const source = `export function f() {\n  ${head} ${body}\n  return 1;\n}\n`;
      const result = compile(Buffer.from(source), { file: 'body.ts' });
      if (result.code !== null) assert.doesNotMatch(result.code, /\btype S\b|\binterface\b/, source);
    }
  }
});

test('a line break after declare keeps the following statements', () => {
  const forms = [
    'var declare: any, module: any;\ndeclare\nmodule\n"external"\n{ }\nexport {};\n',
    'var declare: any, global: any;\ndeclare\nglobal.x;\nexport {};\n',
    'var declare: any;\ndeclare\nmodule "external" { }\nexport {};\n',
    'var declare: any;\ndeclare\nglobal { }\nexport {};\n',
  ];
  for (const source of forms) {
    const result = sameAsTypeScript(source, 'ambient.ts');
    assert.match(result.code, /declare\s*[\n;]/, source);
  }
  const split = compile(Buffer.from('declare module\n"external" { }\nexport {};\n'), { file: 'ambient.ts' });
  assert.equal(split.code, null);
});

test('a statement that TypeScript reads as a global augmentation is not emitted as an expression', () => {
  for (const tail of ['\nA\n{}', ' \nA = 1;', '\nexport const y = 1;', ' { }']) {
    const source = `var global: any, A: any;\nglobal${tail}\nexport {};\n`;
    const result = compile(Buffer.from(source), { file: 'global.ts' });
    assert.notEqual(result.backend, 'pulse', source);
  }
  for (const tail of [';', '.x = 1;', '(1);', ' = 1;', '\n;']) {
    const source = `var global: any;\nglobal${tail}\nexport {};\n`;
    assert.equal(sameAsTypeScript(source, 'global.ts').backend, 'pulse', source);
  }
});

test('an asserted default export object is never published with its type', () => {
  for (const source of ['type Config = { a: number };\nexport default <Config>{ a: 1 };\n',
    'type Config = { a: number };\nexport default <Config>{\n  a: 1,\n}\n']) {
    const result = compile(Buffer.from(source), { file: 'config.ts' });
    assert.equal(typeof result.code, 'string', source);
    assert.doesNotMatch(result.code, /<Config>/, source);
    assert.deepEqual(inspect(ts, result.code, 'config.ts'), inspect(ts, reference(source, 'config.ts'), 'config.ts'), source);
  }
});

test('a statement that TypeScript rejects as a malformed declaration keeps its diagnostic', () => {
  for (const word of ['namespace', 'module', 'readonly', 'accessor']) {
    for (const tail of [' as any;', ' satisfies any;', ' instanceof Object;', ' in {};', ' "name";']) {
      if ((word === 'namespace' || word === 'module') && !/as|satisfies|name/.test(tail)) continue;
      const source = `var ${word}: any;\n${word}${tail}\nexport {};\n`;
      const result = compile(Buffer.from(source), { file: 'word.ts' });
      assert.notEqual(result.backend, 'pulse', source);
    }
    for (const tail of [';', '.x = 1;', '(1);', ' = 1;', '\nfoo;', ' + 1;', '[0];', ' ? 1 : 2;']) {
      const source = `var ${word}: any, foo: any;\n${word}${tail}\nexport {};\n`;
      assert.equal(sameAsTypeScript(source, 'word.ts').backend, 'pulse', source);
    }
  }
});

test('only a literal dot starts a filename extension on the native entry', () => {
  const source = Buffer.from('export const n: number = 1;\n');
  for (const name of ['a\x0ets', 'a\x0ejs', 'a\x0emts', 'a\x0etsx', 'a\x0emjs', 'ats', 'a.t', '.s']) {
    assert.throws(() => compile(source, { file: name }), TypeError, JSON.stringify(name));
  }
  for (const name of ['a.ts', 'A.TS', 'a.Ts', 'a.mts', 'a.MTS', 'a.tsx', '.ts']) {
    assert.equal(compile(source, { file: name }).backend, 'pulse', name);
  }
  for (const name of ['a.d.ts', 'a.D.TS', 'a.d.mts', 'a.d.cts']) {
    assert.equal(compile(source, { file: name }).diagnostics[0].code, 'DECLARATION_INPUT', name);
  }
  assert.equal(compile(Buffer.from('export const n = 1;\n'), { file: 'a.MJS' }).backend, 'javascript');
  assert.equal(compile(Buffer.from('export const n = 1;\n'), { file: 'a.d.tsx' }).backend, 'pulse');
});

test('erased syntax packed against its neighbours matches TypeScript', () => {
  const fixtures = denseCases();
  assert.deepEqual(fixtures, denseCases());
  let native = 0;
  for (const { file, source } of fixtures) {
    const text = Buffer.from(source, 'base64').toString();
    assert.doesNotMatch(text, /[^\S\n]{2}/, file);
    assert.equal(sameAsTypeScript(text, file).backend, 'pulse', file);
    native++;
  }
  assert.equal(native, fixtures.length);
});
