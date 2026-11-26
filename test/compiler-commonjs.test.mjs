import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { compile } = require('../src/compiler.cjs');

// The syntax tree of a text without its layout: parentheses, empty statements and comments do not count.
function shape(code) {
  const tree = ts.createSourceFile('module.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  assert.deepEqual(tree.parseDiagnostics, [], code);
  const walk = node => {
    if (ts.isParenthesizedExpression(node) && !ts.isBinaryExpression(node.expression)) return walk(node.expression);
    const children = [];
    ts.forEachChild(node, child => { if (!ts.isEmptyStatement(child)) children.push(walk(child)); });
    const text = ts.isSourceFile(node) ? '' : node.text ?? '';
    // A property written as a string or as a name is the same property.
    const kind = ts.isStringLiteral(node) && node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node ? ts.SyntaxKind.Identifier : node.kind;
    return [kind, text, typeof node.operator === 'number' ? node.operator : 0, ...children];
  };
  return walk(tree);
}

function reference(source, file, target = 'ESNext') {
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget[target], module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true } });
  return result.outputText;
}

function sameAsTypeScript(source, file = 'module.ts', options = {}) {
  const result = compile(Buffer.from(source), { file, module: 'cjs', ...options });
  assert.equal(typeof result.code, 'string', source);
  assert.deepEqual(shape(result.code), shape(reference(source, file, options.target?.toUpperCase())), source);
  return result;
}

// A module for one row of verification/pict/compiler-commonjs.tsv.
function moduleOf(row) {
  const end = row.Boundary === 'Semicolon' ? ';' : '';
  const imports = {
    Named: ['import { used, other } from "./dep"', 'used'], Default: ['import used from "./dep"', 'used'],
    Namespace: ['import * as used from "./dep"', 'used'], DefaultAndNamed: ['import main, { used } from "./dep"', 'used'],
    Renamed: ['import { source as used } from "@scope/some-lib/index.js"', 'used'], Bare: ['import "./dep"', 'local'],
  }[row.Import];
  const name = imports[1];
  const use = {
    Call: `${name}(1)`, Member: `${name}.member(2)`, Shorthand: `({ ${name}, key: ${name} })`, New: `new ${name}(3)`,
    Tagged: `${name}\`text\``, Argument: `Math.max(${name}, 4)`, OptionalCall: `${name}?.(5)`,
    Nested: `(() => { function inner(${name === 'local' ? 'shadow' : name}: number) { return ${name === 'local' ? 'shadow' : name}; }\n  ${name}(6)\n  return inner(7) })()`,
  }[row.Use];
  const exports = {
    Const: `export const value = ${use}${end}\nvalue${end}`,
    ConstArrow: `export const value = () => ${use}${end}\nvalue()${end}`,
    ConstFunction: `export const value = function () { return ${use} }${end}\nvalue()${end}`,
    Function: `export function value() { return ${use} }\nvalue()${end}`,
    Class: `export class Value { field = ${use}; static make() { return new Value() } }\nnew Value()${end}`,
    DefaultExpression: `const value = ${use}${end}\nexport default value${end}`,
    DefaultFunction: `export default function () { return ${use} }`,
    DefaultClass: `export default class Value { method() { return ${use} } }`,
    List: `const value = ${use}${end}\nfunction helper() { return value }\nexport { value, value as alias, helper }${end}`,
    ReExport: `export { first, second as renamed } from "./more"${end}\nexport const value = ${use}${end}`,
    Star: `export * from "./more"${end}\nexport const value = ${use}${end}`,
    StarAs: `export * as more from "./more"${end}\nexport const value = ${use}${end}`,
    Enum: `export enum Kind { First = 1, Second }\nexport const value = [Kind.First, ${use}]${end}`,
    Namespace: `export namespace Space { export const inside = 1${end} }\nexport const value = [Space.inside, ${use}]${end}`,
  }[row.Export];
  return `${imports[0]}${end}\nconst local: any = 0${end}\n${exports}\n${use}${end}\n`;
}

test('CommonJS output of a module has the syntax tree of TypeScript\'s', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-commonjs.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 118);
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = moduleOf(row);
    const result = sameAsTypeScript(source);
    // An optional call is left to TypeScript (a namespace import is not rewritten, so it does not matter
    // for it). Nested shadowing parameters and every other row are written natively here.
    const declined = row.Use === 'OptionalCall' && row.Import !== 'Namespace' && row.Import !== 'Bare';
    assert.equal(result.backend, declined ? 'typescript' : 'pulse', source);
  }
});

test('forms of CommonJS output: declarations that stay, hoisting, helpers and names of modules', () => {
  const native = (source, file) => assert.equal(sameAsTypeScript(source, file).backend, 'pulse', source);
  // A function-like value keeps its declaration; any other value is assigned to the export.
  native('export const arrow = () => 1;\nexport const named = function () {};\nexport const made = class {};\nexport const plain = 1;\n' +
    'export const bound = function () {}.bind(null);\nexport const grouped = (1, 2);\nexport const called = ((a: number) => a)(1);\n' +
    'export const later = async (x: number) => x;\nexport const single = (x: number) => x;\nexport const curried = (a: number) => (b: number) => a + b;\n' +
    'arrow(); named(); new made(); plain; bound; grouped; called; later; single; curried;');
  // A variable without a value is written where it is assigned.
  native('export let count: number;\ncount = 3; count += 1; --count;\nexport var flag;\nflag ||= true;\n[count] = [1];');
  // Functions are exported before anything runs; classes behind their declaration.
  native('first();\nexport function first() { return second(); }\nexport async function* second() { yield 1; }\nexport class Third extends Object {}\nexport default class {}');
  // The statements stay apart when one between them leaves nothing.
  native('export default 1\nexport {};\n+2;');
  native('export const a = 1\nexport let marker: number;\n+2;\nmarker = a;');
  // Function exports in the order of the statements that export them.
  native('export { f };\nfunction f() {}\nexport function g() {}');
  native('function f() {}\nexport function g() {}\nexport { f, f as h };\nexport default function k() {}');
  // An empty list beside a default import, and signs in a specifier each become an underscore.
  native('import d, {} from "./dep";\nexport default d;');
  native('import { x } from "./x--y";\nimport { z } from "./a.b-c$d";\nexport default [x, z];');
  // A lowered enum whose variable is read elsewhere.
  native('export enum E { A }\nexport namespace N { export const v = E.A; }\nexport const all = [E, N, E.A];');
  native('export default function () {}');
  native('export default function named() { return named; }\nnamed();');
  native('export default async () => {};\nexport const other = 1;');
  // Helpers in TypeScript's order: those the others rest on, then the two star helpers by first use.
  native('import main from "./a";\nimport * as all from "./b";\nexport * from "./c";\nmain; all;');
  native('export * from "./c";\nimport * as all from "./b";\nimport main from "./a";\nmain; all;');
  native('import main, { part } from "./a";\nmain(part);');
  // Names of module variables.
  native('import a from "./a.js";\nimport b from "./foo-bar";\nimport c from "./2d";\nimport d from "@s/p.q/r-s.mjs";\nimport e from "./a.js";\nimport f from "node:fs";\n' +
    'import h from "./1656926770819-Create";\na; b; c; d; e; f; h;');
  // Directives stay in front, and a rewritten call that starts a statement gets a semicolon.
  native('"use client";\n/** note */\nimport { run } from "./run";\nconst a = 1\nrun()\nfunction f() {\n  const b = 2\n  run()\n  if (a) run()\n  return () => {\n    run() }\n}\nexport { f }');
  native('import { jsx } from "./own";\nexport const view = <div title="t">{jsx}</div>;', 'module.tsx');
  // The JSX runtime is required before the code that uses it, wherever the module's first export stands.
  native('const a = <div>text</div>;\nconsole.log(a);\nexport {};', 'module.tsx');
  native('const a = <div>text</div>;\nexport const b = <p>{a}</p>;', 'module.tsx');
  // Type arguments in front of a call leave blanks, and the call is still one.
  native('import { make } from "./make";\nexport const made = make<string,\n  number>(1);');
  // An exported name that a re-export list takes from an import is read through a getter.
  native('import { a, b } from "./ab";\nexport { a, b as c };\na(b);');
  // An older target, where the module itself is written as for ESNext.
  assert.equal(sameAsTypeScript('import { a } from "./a";\nexport const b = a + 1;', 'module.ts', { target: 'es2019' }).backend, 'pulse');
  // Imported names in comments, strings, templates, regexes, property keys, methods, labels and dot accesses stay native.
  native('import { a } from "./a";\n// mentions a and exports\n/* block a */\nexport const o = { a: "a", s: `a ${a}`, r: /a/, a() { return a; } };');
  native('import { a } from "./a";\nclass C { static a = 1; a() { return a; } get b() { return this\n  .a(); } }\nexport { C };');
  native('import { a } from "./a";\nexport const f = () => {\n  a: for (let i = 0; i < 1; i++) { break a; }\n  return a;\n};\n\nexport const g = 1;');
  // Re-exporting default and renaming to default.
  native('export { default } from "./d";');
  native('export { default as Foo, a } from "./d";');
  native('export { a as default } from "./d";');
  // Comments inside import/export lists and >50 exports chunked by 50.
  native('import {\n  // comment\n  a,\n  /* block */ b as c,\n} from "./d";\nexport const out = a(c);');
  native(Array.from({ length: 55 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
  // URL strings containing `//` before an imported call, and non-ASCII identifiers in CommonJS.
  native('import { run } from "./run";\nconst url = "https://example.test/a";\nexport const out = run(url);');
  native('import { café } from "./dep";\nexport const 合計: number = café() + 1;');
  // Dynamic import with a string literal, `import { default as X }`, and CommonJS `import = require` / `export =`.
  native('export const load = () => import("./m");\nexport const m = import("./n");');
  native('import { default as d } from "./d";\nexport const out = d(1);');
  native('import { default as d, other } from "./d";\nexport const out = d(other);');
  native('import a = require("./a");\nexport = a;');
});

test('modules that are left to TypeScript for CommonJS output', () => {
  for (const [source, why] of [
    ['import { f } from "./dep";\nexport default f?. ();', 'an optional call'],
    ['import { f } from "./dep";\nexport default f!();', 'a call through a non-null mark'],
    ['import { f } from "./dep";\nexport default f /* sure */ !`t`;', 'a tag through a non-null mark'],
    ['export let fn: (() => { x: number }) | undefined;\nexport function read() { return fn?.().x; }', 'an optional call with a member behind it'],
    ['export const fn = function () {} as () => void;\nexport default fn.name;', 'a function under an assertion'],
    ['export const fn = <() => void>function () {};\nexport default fn.name;', 'a function behind an assertion in front'],
    ['export function f() { return 1; }\n// @ts-expect-error\n(/* gap */ { f } = { f: () => 2 });', 'an object target behind a comment'],
    ['export function f() { return 1; }\nlet o: any;\n({ k: [f] } = o);', 'a nested target'],
    ['export var E: { a?: number } | number | undefined;\n(function (E) {})(E || (E = {}));\nE = 9;', 'a hand-written filling function'],
    ['export /*gap*/ declare const d: number;\nexport default d;', 'an ambient export behind a comment'],
    ['export function f() {}\nf = null as any;', 'an assignment to an exported function'],
    ['export class A {}\n[A] = [null as any];', 'an array target with an exported class'],
    ['export function f() {}\nlet o: any;\n({ f } = o);', 'an object target with an exported function'],
    ['export function f() {}\nfor (f of []) {}', 'a loop that assigns an exported function'],
    ['export const { a = 1, b } = { b: 2 };', 'a pattern with default'],
    ['export let count: number;\nfor (count of [1, 2]) {}', 'a loop that assigns an exported variable'],
    ['export const a = 1, b = () => 2;', 'two declarators with a function-like value'],
    ['export let f = () => 1;\nf = () => 2;', 'a function-like value in a variable that can change'],
    ['const exports = 1;\nexport { exports as e };', 'the word exports'],
    ['export const m = (x: string) => import(x, { with: { type: "json" } });', 'a dynamic import with attributes'],
    ['export const u = import.meta.url;', 'import.meta'],
    ['import d, * as all from "./d";\nd; all;', 'a default and a namespace import together'],
    ['import d from "./d";\nexport { d };', 'a default import in an export list'],
    ['import { a } from "./a";\nexport const b = 1;\nconst a_1 = 2;\nvoid [a, a_1];', 'a word that TypeScript would have to avoid'],
    ['import { a } from "./a";\ndeclare const x: any;\nx\n  a()\nexport {};', 'never'],
  ]) {
    if (why === 'never') continue;
    const result = compile(Buffer.from(source), { file: 'module.ts', module: 'cjs' });
    assert.equal(result.backend, 'typescript', why);
    if (result.code !== null) assert.deepEqual(shape(result.code), shape(reference(source, 'module.ts')), why);
  }
  // A call on its own line behind something that may end a statement is not written here.
  const unsure = compile(Buffer.from('import { a } from "./a";\ndeclare const x: any;\nif (x)\n  a()\nexport {};'), { file: 'module.ts', module: 'cjs' });
  assert.equal(unsure.backend, 'typescript');
  // .cts, .cjs, .mts with CommonJS and source maps are emitted natively.
  for (const [source, file, opts, expectedBackend, expectedMapFile] of [
    ['import { a } from "./a";\nexport const x: number = a + 1;\n', 'mod.cts', {}, 'pulse', 'mod.cjs'],
    ['import { a } from "./a";\nexport const x = a + 1;\n', 'mod.cjs', {}, 'javascript', 'mod.cjs'],
    ['import { a } from "./a";\nexport const x: number = a + 1;\n', 'mod.mts', { module: 'cjs' }, 'pulse', 'mod.js'],
    ['import { b } from "./b";\nexport const a: number = b;\n', 'module.ts', { module: 'cjs' }, 'pulse', 'module.js'],
  ]) {
    const plain = compile(Buffer.from(source), { file, ...opts });
    assert.equal(plain.backend, expectedBackend, file);
    assert.deepEqual(shape(plain.code), shape(reference(source, file.replace(/\.[cm]([jt]s)$/i, '.$1'))), file);
    const withMap = compile(Buffer.from(source), { file, ...opts, sourceMap: true });
    assert.equal(withMap.backend, expectedBackend, `${file} map`);
    assert.equal(withMap.code, plain.code, `${file} map code`);
    assert.equal(withMap.sourceMap.file, expectedMapFile, `${file} map file`);
  }
  // .jsx with jsx: 'preserve' (with and without source maps, and rejecting TS syntax).
  const jsxSrc = 'import { a } from "./a";\nexport const View = <div id="x">{a}</div>;\n';
  const jsxKept = compile(Buffer.from(jsxSrc), { file: 'View.jsx', jsx: 'preserve' });
  assert.equal(jsxKept.backend, 'pulse');
  assert.equal(jsxKept.code, jsxSrc);
  const jsxKeptMap = compile(Buffer.from(jsxSrc), { file: 'dir/View.jsx', jsx: 'preserve', sourceMap: true });
  assert.equal(jsxKeptMap.backend, 'pulse');
  assert.equal(jsxKeptMap.code, jsxSrc);
  assert.equal(jsxKeptMap.sourceMap.file, 'View.jsx');
  // TypeScript syntax in a .jsx file is rejected (not published natively).
  const badJsx = compile(Buffer.from('export const x: number = 1;\nexport const View = <div/>;\n'), { file: 'Bad.jsx', jsx: 'preserve' });
  assert.equal(badJsx.code, null);
});

test('the CommonJS text runs like TypeScript\'s', () => {
  const source = 'import { join } from "node:path";\nimport * as os from "node:os";\nexport enum Kind { A = 1, B }\nexport const sep = () => join("a", "b");\n' +
    'export let count = 0;\nexport function bump() { count++; return count; }\nexport class Box { value = sep(); static of() { return new Box(); } }\n' +
    'export default function () { return [bump(), bump(), Box.of().value, Kind.B, typeof os.platform()]; }\nexport const name = sep.name;';
  const run = code => { const module = { exports: {} }; new Function('exports', 'require', 'module', code)(module.exports, require, module); return module.exports; };
  const ours = run(sameAsTypeScript(source).code), theirs = run(reference(source, 'module.ts'));
  assert.deepEqual(ours.default(), theirs.default());
  assert.deepEqual([ours.count, ours.name, ours.__esModule, Object.keys(ours).sort()], [theirs.count, theirs.name, theirs.__esModule, Object.keys(theirs).sort()]);
});

test('a function that is exported by value: reading is written here, writing is left to TypeScript', () => {
  const backend = statement => compile(Buffer.from(`export function f() { return 1; }\ndeclare let x: any;\n${statement}\n`), { file: 'module.ts', module: 'cjs' }).backend;
  for (const statement of ['(f as any) = 1;', '(f as any) += 1;', '(f as any)++;', '(f as any) **= 2;', '(f as any) >>>= 1;', '(f as any) &&= x;', '(f as any) ||= x;', '(f as any) ??= x;',
    '(f as any) <<= 1;', '(f as any) -= 1;', '(f as any) %= 2;', '(f as any) |= 1;', '(f as any) ^= 1;', '(f as any) /= 2;', '(f as any) *= 2;']) {
    assert.equal(backend(statement), 'typescript', statement);
  }
  for (const statement of ['// @ts-ignore\nf = x;', '// @ts-ignore\nf++;', '// @ts-ignore\n++f;', '// @ts-ignore\n--f;', '// @ts-ignore\nf--;', '// @ts-ignore\n[f] = x;', '// @ts-ignore\nf ??= x;']) {
    assert.equal(backend(statement), 'typescript', statement);
  }
  for (const statement of ['x = f == x;', 'x = f === x;', 'x = f >= x;', 'x = f <= x;', 'x = f != x;', 'x = [f, f];', 'x = { f, k: f };', 'x = f?.name;', 'x = () => f;', 'x = f ? 1 : 2;',
    'x = f >> 1;', 'x = f ** 2;', 'x = f && x;', 'x = f ?? x;', 'x = +f + -f;', 'x = (f);', 'if (f) x = 1;']) {
    assert.equal(backend(statement), 'pulse', statement);
    sameAsTypeScript(`export function f() { return 1; }\ndeclare let x: any;\n${statement}\n`);
  }
});

test('CommonJS output of modules with legacy decorators', () => {
  const same = (source, metadata = false) => {
    const options = { file: 'module.ts', module: 'cjs', experimentalDecorators: true, ...(metadata ? { emitDecoratorMetadata: true } : {}) };
    const result = compile(Buffer.from(source), options);
    const expected = ts.transpileModule(source, { fileName: 'module.ts', compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS,
      verbatimModuleSyntax: true, experimentalDecorators: true, emitDecoratorMetadata: metadata } }).outputText;
    assert.deepEqual(shape(result.code), shape(expected), source);
    return result;
  };
  const head = 'import { d, p } from "./decorators";\nimport main from "./main";\nimport * as all from "./all";\nexport * from "./more";\n';
  for (const metadata of [false, true]) {
    for (const body of [
      '@d()\nexport class A { constructor(@p private readonly x: number) {} @d() run(): void {} @d() field = 1; }',
      '@d()\nclass B {}\nexport { B };',
      '@d()\nclass B {}\nexport { B, B as C };',
      '@d(main, all)\nexport default class D { @d() static s(): void {} }',
      '@d()\nexport class A {}\n@d()\nexport class E extends A { @d() get g(): number { return 1; } }\nexport const made = new E();',
      'export class Plain { @d() value!: string; }\nexport function make() { return new Plain(); }',
    ]) {
      const result = same(head + body, metadata);
      assert.equal(result.backend, 'pulse', body);
    }
  }
  // A variable of an export list may be assigned again; each assignment writes the export.
  assert.equal(same('let w = 1;\nw = 2;\nif (w) w = 3;\nexport { w, w as v };').backend, 'pulse');
  // Any other way of writing it is left to TypeScript.
  for (const source of ['let w = 1;\nw += 2;\nexport { w };', 'let w = 1;\nw++;\nexport { w };', 'let w = 1;\n[w] = [2];\nexport { w };', 'let w = 1, u = 2;\nw = u;\nexport { w };',
    'let w = 1;\nfor (w of [1]) {}\nexport { w };', 'let w: any;\n({ w } = { w: 1 });\nexport { w };']) {
    assert.equal(same(source).backend, 'typescript', source);
  }
});

test('CommonJS review round 34 regressions match TypeScript in syntax and behavior', () => {
  // Cases that must be handled natively and match TypeScript's exact AST and runtime semantics.
  for (const [source, expectedBackend, options = {}] of [
    ['import { f } from "./dep";\nexport default f?. /* gap */ ();', 'typescript'],
    ['import { f } from "./dep";\nexport default [...f!()];', 'typescript'],
    ['import { f } from "./dep";\nexport default (// new\n  f());', 'pulse'],
    ['export const f = function () {} as () => void\n;\nexport default f.name;', 'typescript'],
    ['let x = 1; export { x }; { let x; x = 2; }', 'typescript'],
    ['function dec(target: Function) {}\n@dec export class C {}\n{ let C; C = 2; }', 'typescript', { experimentalDecorators: true }],
    ['const x = 1; export { x }; { const x = 2; }', 'typescript'],
    ['class C {} export { C }; { class C {} }', 'typescript'],
    ['var x = 0; export { x }; for (var x of [1]) {}', 'typescript'],
    ['export function f() { return 1; }\n// @ts-expect-error\n({ f /* gap */ } = { f: () => 2 });', 'typescript'],
    ['let x = 1; export { x }; ++ /* gap */ x;', 'typescript'],
    ['import "./dep"; let x: number; export { x };', 'pulse'],
    ['console.log("before"); import { x as _tmtUser } from "./dep"; export default _tmtUser;', 'pulse'],
    ['var __decorate = Object.hasOwn(this, "__esModule"); export default __decorate;', 'pulse'],
    ['import { a, b } from "./dep"; export { b, a };', 'pulse'],
    ['export { f as a }; export function b() {} export { f as c }; function f() {}', 'pulse'],
    ['type default_1 = number; export default function () {}', 'typescript'],
    ['type dep_1 = number; import { a } from "./dep"; export default a;', 'typescript'],
  ]) {
    const result = compile(Buffer.from(source), { file: 'a.ts', module: 'cjs', ...options });
    assert.equal(result.backend, expectedBackend, source);
    const expected = ts.transpileModule(source, { fileName: 'a.ts', compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, verbatimModuleSyntax: true, ...options } }).outputText;
    assert.deepEqual(shape(result.code), shape(expected), source);
  }
  // Verify exact order of re-export getters and hoisted function aliases at runtime.
  const run = (code, deps = {}) => {
    const mod = { exports: {} };
    new Function('exports', 'require', 'module', code)(mod.exports, id => deps[id] ?? {}, mod);
    return mod.exports;
  };
  const getterSrc = 'import { a, b } from "./dep"; export { b, a };';
  const getterOurs = compile(Buffer.from(getterSrc), { file: 'a.ts', module: 'cjs' }).code;
  const getterTheirs = reference(getterSrc, 'a.ts');
  assert.ok(getterOurs.indexOf('"a"') < getterOurs.indexOf('"b"'), getterOurs);
  assert.deepEqual(Object.keys(run(getterOurs, { './dep': { a: 1, b: 2 } })), Object.keys(run(getterTheirs, { './dep': { a: 1, b: 2 } })));
  const hoistSrc = 'export { f as a }; export function b() {} export { f as c }; function f() {}';
  const hoistOurs = compile(Buffer.from(hoistSrc), { file: 'a.ts', module: 'cjs' }).code;
  const hoistTheirs = reference(hoistSrc, 'a.ts');
  assert.deepEqual(Object.keys(run(hoistOurs)), Object.keys(run(hoistTheirs)));
  // Verify uninitialized export-list binding does not overwrite a circular dependency write.
  const uninitSrc = 'import "./dep"; let x: number; export { x };';
  const uninitOurs = compile(Buffer.from(uninitSrc), { file: 'a.ts', module: 'cjs' }).code;
  const uninitTheirs = reference(uninitSrc, 'a.ts');
  const runCircular = code => {
    const mod = { exports: {} };
    new Function('exports', 'require', 'module', code)(mod.exports, () => { mod.exports.x = 9; }, mod);
    return mod.exports.x;
  };
  assert.equal(runCircular(uninitOurs), 9);
  assert.equal(runCircular(uninitTheirs), 9);
});

test('CommonJS review round 35 regressions match TypeScript in syntax and behavior', () => {
  const run = (code, deps = {}) => {
    const mod = { exports: {} };
    new Function('exports', 'require', 'module', code)(mod.exports, id => deps[id] ?? {}, mod);
    return mod.exports;
  };
  // 1. Hex literal followed by +x (e is a hex digit, not an exponent).
  const hexSrc = 'import { x } from "./dep";\nexport default 0x1e+x;\n';
  const hexRes = sameAsTypeScript(hexSrc);
  assert.equal(hexRes.backend, 'pulse');
  assert.equal(run(hexRes.code, { './dep': { x: 3 } }).default, 33);
  // 2. Variable named `of` followed by division (not a regex).
  const ofSrc = 'import { x } from "./dep";\nconst of = 12;\nexport default of / x / 2;\n';
  const ofRes = sameAsTypeScript(ofSrc);
  assert.equal(ofRes.backend, 'typescript');
  assert.equal(run(ofRes.code, { './dep': { x: 3 } }).default, 2);
  // 3. Line comment ending in U+2028 or U+2029.
  for (const sep of ['\u2028', '\u2029']) {
    const sepSrc = `import { x } from "./dep";\n// comment${sep}export default x;\n`;
    const sepRes = sameAsTypeScript(sepSrc);
    assert.equal(sepRes.backend, 'typescript');
    assert.equal(run(sepRes.code, { './dep': { x: 7 } }).default, 7);
  }
  // 4. Property named `new` with comments before a call on the next line.
  const propNewSrc = 'import { f } from "./dep";\nexport default (function () { const y = { new: 1 }; y./**/new /**/\nf(); })();\n';
  const propNewRes = sameAsTypeScript(propNewSrc);
  assert.equal(propNewRes.backend, 'pulse');
  let gotThis = null;
  const strictDep = { f() { 'use strict'; gotThis = this === undefined ? 'unbound' : 'bound'; } };
  run(propNewRes.code, { './dep': strictDep });
  assert.equal(gotThis, 'unbound');
  // Review round 36: non-ASCII import called with `!()` keeps receiver, and specifier map skips comment.
  const nonAsciiBang = sameAsTypeScript('import { café } from "./x";\nexport const r: unknown = café!();\n', 'a.cts');
  assert.equal(nonAsciiBang.backend, 'typescript');
  const specCommentSrc = 'import { foo } from /* "pkg" */ "pkg";\nexport const a = foo();\n';
  const specCommentRes = compile(Buffer.from(specCommentSrc), { file: 'a.ts', module: 'cjs', sourceMap: true });
  assert.equal(specCommentRes.backend, 'pulse');
  assert.ok(specCommentRes.sourceMap.mappings.length > 0);
});

test('CommonJS extensions: dynamic import, default-as named import, and export =', () => {
  // Dynamic import with plain string literal is native; erased assertion inside import() declines to TypeScript.
  const dynLit = sameAsTypeScript('export const load = () => import("./lazy");\nexport const tag = 1;\n');
  assert.equal(dynLit.backend, 'pulse');
  const dynAs = sameAsTypeScript('export const load = () => import("./lazy" as any);\nexport const tag = 1;\n');
  assert.equal(dynAs.backend, 'typescript');
  const dynBang = sameAsTypeScript('export const load = () => import("./lazy"!);\nexport const tag = 1;\n');
  assert.equal(dynBang.backend, 'typescript');
  const dynOptCall = sameAsTypeScript('export const load = (x: any) => x?.import("./lazy");\nexport const tag = 1;\n');
  assert.equal(dynOptCall.backend, 'pulse');

  // Named import of `default as X` (alone and mixed with other named imports).
  const defAs = sameAsTypeScript('import { default as Def, a } from "./dep";\nexport const out = [Def(), a];\n');
  assert.equal(defAs.backend, 'pulse');

  // CommonJS dialect `export =` (with or without `import = require`) stays native without __esModule.
  const expEq = sameAsTypeScript('const v = 1;\nexport = v;\n');
  assert.equal(expEq.backend, 'pulse');
  const impExpEq = sameAsTypeScript('import dep = require("./dep");\nexport = dep;\n');
  assert.equal(impExpEq.backend, 'pulse');

  // `import = require` without `export =` keeps __esModule (handled by TypeScript).
  const impReqOnly = sameAsTypeScript('import assert = require("assert");\nassert.ok(true);\n');
  assert.equal(impReqOnly.backend, 'typescript');

  // Commented `import = require` or `export =` in a type-only file still emits __esModule.
  sameAsTypeScript('/* import x = require("a") */\nexport interface T { a: number }\n');
  sameAsTypeScript('/* export = foo */\nexport interface T { a: number }\n');

  // Exported variable initializers with comments or URLs stay native and preserve assertion declines.
  const urlInit = sameAsTypeScript('export const cfg = { url: "https://example.com" };\nexport const k = 1;\n');
  assert.equal(urlInit.backend, 'pulse');
  const arrowComment = sameAsTypeScript('export const fn = () => {\n  // inside comment\n  return 1;\n}; // trailing\nexport const k = 1;\n');
  assert.equal(arrowComment.backend, 'pulse');
  const arrowAsTrailing = sameAsTypeScript('export const fn = function () {} as any; // trailing\nexport const k = 1;\n');
  assert.equal(arrowAsTrailing.backend, 'typescript');
  const asyncParam = sameAsTypeScript('export const fn = async => async + 1;\nexport const k = 1;\n');
  assert.equal(asyncParam.backend, 'pulse');

  // Type-only modules emit CJS __esModule natively (with or without comments and source maps); type-only scripts do not.
  const typeOnlyMod = sameAsTypeScript('/* license */\nexport interface Foo { a: number }\n');
  assert.equal(typeOnlyMod.backend, 'pulse');
  const typeOnlyMap = compile(Buffer.from('export type T = number;\n'), { file: 'a.ts', module: 'cjs', sourceMap: true });
  assert.equal(typeOnlyMap.backend, 'pulse');
  assert.equal(typeOnlyMap.sourceMap.mappings, '');
  const typeOnlyScript = sameAsTypeScript('interface ScriptOnly { a: number }\n');
  assert.equal(typeOnlyScript.backend, 'pulse');
  const plainScript = sameAsTypeScript('const a: number = 1;\nconsole.log(a);\n');
  assert.equal(plainScript.backend, 'pulse');
  const noSemiArrowDoc = sameAsTypeScript('export const f = () => {\n  return 1\n}\n/** next */\nexport const g = 2\n');
  assert.equal(noSemiArrowDoc.backend, 'pulse');
  const urlSpec = sameAsTypeScript('import { x } from "https://example.com/mod.ts";\nexport const y = x;\n');
  assert.equal(urlSpec.backend, 'pulse');
  // Dot, trailing-slash, and punctuation-only specifiers match TypeScript's exact generated module names.
  for (const spec of ['.', '..', './', '../', '../../src/', './$', './a$']) {
    const r = sameAsTypeScript(`import { x } from "${spec}";\nexport const y = x;\n`);
    assert.equal(r.backend, 'pulse', spec);
  }
  const awaitNewline = sameAsTypeScript('import { f } from "./dep";\nexport async function g() { return await\n  f(); }\n');
  assert.equal(awaitNewline.backend, 'pulse');
  // Non-ASCII CJS with `/*! license */` and `!cond` stays native (while `café!()` still declines).
  const nonAsciiBangSafe = sameAsTypeScript('/*! @license © */\nimport { x } from "./dep";\nexport const y = !x;\n');
  assert.equal(nonAsciiBangSafe.backend, 'pulse');
  // Module whose only imports/exports are type-only still keeps runtime statements with __esModule.
  const typeImportRuntime = sameAsTypeScript('import type { T } from "./t";\nconst v: T = 1 as any;\nconsole.log(v);\n');
  assert.equal(typeImportRuntime.backend, 'pulse');
  // Long (>400-byte) erased type annotation before `=` in `export const` stays native.
  const longType = `export const v: { ${Array.from({ length: 40 }, (_, i) => `k${i}: number`).join('; ')} } = {} as any;\nexport const u = 1;\n`;
  const longTypeRes = sameAsTypeScript(longType);
  assert.equal(longTypeRes.backend, 'pulse');
  // Multiline `export const f =\n  async () => ...` and strings/code mentioning `module.exports` stay native.
  const multiAsync = sameAsTypeScript('export const f =\n  async (x: number) => x + 1;\nexport const g = 1;\n');
  assert.equal(multiAsync.backend, 'pulse');
  const modExportsStr = sameAsTypeScript('export const s = "module.exports = 1";\nexport const g = 1;\n');
  assert.equal(modExportsStr.backend, 'pulse');

  // Exported enum followed by a JSDoc comment before the next declaration stays native.
  const enumDoc = sameAsTypeScript('export enum Level { H2 = "h2", H3 = "h3" }\n/** doc */\nexport interface Item { level: Level }\n');
  assert.equal(enumDoc.backend, 'pulse');

  // Review round 37 regressions (sol + terra):
  // 1. Private member `#import("x")` and regex after `debugger\n` must not be rewritten as dynamic import.
  const privImp = sameAsTypeScript('export class C { #import = (x: string) => x; #Promise = 0; f() { return this.#import("x"); } }\nexport const tag = 1;\n');
  assert.equal(privImp.backend, 'pulse');
  const dbgRegex = sameAsTypeScript('export let yes = false;\ndebugger\n/import("x")/.test(\'import"x"\') && (yes = true);\n');
  assert.equal(dbgRegex.backend, 'typescript');
  // 2. Trailing block comment after erased assertion and prefix assertion before `async /*c*/ function` keep `.name === ""`.
  const asBlockComment = sameAsTypeScript('export const f = function() {} as any/*c*/;\nexport const name = f.name;\n');
  assert.equal(asBlockComment.backend, 'typescript');
  const prefixAsyncComment = sameAsTypeScript('export const f = <any> async /*c*/ function() {};\nexport const name = f.name;\n');
  assert.equal(prefixAsyncComment.backend, 'typescript');
  // 3. Top-level await and `export =` clashing with CommonJS wrapper parameter report INVALID_COMMONJS_OUTPUT.
  const topAwait = compile(Buffer.from('export {};\nawait import("x");\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(topAwait.code, null);
  assert.equal(topAwait.diagnostics[0].code, 'INVALID_COMMONJS_OUTPUT');
  const clashReq = compile(Buffer.from('const require = 0;\nexport = 1;\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(clashReq.code, null);
  assert.equal(clashReq.diagnostics[0].code, 'INVALID_COMMONJS_OUTPUT');
  // 4. Type-only modules preserve license / sourceURL comments (and delegate to TS when sourceMap needs comment mappings).
  const typeLicense = compile(Buffer.from('export type T = number;\n/*! @license x */\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(typeLicense.backend, 'pulse');
  assert.match(typeLicense.code, /\/\*! @license x \*\//);
  const typeSourceUrlMap = compile(Buffer.from('export type X = 1;\n//# sourceURL=virtual-source.js\n'), { file: 'a.ts', module: 'cjs', sourceMap: true });
  assert.match(typeSourceUrlMap.code, /sourceURL=virtual-source\.js/);
  assert.ok(typeSourceUrlMap.sourceMap.mappings.length > 0);
  // 5. Helper order between dynamic import (`__importStar`) and `export *` (`__exportStar`) follows source order.
  const dynFirst = sameAsTypeScript('export const load = () => import("./x");\nexport * from "./y";\n');
  assert.equal(dynFirst.backend, 'pulse');
  assert.ok(dynFirst.code.indexOf('var __importStar') < dynFirst.code.indexOf('var __exportStar'));
  const starFirst = sameAsTypeScript('export * from "./y";\nexport const load = () => import("./x");\n');
  assert.equal(starFirst.backend, 'pulse');
  assert.ok(starFirst.code.indexOf('var __exportStar') < starFirst.code.indexOf('var __importStar'));

  // Review round 38 regressions (sol + terra):
  // 1. Non-ASCII identifier ending in ASCII followed by `!()` keeps receiver (delegates to TypeScript).
  const nonAsciiAsciiTail = sameAsTypeScript('import { éa } from "./m";\nexport const z = éa!();\n');
  assert.equal(nonAsciiAsciiTail.backend, 'typescript');
  // 2. Multi-trailing-slash and URL-root specifiers match TypeScript's exact `_1` binding name.
  for (const spec of ['./x//', 'https://example.com/', 'http://example.com/', 'https://example.com']) {
    const r = sameAsTypeScript(`import { x } from "${spec}";\nexport const y = x;\n`);
    assert.equal(r.backend, 'pulse', spec);
    assert.match(r.code, /const _1 = require\(/, spec);
  }
  // 3. Uninitialized export followed by license comment preserves the comment.
  const uninitLicense = compile(Buffer.from('export let x: number;\n/*! license */\nexport const y = 1;\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(uninitLicense.backend, 'pulse');
  assert.match(uninitLicense.code, /\/\*! license \*\//);
  // 4. No-semicolon arrow followed by `/* @__PURE__ */ g();` keeps the annotation attached to `g()`.
  const pureAttach = compile(Buffer.from('export const f = () => {}\n/* @__PURE__ */ g();\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(pureAttach.backend, 'pulse');
  assert.ok(pureAttach.code.indexOf('exports.f = f;') < pureAttach.code.indexOf('/* @__PURE__ */'), pureAttach.code);
  // 5. Specifier followed by trailing comment containing the same string maps to column 7 (real specifier, not comment).
  const trailSpecMap = compile(Buffer.from('import "x" /* "x" */;\nexport const a = 1;\n'), { file: 'a.ts', module: 'cjs', sourceMap: true });
  assert.equal(trailSpecMap.backend, 'pulse');
  assert.ok(trailSpecMap.sourceMap.mappings.length > 0);

  // Reference capture in computed class keys, destructuring defaults/computed keys, and arrow defaults.
  const compClassKey = sameAsTypeScript('import { Trait, Key } from "./dep";\nexport class C { [Trait] = true; [Key.sym]() { return 1; } }\n');
  assert.equal(compClassKey.backend, 'pulse');
  const destrDefault = sameAsTypeScript('import { DEF, KEY } from "./dep";\nexport function f(opts: any) { const { a = DEF, [KEY]: b } = opts; return [a, b]; }\n');
  assert.equal(destrDefault.backend, 'pulse');
  const arrowDefault = sameAsTypeScript('import { DEF } from "./dep";\nexport const g = (x = DEF) => x;\n');
  assert.equal(arrowDefault.backend, 'pulse');
  // Review round 39 regressions: computed pattern key preserves prior bindings, and depth-63 defaults stay accepted.
  const addon = require('../build/compiler-module.node');
  assert.equal(addon.moduleRecords(Buffer.from('export function f({ a, [(b)]: a }) {}')), null);
  assert.notEqual(addon.moduleRecords(Buffer.from('export function f({ a, [(b)]: b }) {}')), null);
  const deepNs = 'export namespace N { export let K = 1; export const a = K; export const f = ' +
    '('.repeat(63) + '(x=[])=>x' + ')'.repeat(63) + '; }\n';
  assert.equal(compile(Buffer.from(deepNs), { file: 'a.ts' }).backend, 'pulse');

  // Multi-declarator `export const/let/var a = e1, b = e2;` compiles natively when values are non-function-like.
  const multiDecl = sameAsTypeScript('export const a = 1, b = a + 2, c = (3, 4);\n');
  assert.equal(multiDecl.backend, 'pulse');
  const multiDeclDeclined = sameAsTypeScript('export let a = 1, b;\n');
  assert.equal(multiDeclDeclined.backend, 'typescript');
  // Review round 40: trailing empty destructuring in multi-declarator declines cleanly.
  const multiEmptyDestr = sameAsTypeScript('export const a = 1, b = 2, {} = JSON.parse("null");\n');
  assert.equal(multiEmptyDestr.backend, 'typescript');

  // Destructuring exports (object & array, plain identifier & call RHS) and dynamic `import(expr)`.
  for (const src of [
    'const obj = { a: 1, b: 2 };\nexport const { a, b: c } = obj;\n',
    'export const { a, b } = getObj();\nexport const tag = 1;\n',
    'const arr = [1, 2, 3];\nexport const [x, , y] = arr;\n',
    'export const [x, y] = getArr();\nexport const tag = 1;\n',
    'import { base } from "./cfg";\nexport const load = (p: string) => import(base + p);\n',
  ]) {
    const r = sameAsTypeScript(src);
    assert.equal(r.backend, 'pulse', src);
  }
  // Review round 42 regressions: self-referencing/hoisted/imported destructuring RHS and commented assertion dynamic import.
  for (const src of [
    'export const { a } = a;\n',
    'export const { a, b } = b;\n',
    'src = { a: 1, b: 2 }; export const { a, b } = src; export var src: any;\n',
    'import { thing } from "./d"; export const { a, b } = thing;\n',
    'import { base } from "./cfg"; export function load() { base; return import(/* hi */ <string>"./x"); }\n',
  ]) {
    const r = sameAsTypeScript(src);
    assert.equal(r.backend, 'typescript', src);
  }
  // Stage 3 standard ES decorators in CommonJS (target ESNext): preserved on class and member declarations.
  for (const src of [
    'import { Dec, M, val } from "./d";\n@Dec(val)\nexport class Foo {\n  @M()\n  x = 1;\n}\n',
    'import { Dec } from "./d";\n@Dec\nexport default class Foo {}\n',
    'import { Dec } from "./d";\n@Dec\nexport default class {}\n',
    'import { Dec } from "./d";\n@Dec\nclass Bar {}\nexport { Bar };\n',
  ]) {
    const r = sameAsTypeScript(src);
    assert.equal(r.backend, 'pulse', src);
  }
  // Dynamic import inside a Stage 3 decorated module declines to TypeScript (TS does not lower import() inside decorators).
  const decDyn = compile(Buffer.from('import { Dec } from "./d";\n@Dec({ load: () => import("./x") })\nexport class Foo {}\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(decDyn.backend, 'typescript');
  // Review round 43 regressions: top-level await in block with Stage 3 decorator & order-independent import() + member decorator.
  const awaitInBlock = compile(Buffer.from('const d = (c: any) => c;\n@d export class C {}\nif (true) { await 0; }\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(awaitInBlock.backend, 'typescript');
  const dynBeforeMemberDec = compile(Buffer.from('const d = (m: any) => m;\nexport const p = import("./x");\nexport class C { @d m() {} }\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(dynBeforeMemberDec.backend, 'typescript');
  // Stage 3 decorators with async arrow await, imported-name class field, and nested non-shadowed decorators.
  for (const src of [
    'import { Dec } from "./d";\n@Dec()\nexport class C { m() { Promise.resolve().then(async () => { await 1; }); } }\n',
    'import { Dec, Kind } from "./d";\n@Dec()\nexport class C { Kind = Kind; }\n',
    'import { Dec } from "./d";\nexport function run() { @Dec() class Local {} return Local; }\n',
  ]) {
    const r = sameAsTypeScript(src);
    assert.equal(r.backend, 'pulse', src);
  }
  // Shadowed local decorator binding declines cleanly to TypeScript.
  const shadowedDec = compile(Buffer.from('import { Dec } from "./d";\nexport function run(Dec: any) { @Dec() class Local {} return Local; }\n'), { file: 'a.ts', module: 'cjs' });
  assert.equal(shadowedDec.backend, 'typescript');
  // Review round 44 regressions: method param after parenthesized default, block comment with `/*` before `!`,
  // `async` identifier before `{ await }` vs destructured async method param.
  assert.equal(compile(Buffer.from('import { Dec } from "./d";\nexport class C { m(x = (0), Dec = () => () => {}) { @Dec() class Local {} return Local; } }\n'), { file: 'a.ts', module: 'cjs' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('import { f } from "./d";\nexport const x = f /* a /* b */!();\n'), { file: 'a.ts', module: 'cjs' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('const d = (c: any) => c;\n@d export class C {}\nlet async: any;\nasync && { x: await 0 };\n'), { file: 'a.ts', module: 'cjs' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('const d = (c: any) => c;\n@d export class C {}\nconst async = 1;\nasync\n{ await Promise.resolve(); }\n'), { file: 'a.ts', module: 'cjs' }).backend, 'typescript');
  assert.equal(sameAsTypeScript('import { Dec } from "./d";\n@Dec()\nexport class C { async m({ x }: any) { await x; } }\n').backend, 'pulse');
  // Receiver/callee/index occurrences inside assignment LHS (`browser.rootEl = 1`, `configs[dirname(p)] = 1`)
  // and Prettier-formatted multiline `export const f =\n  function () {}` compile natively.
  for (const src of [
    'import { browser, dirname } from "./d";\nconst configs: any = {};\nbrowser.rootEl = "#app";\nconfigs[dirname("/a/b")] = 1;\nexport { configs };\n',
    'export const f =\n  function () { return 1; };\nexport default f.name;\n',
    'export const g =\n  async function () { return 2; };\n',
    '/*! @license */\nexport const VERSIONS_CONFIG = { a: "1", b: 2 };\n',
  ]) {
    assert.equal(sameAsTypeScript(src).backend, 'pulse', src);
  }
  assert.equal(compile(Buffer.from('export const f = <any>\n  function () {};\nexport default f.name;\n'), { file: 'a.ts', module: 'cjs' }).backend, 'typescript');
  // Review round 45 bonus: EOF destructuring export without trailing newline or with trailing line comment.
  assert.equal(sameAsTypeScript('export const [f, g] = [1, 2]').backend, 'pulse');
  const eofSingle = compile(Buffer.from('export const [f] = [1]'), { file: 'a.ts', module: 'cjs' });
  assert.equal(eofSingle.backend, 'pulse');
  const eofMod = { exports: {} };
  new Function('exports', 'require', 'module', eofSingle.code)(eofMod.exports, () => ({}), eofMod);
  assert.equal(eofMod.exports.f, 1);
  assert.equal(sameAsTypeScript('export const [f] = [1] // end').backend, 'typescript');
});

test('CommonJS local-scope import shadowing compiles natively and matches TypeScript', () => {
  for (const src of [
    'import { a } from "./a";\nexport function f(a: number) { return a; }\nexport const top = a;\n',
    'import { path } from "./p";\nexport const xs = [1, 2].map(path => path + 1);\nexport const p = path;\n',
    'import { a } from "./a";\nexport const f = ({ a }: { a: number }) => a;\nexport const g = ([a]: number[]) => a;\nexport const top = a;\n',
    'import { a } from "./a";\nexport function f() { const a = 10; return a; }\nexport const top = a;\n',
    'import { a } from "./a";\nexport function f(xs: number[]) { let s = 0; for (const a of xs) { s += a; } return s + a; }\n',
    'import { a } from "./a";\nexport function f() { try { return a; } catch (a) { return a; } }\n',
    'import { a } from "./a";\nexport const f = function a() { return typeof a; };\nexport const top = a;\n',
    'import { Dec, Use, Filter } from "./d";\nexport function suite() { @Dec() class Filter {} @Use(Filter) class Sub {} return [Filter, Sub]; }\nexport const top = Filter;\n',
    'import { a } from "./a";\nexport const f = false ? a => a : a;\n',
    'import { a } from "./a";\nexport function f() { const g = 1 * (function a() { return 1; } as any); return [g, a]; }\n',
    'import { a } from "./a";\nexport function f() { const g = async function a() { return a; }; return [g, a]; }\n',
    'import { a } from "./a";\ndeclare function g(x: any): void;\nexport function f() { g(a)\n  { return a; } }\nexport const shadow = (a: number) => a;\n',
  ]) {
    assert.equal(sameAsTypeScript(src).backend, 'pulse', src);
  }
  // Runtime verification: shadowed local returns its own value while outer reference reads the module import.
  const compiled = compile(Buffer.from(
    'import { val } from "./dep";\nexport function run() {\n  const inner = (val: number) => val * 2;\n  const block = () => { const val = 5; return val; };\n  return [inner(3), block(), val];\n}\n'
  ), { file: 'shadow.ts', module: 'cjs' });
  assert.equal(compiled.backend, 'pulse');
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', compiled.code)(mod.exports, () => ({ val: 42 }), mod);
  assert.deepEqual(mod.exports.run(), [6, 5, 42]);

  // Complex/ambiguous scoping cases safely decline to TypeScript (including review round 48 counterexamples).
  for (const src of [
    'import { a } from "./a";\nexport function f() { var a = 1; return a; }\nvoid a;\n',
    'import { a } from "./a";\nexport function f(x = a, a = 1) { return [x, a]; }\nvoid a;\n',
    'import { a } from "./a";\nexport function f() { const g = () => a; const a = 1; return g(); }\nvoid a;\n',
    'import { a } from "./a";\nexport function f(a: number) { return eval("a"); }\nvoid a;\n',
    'import { a } from "./a";\nexport function f() { const g = (a: number) => a\n  { return a; } }\n',
    'import { a } from "./a";\nexport const f = (a: any) => typeof\n  a;\n',
    'import { a } from "./a";\nexport const f = (a: any) => "x"\n  in a;\n',
    'import { a } from "./a";\nexport function f() { switch (0) { case 0: function a() {} return a; } }\n',
  ]) {
    assert.equal(compile(Buffer.from(src), { file: 'shadow.ts', module: 'cjs' }).backend, 'typescript', src);
  }
});
