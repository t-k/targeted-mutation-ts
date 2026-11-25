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
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = moduleOf(row);
    const result = sameAsTypeScript(source);
    if (result.backend === 'pulse') native++;
  }
  // Nearly every row is written here; the count guards against the route falling silent.
  assert.ok(native >= 100, String(native));
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
  // Type arguments in front of a call leave blanks, and the call is still one.
  native('import { make } from "./make";\nexport const made = make<string,\n  number>(1);');
  // An exported name that a re-export list takes from an import is read through a getter.
  native('import { a, b } from "./ab";\nexport { a, b as c };\na(b);');
  // An older target, where the module itself is written as for ESNext.
  assert.equal(sameAsTypeScript('import { a } from "./a";\nexport const b = a + 1;', 'module.ts', { target: 'es2019' }).backend, 'pulse');
});

test('modules that are left to TypeScript for CommonJS output', () => {
  for (const [source, why] of [
    ['const a: number = 1;\nconsole.log(a);', 'a script'],
    ['import { a } from "./a";\nexport function f(a: number) { return a; }\nvoid a;', 'a parameter with the name of an import'],
    ['import { a } from "./a";\nexport const o = { a: 1, b: a };', 'a key with the name of an import'],
    ['import { a } from "./a";\n// calls a\nexport const b = a;', 'a comment with the name of an import'],
    ['export function f() {}\nf = null as any;', 'an assignment to an exported function'],
    ['export class A {}\n[A] = [null as any];', 'an array target with an exported class'],
    ['export function f() {}\nlet o: any;\n({ f } = o);', 'an object target with an exported function'],
    ['export function f() {}\nfor (f of []) {}', 'a loop that assigns an exported function'],
    ['export const { a, b } = { a: 1, b: 2 };', 'a pattern'],
    ['export let count: number;\nfor (count of [1, 2]) {}', 'a loop that assigns an exported variable'],
    ['export const a = 1, b = 2;', 'two declarators'],
    ['export let f = () => 1;\nf = () => 2;', 'a function-like value in a variable that can change'],
    ['const exports = 1;\nexport { exports as e };', 'the word exports'],
    ['export const m = import("./m");', 'a dynamic import'],
    ['export const u = import.meta.url;', 'import.meta'],
    ['import a = require("./a");\nexport = a;', 'the CommonJS dialect'],
    ['export declare const ambient: number;\nexport const b = 1;\nvoid ambient;', 'an exported ambient declaration'],
    ['import d, * as all from "./d";\nd; all;', 'a default and a namespace import together'],
    ['import g from "./x/";\ng;', 'a specifier that ends in a slash'],
    ['import g from "..";\ng;', 'a specifier without a name'],
    ['import { default as d } from "./d";\nd;', 'default as a named import'],
    ['export { default } from "./d";', 'default in a re-export'],
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
  // Files with a module extension, a source map and legacy decorators keep the TypeScript route.
  assert.equal(compile(Buffer.from('export const a = 1;'), { file: 'module.mts', module: 'cjs' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('export const a: number = 1;'), { file: 'module.ts', module: 'cjs', sourceMap: true }).backend, 'typescript');
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
