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

// A class member whose first token would continue the initializer on the line before it.
{
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(new URL('../verification/pict/compiler-member-separator.tsv', import.meta.url), 'utf8')
    .trimEnd().split(/\r?\n/).slice(1);
  const names = { Computed: '[k]', Generator: '*g', In: 'in', Instanceof: 'instanceof', Name: 'n', String: '"s"', Private: '#p' };
  const before = { InitializedField: 'a = f', BareField: 'a', Method: 'a() { return f }', ClassStart: '' };
  for (const row of rows) {
    test('class member separator ' + row.replaceAll('\t', ' '), () => {
      const [erased, next, prior, fixed] = row.split('\t');
      const name = names[next];
      const member = next === 'Generator' ? `${name}() {}` : `${name} = 2`;
      const modifiers = { Modifier: 'readonly', TwoModifiers: 'protected readonly' }[erased];
      // A generator method takes an accessibility modifier, a field takes readonly.
      const erasable = next === 'Generator' ? (erased === 'TwoModifiers' ? 'public override' : 'public') : modifiers;
      const head = erasable === undefined ? '' :
        fixed === 'BeforeModifier' ? `static ${erasable} ` : fixed === 'AfterModifier' ? `${erasable} static ` : `${erasable} `;
      const lines = {
        AmbientField: ['declare b: number'], AbstractField: ['abstract b: number'], AbstractMethod: ['abstract m(): void'],
        Overload: ['n(x: string): void'],
      }[erased] ?? [];
      const last = erased === 'Overload' ? 'n(x: any) {}' : head + member;
      const base = /public override/.test(head) ? ' extends B' : '';
      const body = [before[prior], ...lines, last].filter(Boolean).map(line => '  ' + line).join('\n');
      const source = `${/Abstract/.test(erased) ? 'abstract ' : ''}class C${base} {\n${body}\n}\nexport const result = C;\n`;
      assert.equal(sameAsTypeScript(source, 'member.ts').backend, 'pulse', source);
    });
  }
}

test('erased class-member starts keep neighbouring members apart in other arrangements', () => {
  for (const source of [
    'class C {\n  a = f\n  declare b: number\n  declare c: string\n  readonly [k] = 2\n}\nexport const r = C;',
    'class C {\n  a = f\n  protected readonly\n  [k] = 2\n}\nexport const r = C;',
    'class C {\n  a = f\n  private\n  static *g() {}\n}\nexport const r = C;',
    'class C {\n  a = f\n  public async [k]() {}\n  private get [g]() { return 1 }\n}\nexport const r = C;',
    'class C {\n  a = 1\n  m(x: string): void\n  m(x: any) {}\n  [k] = 2\n}\nexport const r = C;',
    'class C {\n  a = 1\n  public in = 2\n  private instanceof = 3\n}\nexport const r = C;',
    'export abstract class A {\n  a = f\n}\nexport default abstract class B {}',
    'class C {\n  constructor(private a: number, readonly b: string) {}\n  x = f\n  readonly [k] = this.a\n}\nexport const r = C;',
    'import { type A, b } from "./m.js";\nexport { type A, b };',
    // A receiver parameter and a type-only list entry are erased like a member, but nothing may be written for them.
    'export function sum(this: void, [a, b]: [number, number]) { return a + b; }',
    'export function each(this: Window, ...rest: number[]) { return rest; }',
    'import { type T, in as inside } from "./m.js";\nexport { inside };',
    'const instanceofs = 1, inside = 2;\nexport { type T, inside as in, instanceofs as instanceof };\ntype T = number;',
  ]) {
    const result = sameAsTypeScript(source, 'member.ts');
    assert.equal(result.backend, 'pulse', source);
    if (!/class/.test(source)) assert.doesNotMatch(result.code.replace(/;\s*$|;\n|; \}/g, ''), /;\s*(?:\[|in\b|instanceof\b|\.\.\.)/, source);
  }
});

test('a separator is written only where the member start would continue an initializer', () => {
  const erased = source => compile(Buffer.from(source), { file: 'member.ts' }).code;
  assert.equal(erased('class C {\n  a = f\n  readonly [k] = 2\n}\nexport const r = C;'),
    'class C {\n  a = f\n  ;        [k] = 2\n}\nexport const r = C;');
  assert.equal(erased('class C {\n  a = f\n  readonly index = 2\n  public instanceofs = 3\n}\nexport const r = C;'),
    'class C {\n  a = f\n           index = 2\n         instanceofs = 3\n}\nexport const r = C;');
  assert.equal(erased('class C {\n  a = f\n  static readonly [k] = 2\n}\nexport const r = C;'),
    'class C {\n  a = f\n  static          [k] = 2\n}\nexport const r = C;');
  assert.equal(erased('class C {\n  a = f\n  private static [k] = 2\n}\nexport const r = C;'),
    'class C {\n  a = f\n  ;       static [k] = 2\n}\nexport const r = C;');
  assert.equal(erased('abstract class C {\n  a = f\n  abstract m(): void\n  [k] = 2\n}\nexport const r = C;'),
    '         class C {\n  a = f\n  ;                 \n  [k] = 2\n}\nexport const r = C;');
});

test('JSX helper imports follow the order in which TypeScript requests the two modules', () => {
  const order = code => [...code.matchAll(/^import\s*\{[^}]*\}\s*from\s*"(react(?:\/jsx-runtime)?)";/gm)].map(match => match[1]);
  for (const source of [
    'export const x = <a {...p} key="k"/>;\nexport const y = <b/>;\n',
    'export const y = <b/>;\nexport const x = <a {...p} key="k"/>;\n',
    'export const y = <div><a {...p} key="k"/></div>;\n',
    'export const y = <div><b/><a {...p} key="k"/></div>;\n',
    'export const y = <a {...p} key="k"><b/></a>;\n',
    'export const y = <A icon={<B {...p} key="k"/>}><C/></A>;\n',
    'export const y = <A icon={<C/>}><B {...p} key="k"/></A>;\n',
    'export const y = <A key={<B {...p} key="k"/>} icon={<C/>}/>;\n',
    'export const y = <A key={<C/>} icon={<B {...p} key="k"/>}/>;\n',
    'export const y = <A {...p} key="k" icon={<C/>}><D/></A>;\n',
    'export const y = <><a {...p} key="k"/><b/></>;\n',
    'export const y = <A {...p} key="k"><B/></A>;\nexport const z = <C/>;\n',
    'export const y = <div>{[1].map(i => <a {...p} key={i}/>)}<b/></div>;\n',
  ]) {
    const result = sameAsTypeScript(source, 'view.tsx');
    assert.equal(result.backend, 'pulse', source);
    assert.deepEqual(order(result.code), order(reference(source, 'view.tsx')), source);
    assert.equal(order(result.code).length, 2, source);
  }
});

test('yield expressions, comma returns and debugger statements match TypeScript', () => {
  for (const source of [
    'export function* g() { const pool = yield* Pool; return pool; }',
    'export function* g() { return yield* _(t); }',
    'export function* g(): Generator<number> { const x: number = yield; f(yield, yield 1); return [yield, yield* h()]; }',
    'export function* g(a: boolean) { const x = a ? yield : yield 2; yield a, x; yield\nf()\n}',
    'export function* g() { yield; yield 1; yield* h(); const o = { k: yield 3 }; }',
    'export const p = Effect.gen(function* () { const t = yield* Terminal; const columns = yield* t.columns; return columns as number; });',
    'export async function* g() { for await (const x of yield* source()) yield x; }',
    'export function* g() { const f = (yield 1) + 2; return (yield f), f; }',
    'export function f() { return a(), b(); }',
    'export function f(acc: Record<string, unknown>, ds: { name: string; url: string }) { return (acc[ds.name] = { url: ds.url }), acc; }',
    'export function f(x: number) { if (x) return\nreturn x as number, x + 1 }',
    'export function f() { debugger; }',
    'export function f() { debugger\nreturn 1 }',
    'debugger;\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'forms.ts').backend, 'pulse', source);
  }
});

test('yield outside a generator and a delegation split across lines are left to TypeScript', () => {
  for (const source of [
    'export function* g() { const f = () => yield 1; }',
    'export function* g() { yield\n* h() }',
    'export function f() { return yield 1; }',
    'export function* g() { const x = 1 + yield 2; }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'forms.ts' }).backend, 'pulse', source);
  }
});

test('an interface merges with a class and a namespace of types with other declarations', () => {
  for (const source of [
    'export interface X { a: number }\nexport class X { b = 1 }',
    'export class X { b = 1 }\nexport interface X { a: number }',
    'interface X { a: number }\nclass X { b = 1 }\nexport { X };',
    'interface X { a: number }\nabstract class X { b = 1 }\nexport default X;',
    'declare interface E { on(): this }\nclass E extends Base {}\nexport const e = new E();',
    'export interface X<T> extends Q<T> {}\nexport class X<T> extends P<T> implements R<T> { static readonly [k]: string = "x"; }',
    'export type B = A | C;\nexport declare namespace B { export type S = "a" | "b" }\nexport const x = 1;',
    'export interface B {}\nexport namespace B { export type S = "a" }\nexport const y = 2;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'merge.ts').backend, 'pulse', source);
  }
});

test('declarations that TypeScript does not merge stay off the native route', () => {
  for (const source of [
    'export interface X {}\nexport enum X { A }',
    'import { X } from "./x.js";\nexport interface X {}\nexport class X {}',
    'export type X = number;\nexport class X {}',
    'class X {}\nclass X {}\nexport {};',
    'import { B } from "./b.js";\ndeclare namespace B { type S = 1 }\nexport const y = B;',
    'enum B { A }\ndeclare namespace B { type S = 1 }\nexport const y = B;',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'merge.ts' }).backend, 'pulse', source);
  }
});

test('parameter properties take override, need no type, and lower beside enums', () => {
  for (const source of [
    'export class C extends B { constructor(override readonly table: T, config: U) { super(config); } }',
    'export class C extends B { constructor(public override readonly a: number, b: string) { super(b); this.a; } }',
    'export class C { constructor(private doc, public readonly other = 1, protected last) {} }',
    'export enum Mode { A, B = 1 << 2 }\nexport class C { constructor(public mode: Mode, private n = 1) {} }',
    'export class C { constructor(public mode: Mode) {} }\nexport enum Mode { A, B }\n' +
      'export class D extends C { constructor(readonly x: number) { super(Mode.A); } }\nconst enum K { Z = 9 }\nexport const k = K.Z;',
    'export class C { constructor(public mode: number) {} }\nexport const enumerate = 1;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'property.ts').backend, 'pulse', source);
  }
  // A modifier word that is itself the parameter name is an ordinary parameter.
  const plain = 'export class C { constructor(private, readonly: number) { this.x = [private, readonly]; } }';
  const result = compile(Buffer.from(plain), { file: 'property.ts' });
  assert.equal(typeof result.code, 'string');
  assert.doesNotMatch(result.code, /this\.private|this\.readonly/);
});

test('heritage expressions and type arguments on call results and templates match TypeScript', () => {
  for (const source of [
    'export class A extends mixin(B) {}',
    'export class A extends (cond ? B : C) {}',
    'export class A extends B.c() {}',
    'export class A extends B.C<T> {}',
    'export class A extends B.c<T>() {}',
    'export class A extends f()<T> {}',
    'export class A extends S.Class<A>("A")({ a: S.String }) {}',
    'export class ATag extends Context.Tag("ATag")<ATag, "A">() {}',
    'export class Dog extends Data.TaggedClass("Dog")<{}> {}',
    'export class Err extends Schema.TaggedError<Err>()("Err", {}) { x = 1 }',
    'export class A extends B<T> implements I<T>, J { }',
    'export class A<T> extends Base<T>(arg)<U> implements I { constructor(private a: T) { super(); } }',
    'export const K = class extends mixin(B)<T> {};',
    'export class A extends new B() {}',
    'export class A extends class {} {}',
    'export class A extends null {}',
    'export class A extends B\n<T> {}',
    'export const x = Context.Tag("T")<T, "A">();',
    'export const x = f<T>()<U>(o);',
    'export const x = f<T>(c)<U>(d)(e);',
    'export const x = [f()<T>(g), h(i)<U>(j)];',
    'export const x = sql<number>`rowid`;',
    'export const x = a.b<T>`t${c as number}`;',
    'export const x = f()<T>`a`;',
    'export function f(obj: any) { obj.foo!++; obj.bar!--; return obj.baz!++ + 1; }',
    'let n: number | undefined = 1;\nn!++;\nexport const r = n;',
    'export function f(a: any) { a!.b!++; ++a.c; a.d!\n++a.e; }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'heritage.ts').backend, 'pulse', source);
  }
});

test('a unary heritage clause and a spaced comparison are not read as the new forms', () => {
  for (const source of [
    'export class A extends -B {}',
    'export class A extends Base++ {}',
    'export class A extends Base-- {}',
    'export class A extends await b {}',
    'export class A extends b ? c : d {}',
    'export function f(a: any) { a()!++; }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'heritage.ts' }).backend, 'pulse', source);
  }
  // With white space before the angle TypeScript decides between a comparison and type arguments.
  for (const source of ['export const x = f(a) < b > c;', 'export const x = f() < T > (g);']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'heritage.ts' }).backend, 'pulse', source);
  }
});

test('variance annotations, local types beside values and exported type namespaces match TypeScript', () => {
  for (const source of [
    'class Q<in out A> implements S<A> { x = 1 }\nexport { Q };',
    'export class Take<out A, out E = never> implements T<A, E> { constructor(readonly value: A) {} }',
    'export type Fn<in A, out B> = (a: A) => B;\nexport const y = 1;',
    'export interface TSet<in out A> extends V<A> {}\nexport const x = 1;',
    'export function f() { const t1 = z.any(); type t1 = z.infer<typeof t1>; return t1; }',
    'export function f() { type t1 = number; const t1 = 1; return t1; }',
    'export function f() { interface A { a: string } const A: S.Schema<A> = S.suspend(() => 1); return A; }',
    'export function f() { const X = 1; { type X = string; const y: X = "a"; return [X, y]; } }',
    'export function f(x: number) { type x = string; return x; }',
    'export declare namespace M { type X = 1 }\nexport const M = Context.GenericTag<T, M>("x");',
    'export const C = 1;\nexport declare namespace C { type X = 1 }',
    'export function C() {}\nexport declare namespace C { type X = 1 }',
    'export class C {}\nexport declare namespace C { type X = 1 }',
    'enum M { const = 1 << 0, readonly = 1 << 1, "#private" = 1 << 6, \'a-b\' = 9, global }\nexport const m = M;',
    'enum S { "x" = 2, y = x + 1 }\nexport const s = S;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'forms.ts').backend, 'pulse', source);
  }
});

test('conflicting local names and enum member names that need care stay off the native route', () => {
  for (const source of [
    'export function g<in T>(x: T) { return x; }',
    'export function f() { let a = 1; let a = 2; }',
    'export function f() { type A = 1; type A = 2; }',
    'export function f() { interface A {} class A {} return A; }',
    'enum S { "1" = 2 }\nexport const s = S;',
    'enum S { \'it\\\'s\' = 2 }\nexport const s = S;',
    'enum S { "__proto__" = 2 }\nexport const s = S;',
    'enum S { "a b" = 1, d = S["a b"] }\nexport const s = S;',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'forms.ts' }).backend, 'pulse', source);
  }
});

// The JSX import-source pragma: the native route takes the plain case and leaves every other @jsx text to TypeScript.
{
  const { readFileSync } = await import('node:fs');
  const { createRequire: requireFrom } = await import('node:module');
  const router = requireFrom(import.meta.url)('../src/compiler-routes.cjs').compile;
  const rows = readFileSync(new URL('../verification/pict/compiler-jsx-pragma.tsv', import.meta.url), 'utf8')
    .trimEnd().split(/\r?\n/).slice(1);
  const bodies = {
    Runtime: 'export const view = <section><b>ready</b>{value}</section>;',
    Create: 'export const view = <a {...props} key="k"/>;',
    Both: 'export const view = <div><a {...props} key="k"/><b/></div>;',
    Fragment: 'export const view = <><b/>{value}</>;',
  };
  for (const row of rows) {
    test('JSX pragma ' + row.replaceAll('\t', ' '), () => {
      const [pragma, place, mode, helpers, tail] = row.split('\t');
      const text = { Absent: '', ImportSource: '@jsxImportSource preact', Runtime: '@jsxRuntime automatic', Factory: '@jsx h',
        Twice: '@jsxImportSource preact\n * @jsxImportSource other' }[pragma];
      const close = { SpaceClose: ' */', LineEnd: '\n */', DirectClose: '*/' }[tail];
      const comment = pragma === 'Absent' ? '' : place === 'LeadingLine' ? `// ${text}\n` : `/** ${text}${close}\n`;
      const source = place === 'AfterCode' ? `import { value } from "./v.js";\n${comment}${bodies[helpers]}\n` :
        `${comment}import { value } from "./v.js";\n${bodies[helpers]}\n`;
      const options = { file: 'view.tsx', jsx: mode === 'Classic' ? 'classic' : 'automatic' };
      const result = compile(Buffer.from(source), options);
      assert.deepEqual(router(Buffer.from(source), options), result, source);
      assert.deepEqual(compile(source, options), result, source);
      // A factory pragma names the classic factory. Under the automatic runtime TypeScript ignores it wherever
      // it stands.
      const native = pragma === 'Absent' || (pragma === 'Factory' && mode === 'Automatic') ||
        (pragma === 'ImportSource' && place === 'LeadingBlock' && mode === 'Automatic' && tail !== 'DirectClose');
      assert.equal(result.backend === 'pulse', native, source);
      if (!native) return;
      const expected = ts.transpileModule(source, { fileName: 'view.tsx', compilerOptions: {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true,
        jsx: mode === 'Classic' ? ts.JsxEmit.React : ts.JsxEmit.ReactJSX } }).outputText;
      assert.deepEqual(inspect(ts, result.code, 'view.tsx'), inspect(ts, expected, 'view.tsx'), source);
      // The helper imports name the same modules in the same order.
      const modules = code => [...code.matchAll(/^import\s*\{[^}]*\b(?:jsxs?|Fragment|createElement) as _[^}]*\}\s*from\s*"([^"]+)";/gm)].map(match => match[1]);
      assert.deepEqual(modules(result.code), modules(expected), source);
      if (pragma === 'ImportSource' && mode === 'Automatic') assert.ok(modules(result.code).every(name => name.startsWith('preact')), source);
    });
  }
}

test('unusual import-source pragmas are left to TypeScript', () => {
  for (const comment of [
    '/** @jsxImportSource */', '/** @jsxImportSource\n * preact */', '/** @jsxImportSource "preact" */', '/** @jsxImportSourceX preact */',
    '/** @jsximportsource preact */\n/** @jsxFrag F */',
    // TypeScript matches a tag with the text after it, so an earlier tag can hide the pragma.
    '/* @license MIT @jsxImportSource preact */', '/*!\n * @preserve\n * @jsxImportSource preact\n */',
  ]) {
    const source = `${comment}\nexport const view = <i/>;\n`;
    assert.notEqual(compile(Buffer.from(source), { file: 'view.tsx' }).backend, 'pulse', source);
  }
  // The pragma name is matched without regard to case, as TypeScript matches it.
  const source = '#!/usr/bin/env node\n// note\n/* @JSXIMPORTSOURCE @scope/pkg.name */\nexport const view = <i/>;\n';
  const result = sameAsTypeScript(source, 'view.tsx');
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /from"@scope\/pkg\.name\/jsx-runtime"/);
  // Only the first word after the pragma is the package, as in TypeScript.
  assert.match(sameAsTypeScript('/* @jsxImportSource pre act*/\nexport const view = <i/>;\n', 'view.tsx').code, /from"pre\/jsx-runtime"/);
});

// Decorators are kept as written, as TypeScript keeps them at the ESNext target.
{
  const { readFileSync } = await import('node:fs');
  const { createRequire: requireFrom } = await import('node:module');
  const router = requireFrom(import.meta.url)('../src/compiler-routes.cjs').compile;
  const rows = readFileSync(new URL('../verification/pict/compiler-decorators.tsv', import.meta.url), 'utf8')
    .trimEnd().split(/\r?\n/).slice(1);
  const forms = { Name: '@dec ', Chain: '@ns.dec ', Call: '@dec(1, value as number) ', Two: '@first @second({ a: 1 }) ', OwnLine: '@dec\n  ' };
  for (const row of rows) {
    test('decorators ' + row.replaceAll('\t', ' '), () => {
      const [target, form, follows, before] = row.split('\t');
      const decorator = forms[form];
      let source;
      if (/Class$/.test(target)) {
        const head = { Class: 'class C', ExportedClass: 'export class C', DefaultClass: 'export default class', AbstractClass: 'abstract class C' }[target];
        source = `import { dec, first, second, ns, value } from "./d.js";\n${decorator.trimEnd()}\n${head} { m(): number { return 1; } }\n` +
          (target === 'Class' || target === 'AbstractClass' ? 'export { C };\n' : '');
      } else {
        const modifier = { Plain: '', ErasedModifier: target === 'Getter' || /Method/.test(target) ? 'public ' : 'readonly ',
          // A field takes static readonly. A method takes an accessibility modifier, which stands before static.
          StaticThenErased: target === 'Getter' || /Method/.test(target) ? 'public static ' : 'static readonly ' }[follows];
        const member = { Method: 'm(x: number): number { return x; }', Field: 'f: number = 1', Getter: 'get g(): number { return 1; }',
          StaticField: 's: number = 2', ComputedField: '[key] = 3', GeneratorMethod: '*gen() {}' }[target];
        const prior = { InitializedField: 'a = start', Method: 'b() {}', Nothing: '' }[before];
        source = `import { dec, first, second, ns, value, key, start } from "./d.js";\nexport class C {\n  ${prior}\n  ${decorator}${modifier}${member}\n}\n`;
      }
      const result = sameAsTypeScript(source, 'decorated.ts');
      assert.equal(result.backend, 'pulse', source);
      assert.deepEqual(router(Buffer.from(source), { file: 'decorated.ts' }), result, source);
      // Every decorator of the source is in the output, and nothing was written between one and its member.
      assert.equal(result.code.match(/@\w/g).length, source.match(/@\w/g).length, source);
      assert.doesNotMatch(result.code, /@[\w.]+(?:\([^)]*\))?\s*;/, source);
    });
  }
}

test('a helper import goes before a decorated class that uses JSX in its decorator', () => {
  const source = 'const placeholder = (node) => (value) => value;\n@placeholder(<span />)\nexport class Widget {}\nexport const title = "Widget";\n';
  const result = sameAsTypeScript(source, 'widget.tsx');
  assert.equal(result.backend, 'pulse');
  assert.ok(result.code.indexOf('import{') < result.code.indexOf('@placeholder'), result.code);
  // An earlier tag hides the pragma only when its own text reaches it: a tag with text on its line does not.
  for (const comment of ['/** Contact dev@example.org for help.\n * @jsxImportSource preact\n */', '/**\n * @license MIT\n * @jsxImportSource preact\n */',
    '/* a@b c\n@jsxImportSource preact */']) {
    const result = sameAsTypeScript(`${comment}\nexport const view = <i/>;\n`, 'view.tsx');
    assert.equal(result.backend, 'pulse', comment);
    assert.match(result.code, /from"preact\/jsx-runtime"/, comment);
  }
  for (const comment of ['/**\n * @preserve\n * @jsxImportSource preact\n */', '/* @license MIT @jsxImportSource preact */', '/* x@y\n * @jsxImportSource preact */',
    '/* caf\u00e9 @jsxImportSource preact */']) {
    const source = `${comment}\nexport const view = <i/>;\n`;
    assert.notEqual(compile(Buffer.from(source), { file: 'view.tsx' }).backend, 'pulse', comment);
    assert.match(compile(Buffer.from(source), { file: 'view.tsx' }).code, /react\/jsx-runtime/, comment);
  }
  // An earlier comment with its own tag does not hide a pragma in a later comment.
  const pragma = sameAsTypeScript('/* @license MIT */\n/** @jsxImportSource preact */\nexport const view = <i/>;\n', 'view.tsx');
  assert.equal(pragma.backend, 'pulse');
  assert.match(pragma.code, /from"preact\/jsx-runtime"/);
});

test('decorators that the native grammar does not take are left to TypeScript', () => {
  for (const source of [
    '@d\nclass C { @d declare x: number }\nexport { C };',
    '@d\nclass C { @d constructor() {} }\nexport { C };',
    'class C { constructor(@Inject(X) private doc: any) {} }\nexport { C };',
    'class C { @d m(): void; m(x?: any) {} }\nexport { C };',
    'abstract class C { @d abstract m(): void }\nexport { C };',
    '@(a.b)\nclass C {}\nexport { C };',
    '@d<T>()\nclass C {}\nexport { C };',
    'export @d class C {}',
    'const K = @d class {};\nexport { K };',
    'export function f() { @d class L {} return L; }',
    'class C { @d accessor x = 1 }\nexport { C };',
    '@d\nfunction f() {}\nexport { f };',
    '@d\nexport const x = 1;',
    '@d\ndeclare class C {}\nexport {};',
    'class C { @d }\nexport { C };',
    'class C { @d; m() {} }\nexport { C };',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'decorated.ts' }).backend, 'pulse', source);
  }
});

test('a decorated JavaScript module gives the same result on the entry and the router', async () => {
  const { createRequire: requireFrom } = await import('node:module');
  const router = requireFrom(import.meta.url)('../src/compiler-routes.cjs').compile;
  const source = 'import { d } from "./d.js";\n@d\nexport class C { @d m() {} }\n';
  for (const file of ['a.js', 'a.mjs', 'a.jsx', 'a.ts', 'a.tsx']) {
    for (const input of [Buffer.from(source), source]) {
      const result = compile(input, { file });
      assert.deepEqual(router(input, { file }), result, file);
      assert.match(result.code, /@d\s+export class C/, file);
    }
  }
});

test('well-formed leading triple-slash comments stay on the module routes and malformed ones keep the diagnostic', async () => {
  const { createRequire: requireFrom } = await import('node:module');
  const router = requireFrom(import.meta.url)('../src/compiler-routes.cjs').compile;
  const body = '\nimport { value } from "./v.js";\nexport const f: number = value;\n';
  for (const [comment, native] of [
    ['/// <reference types="vitest" />', true], ['///<reference path="./a.d.ts"/>', true], ['/// <reference lib="es2015" />', true],
    ['/// <reference types = "vite/client" />', true], ['///  <reference   path  =  \'a\'   />', true],
    ["/// <reference types='a' />", true], ['/// plain note', true], ['#!/usr/bin/env node\n// one\n/// <reference types="a" />\n/* two */', true],
    ['/// <reference />', false], ['/// <reference foo="a" />', false], ['/// <reference types="a" >', false],
    ['/// <amd-module name="x" />', false], ['/// <reference types="a" resolution-mode="import" />', false],
    ['/// <reference types="a" /> trailing', false], ['//// <reference types="a" />', false], ['/* a ///b */', false], ['// x ///y', false],
  ]) {
    for (const [file, text] of [['a.ts', comment + body], ['a.tsx', comment + body + 'export const view = <i>{f}</i>;\n'],
      ['types.ts', comment + '\nexport type T = number;\n']]) {
      const result = compile(Buffer.from(text), { file });
      assert.deepEqual(router(Buffer.from(text), { file }), result, text);
      assert.equal(result.backend === 'pulse', native, text);
      if (native) {
        assert.ok(result.code.includes(comment.split('\n').at(-1)), text);
        if (file !== 'types.ts') sameAsTypeScript(text, file);
      }
    }
  }
  const malformed = compile('/* header */\n/// <reference />\nexport const f: number = 42;');
  assert.equal(malformed.code, null);
  assert.equal(malformed.diagnostics[0].code, 1084);
});

test('angle-bracket assertions are erased in a .ts file', () => {
  for (const source of [
    'export function f(o: unknown) { return <any>o; }',
    'export let dummy = <Record<string, number>>{};',
    'export const s = (<Observable<T>>source).pipe(x);',
    'observable.source = <Observable<T>>source;\nexport {};',
    'x.y = <T>z;',
    'export const a = <any>(<unknown>b), c = [<number>d, <string>e.f(g)], h = f(<T>x, <U>y);',
    'export const n = -<number>x + +<number><unknown>y;',
    'export const t = typeof (<any>source).getSubject === "function";',
    'export const isBaz = (x: any): x is Baz => x && (<Baz>x).baz !== undefined;',
    'export const r = <any>((x: number) => x);',
    'export const k = <const>["a", "b"], l = <any>await p, v = <T>x!.y;',
    'export const w = new (<any>Ctor)(1), z = <any>new Ctor();',
    'export const q = <any>`t${1}`, u = <number><any>"s";',
    'export const g = <T>(x: T) => x, h = <T,>(x: T): T => <T>x;',
    'export const o = <any>{ a: 1 }, f = [<any>function () {}, <any>class {}], g2 = h(<T>{}), r2 = < <T>(x: T) => T>f;',
    'export function k(x: any) { x = <any>{}; return <any>{ a: x }; }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'assert.ts').backend, 'pulse', source);
  }
});

test('an assertion that erasing would split from its operand, and one in other dialects, is left to the reference route', () => {
  for (const source of [
    'export function f(o: unknown) { return <any>\n o; }',
    'export function f(o: unknown) { return <{\n a: 1 }>o; }',
    'export const p = <number>value ** 2;',
    // Erased, these would open a block, a declaration or an arrow body where the source has an expression.
    'export const v = (a: number) => <any>{};',
    '<Foo>{ a: undefined };\nexport {};',
    'export function f(x: any) { if (x) <any>{ a: 1 }; else <any>function () {}; }',
    'label: <any>{ a: 1 };\nexport {};',
    '<any>class {};\nexport {};',
    // Two opening angles are a shift operator to the scanner.
    'var r3 = <<T>(x: T) => T>f;\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'assert.ts' }).backend, 'pulse', source);
  }
  assert.equal(compile(Buffer.from('x.y = <T>z;\nexport {};'), { file: 'assert.js' }).code, null);
  assert.match(compile(Buffer.from('const a = <T>z</T>;\nexport {};'), { file: 'assert.tsx' }).code, /children/);
});

test('an enum inside a function or a block is lowered with a block-scoped binding', () => {
  for (const source of [
    'test("native enum", () => { enum Fruits { apple = "apple", orange = "orange", } const s = z.nativeEnum(Fruits); });\nexport {};',
    'export function f() { enum E { A, B = 1 << 2, C } return E.C; }',
    'export function f(x: number) { if (x) { const enum K { Z = 9 } return K.Z; } enum E { A } return E.A; }',
    'export const g = () => { enum GridLineColor { Bold = "#cccccc", Regular = "#e5e5e5" } return GridLineColor.Bold; };',
    'export enum Top { A }\nexport function f() { enum Inner { B = 2 } return [Top.A, Inner.B]; }',
    'export function f() { let a = b\n enum E { A }\n return [a, E.A]; }',
    '{ enum B { A } }\nexport {};',
    'export function f() { enum E { A = 1, B = A + 1, "c d" = 3 } return <number>E.B; }',
  ]) {
    const result = sameAsTypeScript(source, 'local.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /\blet \w+; \(function/, source);
  }
  // Beside parameter properties TypeScript declares a block enum with var, which is visible before its
  // declaration. That pair is left to TypeScript.
  for (const source of ['export class C { constructor(public a: number) { enum L { X = 4 } this.a = L.X; } }',
    'export class Job { constructor(public state: string) { const read = () => typeof State; this.state = read(); enum State { Ready } } }',
    'export class C { constructor(public a: number) {} }\nexport function f() { enum L { X } return L.X; }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'local.ts' }).backend, 'pulse', source);
  }
  const view = sameAsTypeScript('export const v = () => { enum E { A } return <i>{E.A}</i>; };', 'local.tsx');
  assert.equal(view.backend, 'pulse');
});

test('enums inside blocks that the emitter cannot evaluate, and enum as a plain name, stay off the native route', () => {
  for (const source of [
    'export function f() { enum E { A = g() } return E.A; }',
    'export function f() { enum E { A } enum E { B } return E; }',
    'export function f() { enum E { A = `x` } }',
    'export function f() { enum E { [k] = 1 } }',
    'export function f() { declare enum E { A } return 1; }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'local.ts' }).backend, 'pulse', source);
  }
});

test('a spread of an object literal in JSX writes its members among the other properties', () => {
  for (const source of [
    'export const a = <g {...{ }} />;',
    'export const a = <g {...{ a: 1 }} b={2} />;',
    'export const a = <g c {...{ a: 1, ...q, m(){}, [k]: 2, get x(){ return 1; } }} b={2} />;',
    'export const a = <g {...{}} {...o} />;',
    'export const a = <g {...{a}}>x</g>;',
    'export const a = <g key="k" {...{ a: 1 }} />;',
    // A literal is not a spread for the choice between the runtime and createElement.
    'export const a = <g {...{ a: 1 }} key="k" />;',
    'export const a = <g {...{ }} key="k" />;',
    'export const a = <g {...{ key: 1 }} />;',
    'export const a = <g {...{ a: 1, }} {...{b:2}} />;',
    'export const a = <g {...{ a: x as any, b: <T,>(y: T) => y }} />;',
    'export const a = <g {...{\n a: 1,\n b: 2,\n}} />;',
    'export const a = <g {...{ children: 1 }}>x</g>;',
    'export const a = <g {...{ a: <b {...{ c: 1 }} /> }} d />;',
    'export const a = <g {...{ a: [1, 2,], }} {...o} key={k} />;',
    'export const a = <g {...{ s: \'x,\', t: `a${b},` }} />;',
    'interface P { a: number }\nexport const a = (p: P) => <g {...{ a: p.a, "b-c": 2, d: () => { return { e: 1 }; } }} />;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'spread.tsx').backend, 'pulse', source);
  }
  // TypeScript keeps the spread of a literal that names __proto__. A comment could hide a trailing comma. A
  // literal followed by an operator or a member access is not the whole value.
  for (const source of [
    'export const a = <g {...{ __proto__: null }} />;',
    'export const a = <g {...{ a: 1 /* c */, }} />;',
    'export const a = <g {...{ a: 1 } || { b: 2 }} />;',
    'export const a = <g {...{ a: 1 }[k]} />;',
    'export const a = <g {... { a: 1 }.b} />;',
    'export const a = <g {...{ a: 1 } as any} />;',
    // A spread among the members makes a later key go to createElement in TypeScript.
    'export const v = <W {...{ ...props }} key={id} />;',
    'export const v = <W {...{ a: [...x] }} key={id} />;',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'spread.tsx').backend, 'pulse', source);
  }
  for (const source of ['export const v = <W {...{ a: [...x] }} b />;', 'export const v = <W key={id} {...{ ...props }} />;',
    'export const v = <W {...o} {...{ ...props }} key={id} />;']) {
    assert.equal(sameAsTypeScript(source, 'spread.tsx').backend, 'pulse', source);
  }
  // A classic factory receives {} for an empty literal, where a tag without attributes passes null.
  assert.notEqual(compile(Buffer.from('export const v = <W {...{}} />;'), { file: 'a.tsx', jsx: 'classic' }).backend, 'pulse');
  assert.equal(compile(Buffer.from('export const v = <W {...{ a: 1 }} />;'), { file: 'a.tsx', jsx: 'classic' }).backend, 'pulse');
});

test('an erased declaration without a semicolon leaves the comment on the next line', () => {
  for (const source of [
    'type C = string\n/*#__PURE__*/ prepare();\nexport {};',
    'declare const a: T, b\n/*#__PURE__*/ prepare();\nexport {};',
    'declare function s(): void\n/*#__PURE__*/ s();\nexport {};',
    'export {}; if (e) { type C = string\n/*#__PURE__*/ prepare(); }',
    'export function f() { type C = string\n/*#__PURE__*/ prepare(); }',
    'function s(): void\n/*#__PURE__*/ s();\nfunction s() {}\nexport {};',
  ]) {
    const result = sameAsTypeScript(source, 'pure.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /\/\*#__PURE__\*\/ (prepare|s)\(\);/, source);
  }
});

test('a comparison with a name or a number before a comma in an argument list is not a type argument list', () => {
  for (const source of [
    'export const a = f(x < 3, "any object");',
    'it.skip(isElectron && electronMajorVersion < 30, "error: Browser > context");\nexport {};',
    'it.skip(browserName === "webkit" && isMac && parseInt(os.release(), 10) < 20, "WebKit");\nexport {};',
    'export const g = f(a < b, c, d), h = f(v.major < 18, `t${a}`), i = f(a < b, () => x), l = f(a < 3n, 0x10, -1);',
  ]) {
    assert.equal(sameAsTypeScript(source, 'less.ts').backend, 'pulse', source);
  }
  // Here TypeScript reads type arguments, or the rest does not end the attempt at the closing parenthesis.
  for (const source of [
    'export const b = f(a < b, c > (d));',
    'export const c = f(a < b, c >> (d));',
    'export const d = f(a < 3, c > (d));',
    'export const e = f(a < b, "x", c > (d));',
    'export const k = f(a < b, [c] > (d));',
    'export const m = f(a < b, c\n> (d));',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'less.ts').backend, 'pulse', source);
  }
});

test('interfaces of one name merge, optional tuple operands may be composite, and async implements plain overloads', () => {
  for (const source of [
    'export interface T<in out A> extends V<A> {}\nexport interface T<in out A> { }',
    'interface T { a: 1 }\ninterface T { b: 2 }\nexport {};',
    'export interface T { a: 1 }\ninterface T { b: 2 }',
    'interface T { a: 1 }\nclass T { }\ninterface T { b: 2 }\nexport { T };',
    'export type Q = [string[], { }?,];',
    'export type O = [("method" | "property")?];',
    'export type O = [((a: string) => void)?, { a: 1 }[]?, (A | B)[]?];',
    'export class L { waitFor(): Promise<void>;\n  async waitFor(o?: any) { } }',
    'export class L { waitFor(): Promise<void>; waitFor(a: 1): Promise<void>;\n  async waitFor(o?: any) { await o; } m() {} }',
    'export class L { static f(): void;\n  static async f(o?: any) { } }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'merge.ts').backend, 'pulse', source);
  }
  for (const source of [
    'interface T { a: 1 }\ntype T = 1;\nexport {};',
    'import { T } from "m";\ninterface T { a: 1 }\nexport {};',
    'export type O = [(a: string) => void?];',
    'export type O = [{ a: 1 } | B?];',
    'export type O = [readonly { a: 1 }[]?];',
    'export class L { async waitFor(): Promise<void>;\n  waitFor(o?: any) { } }',
    'export class L { f(): void;\n  static async f(o?: any) { } }',
    'export class L { f(): void;\n  async g(o?: any) { } }',
    'export class L { f(): void;\n  async *f(o?: any) { } }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'merge.ts' }).backend, 'pulse', source);
  }
});

test('abstract classes inside functions and type declarations in module-level blocks are erased', () => {
  for (const source of [
    'test("i", async () => { abstract class A { } });\nexport {};',
    'export function f() { abstract class A { abstract m(): void; n() {} } return A; }',
    'export function f() { abstract\nclass A { } return A; }',
    'export function f() { const abstract = 1; abstract; class A {} return abstract; }',
    'if (x) { type T = 1; interface I { } g(); }\nexport {};',
    'for (const a of b) { type T = 1; g(a as T); }\nexport {};',
    'try { interface I { a: 1 } g(); } catch { type E = 1; }\nexport {};',
    'switch (x) { case 1: type T = 1; break; }\nexport {};',
    '{ type T = 1; }\nexport {};',
    'type T = 1;\n{ type T = 2; const a: T = 2; g(a); }\nexport {};',
    '{ type\nT = 1; }\nexport {};',
    '{ interface I { a: 1 } interface I { b: 2 } const I = 1; g(I); }\nexport {};',
    'while (x) { type T = 1; const type = 2; g(type); }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'block.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export function f() { abstract class A {} abstract class A {} }',
    'export function f() { if (x) abstract class A {} }',
    '{ type T = 1; type T = 2; }\nexport {};',
    'if (x) type T = 1;\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'block.ts' }).backend, 'pulse', source);
  }
});

test('declared functions, declared variable lists and static members of declared classes are erased', () => {
  for (const source of [
    'declare function gc(): void\nexport {};',
    'declare function v(a: number,): { }\nexport {};',
    'declare function t<V, M extends string = string,>(): E<D<any, V, M>>\nexport {};',
    'declare function f(a: string): void;\ndeclare function f(a: number): void;\nexport const b = f(1);',
    'export const a = 1;\ndeclare function gc(): void;',
    'declare const module: any, global: any;\nexport {};',
    'declare const e;\nexport {};',
    'declare var a, b: string, c;\nexport const d = [a, b, c];',
    'declare class L { static readonly version: string; }\nexport {};',
    'export declare class E<C extends L.T, O extends S<C>,> { static readonly version: string; }',
    'declare class F extends S.E<A.B, C.D> { static readonly c: "flat"; }\nexport {};',
    'declare class L { override m(): void; static override n: number; }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'ambient.ts').backend, 'pulse', source);
  }
  for (const source of [
    'declare function f() { }\nexport {};',
    'declare function* f(): void;\nexport {};',
    'declare async function gc(): void;\nexport const a = 1;',
    'declare function f(): void;\nconst f = 1;\nexport {};',
    'declare\nfunction f(): void;\nexport {};',
    'declare const a: number = 1;\nexport {};',
    'declare const a: number, a: string;\nexport {};',
    'declare const a: number;\nconst a = 1;\nexport {};',
    'declare let { a }: any;\nexport {};',
    'declare class L { static prototype: L; }\nexport {};',
    'declare class L { static m() {} }\nexport {};',
    'declare class L { static x = 1; }\nexport {};',
    'declare class L { declare x: number; }\nexport {};',
    'declare class L { static async m(): void; }\nexport {};',
    'class L { static m(): void; }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'ambient.ts' }).backend, 'pulse', source);
  }
});

test('the helper import and a JSX element keep the statement boundaries of a source without semicolons', () => {
  for (const source of [
    'const n = 1\nexport const v = <W />',
    'const x=<X/>\nexport {x}',
    'const n = 1\nconst m = 2\nexport const v = <W />;',
    '"use client"\nexport const v = <W />',
    '"use client" // c\n"use strict"\nexport const v = <a/>',
    'import a from "a"\nexport const v = <W />',
  ]) {
    const result = sameAsTypeScript(source, 'asi.tsx');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotThrow(() => new Function(result.code.replace(/^\s*import[^;\n]*[;\n]/gm, '').replace(/export /g, '').replace(/import\{[^}]*\}from"[^"]*";/g, '')), source);
  }
  // Without an export the file is a script, and its directive has to stay in front of the helper import.
  const script = compile(Buffer.from('"use client"\nconst v = <W />'), { file: 'asi.tsx' });
  assert.match(script.code, /^"use client"\s*;?\s*import/);
  // TypeScript ends the expression at a JSX element. Lowered to a call, these would apply it.
  for (const source of [
    'export const x=<X/>\n(foo)()',
    'export const x=<X/>\n[a].map(f)',
    'export const x=<X/> // c\n`t`',
    'export const x=<><a/></>\n(foo)()',
    'export const v = <W {...{id: 1, }} disabled />',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'asi.tsx').backend, 'pulse', source);
  }
});

test('setters in object types are read and index signatures in classes are erased', () => {
  for (const source of [
    'export interface R { set value(v: number) }',
    'export interface R { get value(): number; set value(v: number); }',
    'export interface R { set value(v) }',
    'export type R = { set value(v: number), get value(): number };',
    'export interface R { set(v: number): void; set: number }',
    'export class U extends Error { [key: string]: unknown; }',
    'export class U { [key]: string; }',
    'export class U { x\n  [key: string]: unknown }',
    'declare class U { [key: string]: unknown; }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'members.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export interface R { set value(): void }',
    'export interface R { set value(a: number, b: number) }',
    'export interface R { set value(v: number): void }',
    'export class U { static [key: string]: unknown; }',
    'export class U { readonly [key: string]: unknown; }',
    'export class U { [key: string]: unknown = 1; }',
    'export class U { [key: string] }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'members.ts' }).backend, 'pulse', source);
  }
});

test('an export assignment at the end of a file becomes module.exports', () => {
  for (const source of [
    'export = { a: 1 };',
    'import x from "x";\nconst rules = { a: x };\nexport = { rules, meta: { name: "n" } } satisfies L.Plugin;',
    'function f(a: number) { return a; }\nexport = f;',
    'export = <T>{ a: 1 };',
    'enum E { A }\nexport = E;',
    'export =\n  { a: 1 };',
    'export = class { x: number = 1 };',
  ]) {
    const result = sameAsTypeScript(source, 'assign.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /module\.exports =/, source);
  }
  for (const source of [
    'export = f\nfunction f() {}',
    'export = { a: 1 };\nconst b = 2;',
    'export const a = 1;\nexport = a;',
    'import fs = require("fs");\nexport = fs;',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'assign.ts' }).backend, 'pulse', source);
  }
  const mapped = compile(Buffer.from('const value: number = 1;\nexport = value;\n'), { file: 'assign.ts', sourceMap: true });
  assert.equal(mapped.code.includes('module.exports = value;'), true);
});

test('a namespace with exported variables, functions and classes is lowered as TypeScript lowers it', () => {
  for (const source of [
    'export namespace N { export const a = 1; }',
    'namespace N { export const a = 1; }\nexport {};',
    'export namespace errorUtil { export type E = string; export const errToObj = (message?: string) => typeof message === "string" ? { message } : message || {}; export const toStr = (m?: string): string => "x"; }',
    'export namespace D { export function disposeAll(d: any[]): void { for (const x of d) x(); } }',
    'export namespace D { export class K<T> { v!: T } }',
    'export namespace D { const hidden = 2; function g() { return hidden; } export async function h() { return g(); } }',
    'export namespace N { export interface I { a: 1 } export const v: I = { a: 1 }; type L = 1; enum Loc { A } export const w = Loc.A; }',
    'const before = 1\nexport namespace N { export var x = before }\nconst after = N.x',
    'export namespace N { export function* g() { yield 1 } export const k = class {} }',
    'export namespace D { export function f() { } export const a = 1; }',
    // An exported enum is written as inside a block and stored in the namespace object.
    'export namespace N { export enum E { A, B = "b" } }',
    'export namespace N { export const enum F { Strict = "strict", Lax = "lax", } export const x = F.Lax; }',
    // A name behind a dot is a property, not a reference to the exported variable.
    'namespace Scope { export const ScopeType = scopeManager.ScopeType; }\nexport {};',
    'export namespace N { export const a = 1; export const b = o.a + o?.a; }',
    // The namespace is a value and shares its name with a type.
    'export interface N { a: 1 }\nexport namespace N { export const a = 1; }',
    'namespace N { export type T = 1 }\nnamespace N { export const a = 1; }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'space.ts').backend, 'pulse', source);
  }
  for (const source of ['export class N { }\nexport namespace N { export const a = 1; }',
    'export enum N { A }\nexport namespace N { export const a = 1; }',
    'import { N } from "m";\nexport namespace N { export const a = 1; }',
    'export namespace N { export const a = 1; export const b = { a: 2 }; }',
    'export namespace N { export const a = 1; export const b = [...a]; }',
    'export namespace N { export enum E { A } export enum E { B } }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'space.ts' }).backend, 'pulse', source);
  }
  for (const source of [
    'export namespace N { export const a = 1; export const b = a + 1; }',
    'export namespace N { export const a = () => N; }',
    'export namespace N { export const a = 1, b = 2; }',
    'export namespace N { export let c; }',
    'export namespace N { export const { a } = o; }',
    'export namespace N { export namespace M { export const a = 1; } }',
    'export namespace A.B { export const a = 1; }',
    'export namespace N { export const a = 1; }\nexport namespace N { export const b = 2; }',
    'export function N() {}\nexport namespace N { export const a = 1; }',
    'export namespace N { export function f(): void; export function f() {} }',
    'export namespace N { export const a = 1; return 1; }',
    'export namespace N { export const a = 1; export default 1; }',
    'export namespace N { import X = Y.Z; export const a = 1; }',
    'export namespace N { export declare const z: number; export const a = 1; }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'space.ts' }).backend, 'pulse', source);
  }
  // The lowered text runs: the object receives its members.
  const result = compile(Buffer.from('namespace N { export const a = 1; export function f() { return 2; } export class K {} }\nglobalThis.seen = [N.a, N.f(), typeof N.K];\nexport {};'), { file: 'space.ts' });
  assert.equal(result.backend, 'pulse');
  new Function(result.code.replace('export {};', ''))();
  assert.deepEqual(globalThis.seen, [1, 2, 'function']);
  delete globalThis.seen;
});

test('parameter properties are assigned behind a super call that follows other statements', () => {
  for (const source of [
    'export class P extends Column { constructor(readonly table: G, config: X) { if (!config.u) { config.u = k(table); } super(table, config); } }',
    'export class P extends Column { constructor(readonly table: G) { const a = 1; f(a); super(table); this.g(); } }',
    'export class P extends Column { constructor(readonly table: G) { f()\n    super(table)\n    g() } }',
    'export class P extends Column { constructor(readonly table: G) { "use strict"; super(table); } }',
    'export class P extends Column { constructor(readonly table: G) { super(table); super(table); } }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'super.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export class P extends Column { constructor(readonly table: G) { if (x) { super(table); } else { super(1); } } }',
    'export class P extends Column { constructor(readonly table: G) { f(() => super(table)); } }',
    'export class P extends Column { constructor(readonly table: G) { try { super(table); } finally { } } }',
    'export class P extends Column { constructor(readonly table: G) { const v = super(table); } }',
    'export class P extends Column { constructor(readonly table: G) { f(); super(table), g(); } }',
    'export class P extends Column { constructor(readonly table: G) { label: super(table); } }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'super.ts' }).backend, 'pulse', source);
  }
});

test('a JSX file with unicode escapes in strings and a disabled disjunction are lowered natively', () => {
  for (const source of [
    'export const a = <T n={l ? "Loading\\u2026" : "No"} />;',
    'export const a = f("L\\u2026"); export const b = <T/>;',
    'export const a = <R c={s.map(() => ({ label: `${scale}\\u00d7` }))} />;',
    'export const a = <button disabled={!x || y}>t</button>;',
    'export const a = <button disabled={x || y} />;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'escape.tsx').backend, 'pulse', source);
  }
  // These escapes could spell a helper name that the text search for _tmt would not see.
  for (const source of [
    'export const a = <T n={"\\u{2026}"} />;',
    'export const \\u005ftmtJsx0 = 1; export const b = <T/>;',
    'export const _\\u0074mtJsx0 = 1; export const b = <T/>;',
    'export const _t\\u006DtJsx0 = 1; export const b = <T/>;',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'escape.tsx').backend, 'pulse', source);
  }
});

test('review findings on the super walk, export assignments in JSX files and namespaces with non-ASCII text', () => {
  // The walk to the super call parses again and must leave the records of the file intact: the enum is still
  // lowered and both properties are assigned.
  const walked = sameAsTypeScript('export enum Status { BadRequest = 400 }\nexport class ApiError extends Error {\n' +
    '  constructor(public status: Status, public details: string) {\n' +
    '    const describe = (status: Status, details: string): string => `${status}: ${details}`;\n' +
    '    super(describe(status, details));\n  }\n}', 'walk.ts');
  assert.equal(walked.backend, 'pulse');
  assert.match(walked.code, /this\.details = details/);
  assert.doesNotMatch(walked.code, /\benum\b/);
  // An ECMAScript output cannot carry an export assignment, on the JSX route as on the others.
  const assigned = 'const SettingsPanel = () => <button />; export = SettingsPanel;';
  const esm = compile(Buffer.from(assigned), { file: 'settings.tsx', module: 'esm' });
  assert.equal(esm.code, null);
  assert.equal(esm.diagnostics[0].code, 'INCOMPATIBLE_MODULE_SYNTAX');
  assert.match(sameAsTypeScript(assigned, 'settings.tsx').code, /module\.exports = SettingsPanel/);
  // A line separator outside ASCII ends a statement, so the next word is a reference the byte search would miss.
  const separated = 'export namespace Settings { export let mode = "start"; mode = "ready"; }';
  assert.notEqual(sameAsTypeScript(separated, 'space.ts').backend, 'pulse');
  assert.notEqual(compile(Buffer.from('export namespace N { export const a = 1; const é = 2; }'), { file: 'space.ts' }).backend, 'pulse');
});

test('looking for a module marker behind a decorator leaves the records of the file intact', () => {
  const source = 'class Base {}\nclass Item extends Base {\n  constructor(public id: number) { log(id); super(); }\n}\n' +
    'namespace Data { export const size = 1; }export type Id = number;\n' +
    '@tag(`a${1}b${2}c${3}d${4}e${5}f${6}g${7}h`) export class Marked {}\nexport enum Mode { Default }\nexport { Item, Data };';
  for (const options of [{ file: 'a.ts', module: 'esm' }, { file: 'a.ts', module: 'esm', sourceMap: true }, { file: 'a.ts' }]) {
    const result = compile(Buffer.from(source), options);
    assert.equal(typeof result.code, 'string');
    assert.doesNotMatch(result.code, /\bnamespace\b/, JSON.stringify(options));
    assert.match(result.code, /this\.id = id/, JSON.stringify(options));
  }
  const mapped = compile(Buffer.from('export namespace Data { export const size = 1; }'), { file: 'a.ts', sourceMap: true });
  assert.equal(mapped.backend, 'pulse');
  assert.equal(mapped.sourceMap.mappings.length > 0, true);
});

test('a comparison item is not a type argument list when no closing angle follows before the bracket', () => {
  for (const source of [
    'export const a = g(1, () => x < 3, () => x + 1);',
    'export const a = fold([s, 0], () => t[1] < max, ([o, c],) => [f(o, i), c + 1]);',
    'export const a = filter(() => a < max, { typeId: L, description: max === 0 ? "neg" : `less ${max}` });',
    'assert.ok(Math.abs(r.getTime() - now) < 100, `${r.getTime()} is within`);\nexport {};',
    'export const a = f(a < b, g(c), h) > (d);',
    'export const a = [a < b, () => 1];',
    'export const a = f(g(a < b, c), d > (e));',
    'export const a = f(x => a < b, y => y, z);',
    'export const n = f(a < b < c, d);',
  ]) {
    assert.equal(sameAsTypeScript(source, 'angle.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export const a = f(a < b, c > (d));',
    'export const a = f(a < b, c >= d);',
    'export const a = f(a < b, c >> (d));',
    'export const a = f(a < b, () => c > (d));',
    'export const a = f(a < b, x => x, c > (d));',
    'export const a = f(a < b, g(c > (d)));',
    'export const a = [a < b, c > (d)];',
    'export const a = f(a < b, c = d > (e));',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'angle.ts').backend, 'pulse', source);
  }
});

test('an ambient module at the start of a file and lexical globals in a global augmentation are erased', () => {
  for (const source of [
    'declare module "typescript" { }\nexport {};',
    'declare module "typescript" { export interface A { a: 1 } }\nexport const a = 1;',
    'declare global { let $g: typeof g | undefined }\nexport {};',
    'declare global { const T: "a" | "b" }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'ambient.ts').backend, 'pulse', source);
  }
});

test('import attributes with any single key and a non-null mark on a constructor are native', () => {
  for (const source of [
    'import type { A } from "knip" with { "resolution-mode": "import" };\nexport {};',
    'import type * as U from "u" with { "resolution-mode": "import" };\nexport {};',
    'import j from "./a.json" with { type: "json" };\nexport { j };',
    'import j from "./a.json" with { "a-b": "c", };\nexport { j };',
    'import j from "./a.json" with { foo: "bar" }\nexport { j };',
    'export const s = new W!(u);',
    'export const s = p ? new W!(u, p) : new a.b.W!();',
    'export const s = new W!;',
    'export const s = new W! (u);',
  ]) {
    assert.equal(sameAsTypeScript(source, 'attributes.ts').backend, 'pulse', source);
  }
  for (const source of [
    'import j from "./a.json" with { type: 1 };\nexport { j };',
    'import j from "./a.json" with { type: "json", type: "x" };\nexport { j };',
    'export const s = new W!.x();',
    'export const s = new W\n!(u);',
    'export const s = new W != u;',
    'export const s = new W!<T>(u);',
    'export const s = new W![0](u);',
    'export const s = new W!!(u);',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'attributes.ts' }).backend, 'pulse', source);
  }
});

test('a parameter of a signature may stand without a type', () => {
  for (const source of [
    'function n(): (string) => string[] { return x }\nexport {};',
    'export type F = (a, b) => void;',
    'export type F = (a?, ...b) => void;',
    'export type G = (A) | B;',
    'export type G = (A);',
    'export type G = (a: A, b) => (c) => void;',
    'export type H = new (a) => X;',
    'export const x = (a) as any;',
    'export const y = <T>(a) => a;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'untyped.ts').backend, 'pulse', source);
  }
  // TypeScript rejects this one, and so does the compiler.
  assert.equal(compile(Buffer.from('export type G = (A, B);'), { file: 'untyped.ts' }).code, null);
});

test('lists of tens of thousands of items compile without using the stack', () => {
  const many = (count, item) => Array.from({ length: count }, () => item).join(', ');
  for (const source of [
    'export const a = [' + many(40000, 'x') + '];',
    'export const a = f(' + many(40000, 'x') + ');',
    'export const a = [' + many(40000, 'a < b') + '];',
    'export const a = f(' + many(40000, 'p.q < 3') + ');',
  ]) {
    const result = compile(Buffer.from(source), { file: 'long.ts' });
    assert.equal(result.backend, 'pulse');
    assert.equal(result.code, source);
  }
});

test('an assignment pattern with defaults in parentheses is an expression statement', () => {
  for (const source of [
    'export function r() { ({ a = 1 } = c); }',
    'export function r() { ({ count = Infinity, delay } = config); }',
    'export function r() { ({ a = 1, b: d = 2, ...rest } = c); }',
    'export function r() { ({ a = x < y ? 1 : 2, b } = c); return a; }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'cover.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export function r() { ({ a = 1 }); }',
    'export function r() { ({ a = 1 } == c); }',
    'export function r() { ({ a = 1 } => c); }',
    'export function r() { ({ a = 1, b: { d = 2 } = {} } = c); }',
    'export function r() { ({ a = 1, ...rest, b } = c); }',
    // A target has to be assignable in strict code.
    'export function r() { ({ eval = 1 } = c); }',
    'export function r() { ({ a: arguments = 1 } = c); }',
    'export function r() { ({ a = 1, ...eval } = c); }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'cover.ts' }).backend, 'pulse', source);
  }
});

test('factory pragmas mean nothing under the automatic runtime and still select the classic factory', () => {
  for (const source of [
    '/** @jsx h */\nexport const a = <a/>;',
    '/** @jsx jsx */\n/** @jsxFrag Fragment */\nexport const b = () => <><a/></>;',
    '/** @JSX h */\nexport const a = <a/>;',
    '/** @jsxfrag F */\nexport const a = <a/>;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'pragma.tsx').backend, 'pulse', source);
    const classic = compile(Buffer.from(source), { file: 'pragma.tsx', jsx: 'classic' });
    assert.notEqual(classic.backend, 'pulse', source);
  }
  for (const source of [
    '/** @jsxRuntime classic */\n/** @jsx h */\nexport const a = <a/>;',
    '/** @jsxImportSource preact */\n/** @jsx h */\nexport const a = <a/>;',
    '/** @jsx h @jsxImportSource x */\nexport const a = <a/>;',
    '/** @jsxs h */\nexport const a = <a/>;',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'pragma.tsx').backend, 'pulse', source);
  }
});

test('abstract members may be marked override, and a type declaration may follow a lowered namespace or enum', () => {
  for (const source of [
    'export abstract class A extends B { abstract override m(): void; }',
    'export abstract class A extends B { protected abstract override m(): void; abstract override x: number; }',
    'export abstract class A extends B { public abstract override transaction<T>(a: (tx: P<Q>) => Promise<T>): Promise<T>; }',
    'export namespace N { export const a: any = 1; }\ntype Z = 1;',
    'export namespace N { export interface X {} export enum E { A } }\ntype Z = 1;',
    'enum E { A }\ntype Z = 1;\nexport { E };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'members.ts').backend, 'pulse', source);
  }
  for (const source of [
    'export abstract class A extends B { abstract static m(): void; }',
    'export abstract class A extends B { abstract override m() {} }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'members.ts' }).backend, 'pulse', source);
  }
});

test('the rest parameter of an arrow function may be a binding pattern', () => {
  for (const source of [
    'export const f = (...[a, b]: [number, string]) => a;',
    'export const f = (...[a, b]) => a;',
    'export const T = <P extends N<Q>>(...[head, ...tail]: P): T<J<P>> => { return head; };',
    'export const f = (x: number, ...{ length }: any[]) => length;',
    'export const f = (...[a = 1, { b }]: X) => a + b;',
    'export const f = async (...[a]: X) => await a;',
    'm((...[c, o, h]: Parameters<typeof g>) => { throw e; });\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'rest.ts').backend, 'pulse', source);
  }
  for (const source of ['export const f = (...[a], b) => a;', 'export const f = (...[a, a]) => a;']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'rest.ts' }).backend, 'pulse', source);
  }
});

test('review findings: a mark behind JSX, a string behind an erased declaration, with on the next line, and comparisons before declarators', () => {
  // TypeScript rejects a non-null mark behind a JSX element.
  assert.notEqual(compile(Buffer.from('export function r() { return <View />!; }'), { file: 'a.tsx' }).backend, 'pulse');
  assert.equal(sameAsTypeScript('export const a = <V /> != b;', 'a.tsx').backend, 'pulse');
  // With the declaration erased the string would become a directive in front of the helper import.
  for (const source of [
    'declare module "pkg" { interface O {} }\n"use client";\nexport const view = <View />;',
    'interface O {}\n"use client";\nexport const view = <View />;',
    '"use client";\ninterface O {}\n"x";\nexport const view = <View />;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'a.tsx').backend.includes('pulse'), false, source);
  }
  for (const source of [
    '"use client";\ninterface O {}\nexport const view = <View />;',
    '"use client";\n"use strict";\nimport a from "a";\nexport const view = <View />;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'a.tsx').backend.includes('pulse'), true, source);
  }
  // Without JSX no import is written, and TypeScript's output starts with the string as well.
  assert.equal(sameAsTypeScript('declare module "pkg" { interface O {} }\n"use client";\nexport const v = 1;', 'a.ts').backend.includes('pulse'), true);
  // An import may carry its with clause on the next line.
  assert.equal(sameAsTypeScript('import c from "./config.json"\nwith { type: "json" };\nexport { c };', 'a.ts').backend, 'pulse');
  // TypeScript reads `with` on the next line as a statement of its own.
  assert.notEqual(compile(Buffer.from('export { default as config } from "./config.json"\nwith { "type": "json" };'), { file: 'a.ts' }).backend, 'pulse');
  // A comparison in a declarator may be followed by further declarators when no closing angle follows it.
  for (const source of [
    'const a = r < 3, b = 1;\nexport {};',
    'export const ok = s >= 200 && s < 300, other = () => new E({ a });',
    'export function f() { const a = x < y, b = 1; let c = a < b, d; return [a, b, c, d]; }',
    'export const a = f(s >= 200 && s < 300, () => new E({ a }));',
  ]) {
    assert.equal(sameAsTypeScript(source, 'a.ts').backend, 'pulse', source);
  }
  for (const source of [
    'const a = x < y, b > (c);\nexport {};',
    'const a = x < y, b = z > (w);\nexport {};',
    'export function f() { let a = x < y, b > (c); }',
    'export const a = f(s < 300, s > 1);',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'a.ts').backend, 'pulse', source);
  }
});
