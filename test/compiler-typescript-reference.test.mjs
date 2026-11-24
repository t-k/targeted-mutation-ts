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
      const native = pragma === 'Absent' ||
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
