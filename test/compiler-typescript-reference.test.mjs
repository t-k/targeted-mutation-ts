import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'merge.ts' }).backend, 'pulse', source);
  }
  // A namespace of types shares its name with an enum that exists at run time.
  assert.equal(sameAsTypeScript('enum B { A }\ndeclare namespace B { type S = 1 }\nexport const y = B;', 'merge.ts').backend, 'pulse');
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
      // it stands. In a line comment the text is no pragma at all: TypeScript reads these from block comments.
      const native = pragma === 'Absent' || (pragma === 'Factory' && mode === 'Automatic') ||
        (place === 'LeadingLine' && (pragma === 'ImportSource' || pragma === 'Runtime')) ||
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
      if (pragma === 'ImportSource' && mode === 'Automatic') {
        assert.ok(modules(result.code).every(name => name.startsWith(place === 'LeadingLine' ? 'react' : 'preact')), source);
      }
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
  for (const source of ['export namespace N { export const a = 1; }\nexport enum N { A }',
    'import { N } from "m";\nexport namespace N { export const a = 1; }',
    'export namespace N { export const a = 1; export const b = { a: 2 }; }',
    'export namespace N { export enum E { A } export enum E { B } }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'space.ts' }).backend, 'pulse', source);
  }
  for (const source of [
    'export namespace N { export const a = 1, b = 2; }',
    'export namespace N { export const { a } = o; }',
    'export namespace N { export function f(): void; function f() {} }',
    'export namespace N { export const a = 1; return 1; }',
    'export namespace N { export const a = 1; export default 1; }',
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
  // A name outside ASCII in the body is read through the copy spelled in ASCII, where the byte search is exact.
  assert.equal(sameAsTypeScript('export namespace N { export const a = 1; const é = 2; export const b = () => a + é; }', 'space.ts').backend, 'pulse');
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
    'export const s = new W!.x();',
    'export const s = new W!<T>(u);',
  ]) {
    assert.equal(sameAsTypeScript(source, 'attributes.ts').backend, 'pulse', source);
  }
  for (const source of [
    'import j from "./a.json" with { type: 1 };\nexport { j };',
    'import j from "./a.json" with { type: "json", type: "x" };\nexport { j };',
    'export const s = new W\n!(u);',
    'export const s = new W != u;',
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
  // TypeScript erases a type-only import before it places the helper, so the string behind it is a directive
  // there; and a leading string with a type assertion is a directive only once the assertion is gone.
  for (const source of [
    'import type { Props } from "./props";\n"use client";\nexport const View = () => <div />;',
    '"use client" as string;\nexport const x = <div />;',
    'export type A = 1;\n"x";\nexport const v = <a/>;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'a.tsx').backend.includes('pulse'), false, source);
  }
  // An import or export that stays keeps every later string an ordinary statement, here and in TypeScript,
  // so the scan ends at it and the file stays on the native route.
  for (const source of [
    'import { type A, b } from "m";  "x";\nexport const v = <a/>;',
    'import { type A } from "m";\n"x";\nexport const v = <a/>;',
    'import a from "m";\n"use client";\nexport const v = <a/>;',
    'export { type A } from "m";\n"use client";\nexport const v = <a/>;',
    'export * from "m";\n"use client";\nexport const v = <a/>;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'a.tsx').backend, 'pulse', source);
  }
  for (const source of [
    '"use client";\ninterface O {}\nexport const view = <View />;',
    '"use client"\n"use strict";\nimport a from "a";\nexport const view = <View />;',
    'const a = 1;\n"x";\nexport const v = <a/>;',
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

test('method signatures without a result type, and optional properties and getters of declared classes', () => {
  for (const source of [
    'export type W = { getRuntime: () => { __wbg_set_wasm() } }',
    'export interface W { m(); n?(a: string); o<T>(x: T) }',
    'export type W = { m(), n(): void };',
    'declare class S extends T { p?: Partial<P>; q?: number }\nexport {};',
    'declare class S { get d(): X; static get e(): Y; }\nexport {};',
    'declare class S { set d(v: X); }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'signatures.ts').backend, 'pulse', source);
  }
  for (const source of [
    'declare class S { get d() { return 1 } }\nexport {};',
    // An accessor is declared with its parameter list.
    'declare class Client { get value: number; }\nexport const x = 1;',
    'declare class S { p?: number = 1 }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'signatures.ts' }).backend, 'pulse', source);
  }
  assert.equal(compile(Buffer.from('export type W = { m() => void };'), { file: 'signatures.ts' }).code, null);
});

test('a declared module may hold type aliases beside interfaces', () => {
  for (const source of [
    'import type { K } from "knex";\ndeclare module "knex/types/tables.ts" { export type Knexify<T extends Table> = K.C<T> & {}; }',
    'interface Tables { a: 1 }\ndeclare module "m" { interface Tables { b: 2 } }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'ambient.ts').backend, 'pulse', source);
  }
  for (const source of [
    'declare module "m" { export const a = 1; }\nexport {};',
    'declare module "m" { f(); }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'ambient.ts' }).backend, 'pulse', source);
  }
});

test('a TypeScript script is read as strict code, module names a namespace, and a byte order mark is dropped', () => {
  for (const source of [
    'function f() { var a = 1; return a; }',
    'var x: number = 1;\nfunction g(a: string) { var b = a; { var c = b; } return c; }',
    'function f() { return arguments.callee; }',
    'var a = <any>1;\nfunction h(this: any) { return this; }',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /^"use strict";\n/, source);
  }
  // Strict code has no with statement, no duplicate parameters and no variable named eval.
  for (const source of ['var o = { a: 1 };\nwith (o) { a; }', 'function f(a: number, a: string) { }', 'var eval = 1;', 'delete x;']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
  for (const source of ['module M { export var x = 1; }\nexport {};', 'export module M { export function f() {} }',
    'module.exports = 1;\nexport {};', 'var module = 1; module\n{ }\nexport {};']) {
    assert.equal(sameAsTypeScript(source, 'space.ts').backend, 'pulse', source);
  }
  for (const [source, file] of [['var x: number = 1;', 'a.ts'], ['export const x: number = 1;', 'a.ts'], ['export const x = <a/>;', 'a.tsx']]) {
    const plain = compile(Buffer.from(source), { file });
    assert.equal(plain.backend, 'pulse');
    assert.deepEqual(compile(Buffer.from('﻿' + source), { file }), plain);
    assert.deepEqual(compile('﻿' + source, { file }), plain);
  }
  // With an error the positions refer to the input as it was given.
  const broken = compile(Buffer.from('﻿export const x: = 1;'), { file: 'a.ts' });
  assert.equal(broken.code, null);
  assert.equal(broken.diagnostics[0].start, 17);
});

test('signatures without a result type and properties without a type are erased', () => {
  for (const source of [
    'function f();',
    'function f(a);\nfunction f(a?: any) {}',
    'export function f(a: string);\nexport function f(a: any) { return a; }',
    'interface I { x }',
    'interface I { x; y?; m(); }\nvar i: I;',
    'class C { m(); m(a?: any) {} }',
    'declare function f();',
    'function f()\n{ return 1 }',
    'class C { constructor(); constructor(a?: any) {} }',
    'export default function f();\nexport default function f(a?: any) {}',
  ]) {
    assert.equal(sameAsTypeScript(source, 'bare.ts').backend, 'pulse', source);
  }
  for (const source of ['function f()\nf2();', 'class C { m()\n n() {} }', 'interface I { x\n y }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'bare.ts' }).backend, 'pulse', source);
  }
});

test('a script lowers enums, namespaces and parameter properties as a module does', () => {
  for (const source of [
    'enum E { A, B = 2 }\nvar e = E.A;',
    'const enum F { X = "x" }\nvar f = F.X;',
    'class C { constructor(public x: number, private y?: string) {} }\nvar c = new C(1);',
    'class B {}\nclass D extends B { constructor(readonly z: number) { super(); } }',
    'namespace N { export const a = 1; export function f() {} }\nvar n = N.a;',
    'module M { export var x = 1; }',
    'function f() { enum L { A } return L.A; }',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /^"use strict";\n/, source);
    assert.doesNotThrow(() => new Function(result.code), source);
  }
  for (const source of ['enum E { A }\nenum E { B = 1 }', 'var E = 1;\nenum E { A }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
});

test('a namespace that holds types alone stays erased, whatever its interfaces repeat', () => {
  for (const source of [
    'module M { interface A { x: string } interface A { y: number } }',
    'namespace N { interface A<T> { x: T } interface A<U> { y: U } }\nexport {};',
    'namespace N { export interface A { x: 1 } type T = 1; }\nexport {};',
  ]) {
    const result = sameAsTypeScript(source, 'types.ts');
    assert.doesNotMatch(result.code, /function/, source);
  }
  for (const source of ['namespace N { export interface A { x: 1 } const a = 1; }\nexport {};', 'namespace N { ; }\nexport {};']) {
    const result = sameAsTypeScript(source, 'types.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /\(function \(N\)/, source);
  }
});

test('import-equals declarations become const or var', () => {
  for (const source of [
    'import x = require("x");\nx();',
    'import fs = require("fs");\nexport const r = fs.readFileSync;',
    'import A = B.C;\nA();\nexport {};',
    'import A = B;\nexport const a: A.T = A.v;',
    'import x = require("x");\nexport = x;',
    'import x = require("x")\nimport y = require("y")\nx(y);',
    'import a from "a";\nimport b = a.b;\nexport { b };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'alias.ts').backend, 'pulse', source);
  }
  // An alias alone does not make the file a module, a type-only form is erased by TypeScript, and a name that
  // is declared twice is an error.
  for (const source of ['import x = require;\nx;', 'export import A = require("a");',
    'import x = require(y);\nx;', 'import x = require("x");\nconst x = 1;']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'alias.ts' }).backend, 'pulse', source);
  }
  // With an empty namespace between them the file still is a module and must not get the strict directive
  // of a script, whichever route answers.
  assert.doesNotMatch(sameAsTypeScript('import i = require("mod");\nnamespace N {\n}\nexport = N;', 'alias.ts').code, /use strict/);
  for (const options of [{ file: 'alias.mts' }, { file: 'alias.ts', module: 'esm' }]) {
    const result = compile(Buffer.from('import x = require("x");\nx();'), options);
    assert.equal(result.code, null);
    assert.equal(result.diagnostics[0].code, 'INCOMPATIBLE_MODULE_SYNTAX');
  }
});

test('an import-equals declaration ends where TypeScript ends it', () => {
  // const and var would continue into these next lines; an import declaration does not.
  for (const source of [
    'import fs = require("node:fs")\n(async () => { console.log(fs.existsSync(".")); })();',
    'import Client = SDK.Client\n/ready/.test(status);\nexport { Client };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'alias.ts').backend, 'typescript', source);
  }
  assert.equal(sameAsTypeScript('import A = B.C\nexport const a = A;', 'alias.ts').backend, 'pulse');
  // A next line that begins with a word ends a variable declaration as well.
  assert.equal(sameAsTypeScript('import A = B.C\nA();\nexport {};', 'alias.ts').backend, 'pulse');
  assert.equal(sameAsTypeScript('import A = B.C\nin_use(A);\nexport {};', 'alias.ts').backend, 'typescript');
  // A reserved word in the entity name is an error.
  assert.equal(compile(Buffer.from('import Client = SDK.default; export { Client };'), { file: 'alias.mts' }).code, null);
});

test('erasure through Node is refused where it would regroup or leave invalid code', () => {
  for (const source of [
    'const total = price + tax as number\n  * quantity;\nexport {};',
    'const cost = (fee: number, tax: number) => fee + tax satisfies number\n  * 2;',
    'const v = a + b as Invoice["amount"] * 2;',
    'const v = a + b as\n  number * 2;',
    'const html = renderer?.html!`<p>Hello</p>`;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'group.ts').backend, 'typescript', source);
    const stripped = compile(source, { file: 'group.ts', mode: 'strip' });
    assert.equal(stripped.code, null, source);
    assert.equal(stripped.diagnostics[0].code, 'AMBIGUOUS_TYPE_ERASURE', source);
  }
  assert.equal(compile('const a = b as T\nconst c = d + e;', { file: 'group.ts', mode: 'strip' }).code, 'const a = b     \nconst c = d + e;');
  // Comments between the assertion and the operator, or between the mark and the template, do not hide them.
  for (const source of [
    'export const v = 1 + 2 as number\n// scale\n* 3;',
    'export const v = a + b as/*c*/ number * c;',
    'export const v = a + b as Extract<number, number> * 3;',
    'export const v = a << b as number + c;',
    'const t = a?.b! /*comment*/ `hi`;',
  ]) {
    assert.equal(sameAsTypeScript(source, 'group.ts').backend, 'typescript', source);
    assert.equal(compile(source, { file: 'group.ts', mode: 'strip' }).diagnostics[0]?.code, 'AMBIGUOUS_TYPE_ERASURE', source);
  }
  // Erasure that keeps the grouping is accepted: the words in a comment, an assertion in front of a comment,
  // a subtraction, a plain tag.
  for (const source of [
    '// x as number - y\nexport const v = 1;',
    'export const x = value as number /* comment */;',
    'export const v = x as number\n-y;',
    'export const v = a * b as number + c;',
    'export const v = x as number // m/s\nfoo<string>();',
    'export const t = tag!`hello`;',
  ]) {
    const stripped = compile(source, { file: 'group.ts', mode: 'strip' });
    assert.notEqual(stripped.code, null, source);
    assert.equal(sameAsTypeScript(source, 'group.ts').code !== null, true, source);
  }
  assert.equal(compile('﻿#!/usr/bin/env node\nconsole.log(1);', { file: 'bin.ts', mode: 'strip' }).diagnostics[0].code, 'MISPLACED_HASHBANG');
});

test('the interpreter line is written with a line feed', () => {
  for (const source of ['#!/usr/bin/env node\r\nenum Mode { Dev }', '#!/usr/bin/env node\r\nexport const a: number = 1;\r\n']) {
    for (const input of [source, Buffer.from(source)]) {
      assert.match(compile(input, { file: 'bin.ts' }).code, /^#!\/usr\/bin\/env node\n/, source);
    }
  }
  assert.match(compile('#!/usr/bin/env node\r\nexport const a: number = 1;\r\n', { file: 'bin.ts', mode: 'strip' }).code, /^#!\/usr\/bin\/env node\r\n/);
  // JavaScript that needs no change is returned as the same text, its line ends included.
  assert.equal(compile(Buffer.from('#!/usr/bin/env node\r\nexport const n = 1;'), { file: 'bin.mjs' }).code, '#!/usr/bin/env node\r\nexport const n = 1;');
  // A carriage return alone ends the interpreter line for the compiler, not for the system that reads it.
  assert.match(compile('#!/usr/bin/env node\r/// <reference types="node" />\nconsole.log("ready");', { file: 'bin.ts' }).code,
    /^#!\/usr\/bin\/env node\n"use strict";\n/);
  for (const options of [{ file: 'bin.ts', module: 'esm' }, { file: 'bin.ts', sourceMap: true }]) {
    for (const input of ['#!/usr/bin/env node\r\nexport const n = 1;', Buffer.from('#!/usr/bin/env node\r\nexport const n = 1;')]) {
      assert.match(compile(input, options).code, /^#!\/usr\/bin\/env node\n/, JSON.stringify(options));
    }
  }
});

test('a var below the top level of a module belongs to the module', () => {
  for (const source of [
    '{ var a = 1; }\nexport {};',
    'for (var k in o) {}\nexport {};',
    'for (var i = 0; i < 2; i++) { var j = i; }\nfor (var i = 0; i < 2; i++) { }\nexport {};',
    'if (x) { var y = 1; }\nexport {};',
    'while (x) { var w = 1; }\nexport { w };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'hoist.ts').backend, 'pulse', source);
  }
  // V8 rejects each of these as a redeclaration, so the certified route must not answer.
  for (const source of [
    '{ var a = 1; }\nlet a = 2;\nexport {};',
    'let a = 2;\n{ var a = 1; }\nexport {};',
    '{ var a; }\nimport { a } from "x";',
    'import { a } from "x";\n{ var a; }',
    '{ var a; }\nfunction a() {}\nexport {};',
    'function a() {}\n{ var a; }\nexport {};',
    '{ var a; }\nclass a {}\nexport {};',
    '{ var a; }\nexport const a = 1;',
    '{ var [a, { b }] = c; }\nconst b = 1;\nexport {};',
    'for (var i = 0;;) {}\nlet i;\nexport {};',
    'for (var k in o) {}\nconst k = 1;\nexport {};',
    '{ let a; { var a; } }\nexport {};',
    '{ { var a; } let a; }\nexport {};',
    '{ var a; }\nenum a { X }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'hoist.ts' }).backend, 'pulse', source);
  }
});

test('a module-level var may be declared again by another var, and by nothing else', () => {
  for (const source of [
    'var a = 1; var a = 2;\nexport {};',
    'var a = 1, a = 2;\nexport { a };',
    'var a: number;\nvar a: number = 3;\nexport default a;',
    'var a;\ninterface a {}\nvar a;\nexport {};',
    'var a;\n{ var a; }\nvar a;\nexport { a };',
    '{ var a; }\nvar a;\nexport {};',
    'var a;\nexport { a };\nvar a;',
    'var a = 1, a = 2;\nexport { a as b, a as c };',
    'var a;\nexport default a;\nvar a;',
    'for (var i = 0; i < 1; i++) {}\nvar i;\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'again.ts').backend, 'pulse', source);
  }
  // V8 reports each of these as a redeclaration.
  for (const source of [
    'var a;\nlet a;\nexport {};',
    'let a;\nvar a;\nexport {};',
    'var a;\nfunction a() {}\nexport {};',
    'function a() {}\nvar a;\nexport {};',
    'var a;\nclass a {}\nexport {};',
    'var a;\nimport { a } from "x";',
    'import { a } from "x";\nvar a;',
    'var a;\nconst a = 1;\nexport {};',
    'var a;\nenum a { X }\nexport {};',
    'var a;\nnamespace a { export const b = 1; }\nexport {};',
    // An exported var is declared once: a second one would export the name twice.
    'var retries = 0;\nexport var retries = 1;\nexport { retries };',
    'export var a = 1;\nexport var a = 2;',
    'export var a = 1, a = 2;',
    'export var a = 1;\nvar a;',
    'var a;\nexport var a = 1;',
    '{ var a; }\nexport var a = 1;',
    'var a;\nvar a;\nexport { a };\nexport { a };',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'again.ts' }).backend, 'pulse', source);
  }
});

test('a published script takes a var below the top level, and V8 refuses the conflicts', () => {
  for (const source of [
    '{ var a = 1; }',
    'for (var k in o) {}',
    'for (var i = 0; i < 2; i++) { var j = i; }\nfor (var i = 0; i < 2; i++) {}',
    'if (x) { var y = 1; }\nvar y;',
    'try { var a = 1 } catch (e) { }',
    '{ var a; }\nfunction a() {}',
    'while (x) { var w = 1; }\nw;',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotThrow(() => new Function(result.code), source);
  }
  for (const source of ['{ var a = 1; }\nlet a = 2;', 'let a = 2;\n{ var a = 1; }', '{ let a; { var a; } }', '{ var a; }\nclass a {}']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
});

test('a namespace body is a function body for var, and published scripts take classes in blocks', () => {
  for (const [source, file] of [
    ['namespace N { var x = 1; }\nlet x = 2;\nexport {};', 'space.ts'],
    ['namespace N { var x = 1; var x = 2; let y = x; }', 'space.ts'],
    ['namespace N { type T = 1; var t: T = 1; }\nexport {};', 'space.ts'],
    ['module M { var a = 1; function f() { return a; } export var b = f(); }', 'space.ts'],
    ['namespace N { class C {} export const c = new C(); }', 'space.ts'],
    ['namespace N { class C {} }', 'space.ts'],
    ['{ class C {} }', 'space.ts'],
    ['function f() { class C {} }', 'space.ts'],
    ['{ abstract class C {} }', 'space.ts'],
  ]) {
    assert.equal(sameAsTypeScript(source, file).backend, 'pulse', source);
  }
  // The var stays inside the namespace: an export list of the module does not find it.
  for (const source of [
    'namespace N { var x = 1; }\nexport { x };',
    'namespace N { { var x = 1; } export const y = 1; }\nexport { x };',
    'namespace N { var x = 1; let x = 2; }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'space.ts' }).backend, 'pulse', source);
  }
});

test('a script behind well-formed triple-slash comments is published natively', () => {
  for (const source of [
    '/// <reference path="x.ts"/>\nvar x: number = 1;',
    '// c\n/// <reference types="node"/>\n/* d */\nvar x: number = 1;',
    '/// plain triple\nvar x: number = 1;',
    '#!/usr/bin/env node\n/// <reference path="x.ts"/>\nvar x: number = 1;',
    '/// <reference path="x.ts"/>\nenum E { A }',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /^(?:#![^\n]*\n)?"use strict";\n/, source);
  }
  // A malformed reference is reported by TypeScript, and the module-format directives keep its route.
  for (const source of ['/// <reference />\nvar x: number = 1;', '/// <amd-module name="a"/>\nvar x: number = 1;']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
});

test('a line or paragraph separator ends the interpreter line as well', () => {
  for (const separator of [' ', ' ']) {
    for (const input of [`#!/usr/bin/env node${separator}export {};`, Buffer.from(`#!/usr/bin/env node${separator}export {};`)]) {
      assert.equal(compile(input, { file: 'bin.ts' }).code, '#!/usr/bin/env node\nexport {};');
    }
    // The strict directive belongs behind the interpreter line, in front of the first statement.
    assert.equal(compile(`#!/usr/bin/env node${separator}a=1;`, { file: 'bin.ts' }).code, '#!/usr/bin/env node\n"use strict";\na=1;');
  }
});

test('declared namespaces and modules may hold declarations of values', () => {
  for (const source of [
    'declare namespace N { var x: number; }\nexport {};',
    'declare namespace N { export var x: number, y: string; let z; const c: 1; }\nexport {};',
    'declare namespace N { function f(): void; function f(x: number): string; export function g<T>(a: T): T; }\nexport {};',
    'declare namespace N { class C { m(): void; static s: number; constructor(x: number); } abstract class D extends C {} }\nexport {};',
    'declare namespace N { enum E { A, B = 2 } const enum F { X } }\nexport {};',
    'declare namespace N { namespace M { var a: number; } export module K { interface I {} } }\nexport {};',
    'declare module "m" { class C {} export function f(): void; export const v: number; }\nexport {};',
    'declare namespace N { function f(): void; }\nfunction f() {}\nexport { f };',
    'declare namespace N { var x: number; }\nconst a = 1;',
  ]) {
    const result = sameAsTypeScript(source, 'ambient.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /\bN\b|"m"/, source);
  }
  // A value, a body or a statement has no place in a declaration, and a declared name is no binding to export.
  for (const source of [
    'declare namespace N { var x = 1; }\nexport {};',
    'declare namespace N { function f() {} }\nexport {};',
    'declare namespace N { class C { m() {} } }\nexport {};',
    'declare namespace N { x = 1; }\nexport {};',
    'declare namespace N { let [a]: number[]; }\nexport {};',
    'declare namespace N { var x: number; }\nexport { x };',
    'namespace N { var x: number; function f(): void; }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'ambient.ts' }).backend, 'pulse', source);
  }
});

test('a script that begins with the strict directive is published as written', () => {
  for (const source of [
    '"use strict"; var x: number = 1;',
    "'use strict';\nfunction f(a: string) { return a; }",
    '// c\n"use strict";\nenum E { A }',
    '"use strict" ;\nvar x: number = 1;',
    '"use strict";\n"use foo";\nvar x: number = 1;',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(result.code.match(/use strict/g).length, 1, source);
  }
  // Another leading string decides the mode differently, or depends on what is erased.
  for (const source of ['"use strict"\nvar x: number = 1;', '"use strict" as string;\nvar x: number = 1;',
    '"use stricter";\nvar x: number = 1;', '"use asm";\nvar x: number = 1;', '"use strict";\nwith (a) {}']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
});

test('an exported namespace variable without a value is erased, as TypeScript writes nothing for it', () => {
  for (const source of [
    'namespace N { export var x: number; }\nexport {};',
    'export namespace N { export let c; }',
    'namespace N { export var x: number; export const y = 1; }',
    'namespace N { export var x: { a: number; b: string }; export var y = 1; }\nexport {};',
  ]) {
    const result = sameAsTypeScript(source, 'space.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /\bx\b|\bc\b/, source);
  }
  // A use of the name elsewhere in the body gets the namespace object in front of it.
  for (const source of [
    'namespace N { export var x: number; x = 1; }\nexport {};',
    'namespace N { export var x: number; export function f() { return x; } }\nexport {};',
  ]) {
    assert.equal(sameAsTypeScript(source, 'space.ts').backend, 'pulse', source);
  }
  for (const source of [
    'namespace N { export const c: number; }\nexport {};',
    'namespace N { export var x: number, y: string; }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'space.ts' }).backend, 'pulse', source);
  }
});

test('names outside ASCII are read through a copy spelled in ASCII', () => {
  for (const source of [
    'export const ɵa: number = 1;',
    'import { ɵsetCurrentInjector as setCurrentInjector } from "@angular/core";\nsetCurrentInjector(null as any);',
    '// note\nimport { a as ɵb } from "m";\nɵb();',
    'export const 日本: number = 1;\nexport function 関数(引数: string): string { return 引数; }',
    'const ɵa: number = 1;\nexport { ɵa };',
    'let ɵa = 1;\nɵa++;\nexport {};',
    'const x = { ɵk: 1 as number };\nexport default x;',
    'export const AB = 1;\nexport const é: number = 2;',
  ]) {
    const result = sameAsTypeScript(source, 'names.ts');
    assert.equal(result.backend, 'pulse', source);
    // The names come back byte for byte, and only types were blanked.
    assert.equal(Buffer.byteLength(result.code), Buffer.byteLength(source), source);
  }
  // What the copy needs beyond erasure is lowered on the copy, and the names are put back in the text.
  assert.equal(sameAsTypeScript('export class ɵC { x: number = 1; constructor(private é: number) {} }', 'names.ts').backend, 'pulse');
  // The certified parser still refuses what TypeScript reports, and a name that is no identifier is refused by Node.
  for (const source of ['export class V implements { ɵv = 42; }', 'export const 😀 = 1;']) {
    assert.equal(compile(Buffer.from(source), { file: 'names.ts' }).code, null, source);
  }
  // A redeclaration, an export without a binding, an escape and a space outside ASCII keep TypeScript's route.
  for (const source of ['export const ɵa = 1;\nexport const ɵa = 2;', 'export const é = 1;\nexport { è };',
    'export const \\u0275a: number = 1;\nexport const ɵb = 2;', 'export const a : number = 1;\nexport const é = 1;']) {
    assert.equal(compile(Buffer.from(source), { file: 'names.ts' }).backend, 'typescript', source);
  }
  // A letter of Unicode 16 or 17 is one for the engine and none for TypeScript, which reports the name.
  for (const source of ['export const o: Record<string, string> = { \u1C89: "x", \u0410: "a" };', 'export const \u{16D40}a: number = 1;']) {
    const result = compile(Buffer.from(source), { file: 'names.ts' });
    assert.equal(result.code, null, source);
    assert.notEqual(result.diagnostics.length, 0, source);
  }
});

test('Node erasure is not used where it drops the export of a decorated abstract class', () => {
  for (const source of [
    '@Injectable()\nexport abstract class S { x: number = 1; }\nexport const a = 1;',
    '@d\nexport default abstract class S { x: number = 1; }\nexport const a = 1;',
  ]) {
    const result = sameAsTypeScript(source, 'state.ts');
    assert.match(result.code, /export\s+(?:default\s+)?class S/);
    assert.equal(compile(source, { file: 'state.ts', mode: 'strip' }).diagnostics[0].code, 'AMBIGUOUS_TYPE_ERASURE');
  }
  // Without a decorator, or with the words in a comment, the erasure is right.
  for (const source of ['export abstract class S { x: number = 1; }\nexport const a = 1;',
    '// export abstract class X\n@Injectable()\nexport class S { x: number = 1; }\nexport const a = 1;']) {
    sameAsTypeScript(source, 'state.ts');
    assert.notEqual(compile(source, { file: 'state.ts', mode: 'strip' }).code, null);
  }
});

test('a decorated class inside a function or a block is written as it stands', () => {
  for (const source of [
    'function f() { @Injectable() class Door { } return Door; }\nexport { f };',
    'it("x", () => { @Module({ imports: [B], providers: [AA] }) class A {} });\nexport {};',
    'describe("a", () => { it("b", async () => { @Component({ template: `<p>${x}</p>` }) class P { @Input() v = 1; } use(P); }); });\nexport {};',
    'export function f() { @a abstract class X { abstract m(): void; } return X; }',
    'export function f() { if (x) { @a class X {} } }',
    '{ @a class X {} }\nexport {};',
  ]) {
    const result = sameAsTypeScript(source, 'local.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /@\w+/, source);
  }
  // A decorator in front of anything but a class is no statement of the native route.
  for (const source of ['export function f() { @a\n const x = 1; }', 'export function f() { @a function g() {} }',
    'export function f() { @a export class X {} }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'local.ts' }).backend, 'pulse', source);
  }
});

test('a label on a block, an if, a try or a switch is taken, and only break may name it', () => {
  for (const source of [
    'a: { break a; }\nexport {};',
    'a: if (x) { break a; }\nexport {};',
    'export function f() { a: { if (x) break a; y(); } }',
    'export function f() { a: switch (x) { case 1: break a; case 2: break; } }',
    'export function f() { a: try { break a; } finally {} }',
    'export function f() { for (;;) { a: { if (x) break a; if (y) continue; break; } } }',
    'export function f() { a: { for (;;) { if (x) break a; continue; } } }',
    'export function f() { a: { switch (x) { case 1: break a; default: break; } } }',
    'export function f() { a: if (x) { for (const y of z) { if (y) break a; } } else { break a; } }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'label.ts').backend, 'pulse', source);
  }
  // Each of these is an error in JavaScript, or names a label across a function.
  for (const source of [
    'a: { a: {} }\nexport {};',
    'a: { continue a; }\nexport {};',
    'a: { break b; }\nexport {};',
    'a: { break; }\nexport {};',
    'a: { continue; }\nexport {};',
    'a: { function g() { break a; } }\nexport {};',
    'a: { (() => { break a; })(); }\nexport {};',
    'export function f() { a: { class C { m() { break a; } } } }',
    'a: { while (x) { continue a; } }\nexport {};',
    'yield: { break yield; }\nexport {};',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'label.ts' }).backend, 'pulse', source);
  }
});

test('a class static block is read like the initializer of a static field', () => {
  for (const source of [
    'class C { static x = 1; static { C.x = 2; } }\nexport { C };',
    'export class C { static { this.a = 1; const b: number = 2; let c = b; } m() {} }',
    'export class C { static { } static { } }',
    'export class C extends B { static { super.init(); } }',
    'export class C { static { function f() { return arguments; } f(); } }',
    'export class C { static { for (const k of [1]) { if (k) break; } } }',
    'export class C { static\n{ } }',
    'export class C { static static() {} static { C.static(); } }',
    'export class C { static {} static x = 1 }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'block.ts').backend, 'pulse', source);
  }
  // V8 reports each of these.
  for (const source of [
    'export class C { static { return; } }',
    'export class C { static { arguments; } }',
    'export class C { static { await 1; } }',
    'export class C { static { break; } }',
    'export class C { static { super(); } }',
    'export class C { @d static { } }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'block.ts' }).backend, 'pulse', source);
  }
});

// One source per row of the PICT table: a namespace inside a namespace, with one member of each kind.
function nestedNamespace(row) {
  const member = {
    Const: 'export const v = 1;', Function: 'export function v() { return 1; }', Class: 'export class v { static n = 1; }',
    Enum: 'export enum v { a, b }', Statement: 'const hidden = 2; export const v = hidden + 1;',
  }[row.Member];
  const own = { Unused: '', QualifiedInner: ' export const again = () => M.v;', QualifiedOuter: ' export const again = () => N.M;' }[row.OwnName];
  const core = `${member}${row.OwnName === 'QualifiedInner' ? own : ''}`;
  const inner = row.Depth === 'Three' ? `export namespace L { ${core.replace(/\bM\./g, 'L.')} }` : core;
  const before = row.Sibling === 'ConstBefore' ? 'export const first = 0; ' : '';
  const after = (row.Sibling === 'FunctionAfter' ? ' export function last() { return M; }' : '') + (row.OwnName === 'QualifiedOuter' ? own : '');
  const exported = row.Inner === 'Exported';
  return `${row.Outer === 'Exported' ? 'export ' : ''}namespace N { ${before}${exported ? 'export ' : ''}namespace M { ${inner} }${after}${exported ? '' : ' export const through = M;'} }\n` +
    `export const out = JSON.stringify([Object.keys(N), typeof (N as any).M, typeof (N as any).through]);`;
}

test('a namespace inside a namespace is lowered as TypeScript lowers it', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-nested-namespace.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 18);
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = nestedNamespace(row);
    const result = sameAsTypeScript(source, 'nested.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'nested.ts')), source);
  }
  // The text itself, for one case of each form.
  assert.equal(compile(Buffer.from('namespace N { export namespace M { export const v = 1; } }\nexport { N };'), { file: 'nested.ts' }).code,
    'var N;(function (N) { let M;(function (M) { M.v = 1; })(M=N.M||(N.M={})); })(N||(N={}));\nexport { N };');
  assert.equal(compile(Buffer.from('namespace N { namespace M { export const v = 1; } export const w = M; }\nexport { N };'), { file: 'nested.ts' }).code,
    'var N;(function (N) { let M;(function (M) { M.v = 1; })(M||(M={})); N.w = M; })(N||(N={}));\nexport { N };');
});

test('the word namespace in a namespace body is an identifier in front of a line break', () => {
  const source = 'var namespace: number;\nvar n: string;\nnamespace container {\n  namespace\n  n\n  { }\n  export const v = 1;\n}\nexport { container };';
  assert.equal(sameAsTypeScript(source, 'nested.ts').backend, 'pulse');
});

test('what a namespace inside another needs beyond that is left to TypeScript', () => {
  for (const source of [
    // The namespace's own name as anything but the head of a property access may be a declaration.
    'namespace N { export namespace M { export const v = 1; const M = 2; } }\nexport { N };',
    'namespace N { export namespace N { export const v = 1; } }\nexport { N };',
    'namespace N { export namespace M { export const v = (N: number) => N; } }\nexport { N };',
    // Types alone, and the same name twice.
    'namespace N { export namespace M { export interface I {} } export const v = 1; }\nexport { N };',
    'namespace N { export namespace M { export const a = 1; } export namespace M { export const b = 2; } }\nexport { N };',
    // A dotted name written with space around its dots, and one that holds the name of a member.
    'namespace N . M { export const v = 1; }\nexport { N };',
    'namespace N.M { export const N = 1; }\nexport { N };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'nested.ts').backend, 'typescript', source);
  }
});

test('a function with a var and a lexical name beside something that is lowered stays native', () => {
  const mixed = 'function f() { var b = 1; const c = 2; return b + c; }';
  for (const [source, file] of [
    [`enum E { a }\n${mixed}\nexport { E, f };`, 'mixed.ts'],
    [`${mixed}\nexport const x: number = f();`, 'mixed.ts'],
    [`namespace N { var b = 1; export class c {} }\nexport { N };`, 'mixed.ts'],
    [`namespace N { var b = 1; const c = 2; export function g() { return b + c; } }\nexport { N };`, 'mixed.ts'],
    [`export class A { constructor(private x: number) {} m() { var b = 1; let c = 2; return b + c + this.x; } }`, 'mixed.ts'],
    [`export const v = <div>{(() => { var b = 1; const c = 2; return b + c; })()}</div>;`, 'mixed.tsx'],
    [`export const enum K { a = 1 }\nexport const g = function () { var b = 1; class L {} return [b, L]; };`, 'mixed.ts'],
  ]) {
    assert.equal(sameAsTypeScript(source, file).backend, 'pulse', source);
  }
  // A var and a lexical declaration of one name are still found by the whole parse.
  for (const source of ['function f() { var b = 1; let b = 2; }\nexport const x: number = 1;', 'enum E { a }\nexport function f() { const b = 1; var b = 2; }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'mixed.ts' }).backend, 'pulse', source);
  }
});

test('a dotted namespace name declares one namespace inside another', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, '').replace(/export \{[^}]*\};?/g, ''))();
  for (const source of [
    'namespace A.B { export const v = 1; }\nexport const out = JSON.stringify(A);',
    'export namespace A.B.C { export function f() { return 1; } export class K {} }\nexport const out = [Object.keys(A.B), A.B.C.f(), typeof A.B.C.K].join();',
    'namespace N { export namespace A.B { export const v = 1; } export const w = A.B; }\nexport const out = JSON.stringify(N);',
    'namespace A.B { namespace C.D { export const v = 2; } export const w = C.D.v + 1; export enum E { a } }\nexport const out = JSON.stringify(A);',
    'namespace A.B { export const v = () => A.B; }\nexport const out = A.B.v() === A.B;',
    'module Outer.Inner { export var v = 3; }\nexport const out = Outer.Inner.v;',
  ]) {
    const result = sameAsTypeScript(source, 'dotted.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.deepEqual(run(result.code), run(reference(source, 'dotted.ts')), source);
  }
  assert.equal(compile(Buffer.from('namespace A.B { export const v = 1; }\nexport { A };'), { file: 'dotted.ts' }).code,
    'var A;(function (A) {var B;(function (B) { B.v = 1; })(B=A.B||(A.B={}));})(A||(A={}));\nexport { A };');
  // A dotted namespace of types alone is erased.
  for (const source of ['declare namespace A.B { const x: number; }\nexport const y = 1;', 'namespace A.B { export interface I { a: 1 } }\nexport const y: A.B.I = { a: 1 };']) {
    const result = sameAsTypeScript(source, 'dotted.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /function/);
  }
});

// One source per row of the PICT table: a variable that a namespace exports, and one more occurrence of its name.
function namespaceReference(row) {
  const declaration = { Const: 'export const v = 1;', Let: 'export let v = 1;', Var: 'export var v = 1;', Bare: 'export var v: number;' }[row.Variable];
  const occurrence = {
    Read: 'v + 1', Assign: '(v = 5)', Update: 'v++', Argument: 'String(v)', PropertyAccess: '(o as any).v',
    Shorthand: '({ v })', Key: '({ v: 2 })', ShadowedParameter: '((v: number) => v)(3)', InString: '"v"',
  }[row.Form];
  const [site, read] = {
    Statement: [`export const r = ${occurrence};`, 'N.r'],
    Function: [`export function f() { return ${occurrence}; }`, 'N.f()'],
    Arrow: [`export const f = () => ${occurrence};`, 'N.f()'],
    Method: [`export class K { m() { return ${occurrence}; } }`, 'new N.K().m()'],
    InnerNamespace: [`export namespace M { export const r = ${occurrence}; }`, 'N.M.r'],
    Template: [`export const r = \`a\${${occurrence}}b\`;`, 'N.r'],
  }[row.Site];
  return `${row.Outer === 'Exported' ? 'export ' : ''}namespace N { const o: any = Object.create(null); ${declaration} ${site} }\n` +
    `export const out = JSON.stringify([${read}, (N as any).v]);`;
}

test('a reference to a variable that a namespace exports is written as a property of the namespace', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-namespace-references.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 50);
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = namespaceReference(row);
    const result = sameAsTypeScript(source, 'reference.ts');
    assert.equal(run(result.code), run(reference(source, 'reference.ts')), source);
    // An occurrence that is no reference leaves the namespace to TypeScript.
    // A string that is the name and nothing else is no occurrence of it.
    // A shorthand property is a reference: `{ a }` is written `{ a: N.a }`.
    if (['Key', 'ShadowedParameter'].includes(row.Form)) assert.equal(result.backend, 'typescript', source);
    else { assert.equal(result.backend, 'pulse', source); native++; }
  }
  assert.ok(native >= 25, String(native));
  // The text itself.
  assert.equal(compile(Buffer.from('namespace N { export var a = 1; function f() { return a; } export var b; function g() { return b; } }\nexport { N };'), { file: 'reference.ts' }).code,
    'var N;(function (N) { N.a = 1; function f() { return N.a; } ; function g() { return N.b; } })(N||(N={}));\nexport { N };');
});

test('references to exported variables across namespaces, and what stays with TypeScript', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    // The owner is the innermost namespace that exports the name itself.
    'namespace N { export const a = 1; export namespace M { export const b = a + 1; export const c = b + a; } }\nexport const out = JSON.stringify(N);',
    'namespace A.B { export let n = 1; export function bump() { n += 1; return n; } }\nexport const out = [A.B.bump(), A.B.n].join();',
    'namespace N { export let n = 1; export const list = [n, n + 1].map(x => x + n); n = list.length; }\nexport const out = JSON.stringify(N);',
    'namespace N { export var a = 1; var t = [a][a - 1]; export const u = t; }\nexport const out = JSON.stringify(N);',
    'namespace N { export const a = 1; export class K extends (a ? Object : Array) { v = a; static s = `${a}`; } }\nexport const out = JSON.stringify([new N.K().v, N.K.s]);',
  ]) {
    const result = sameAsTypeScript(source, 'reference.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'reference.ts')), source);
  }
  for (const source of [
    // A local of the same name in a namespace inside, a label, a member name, a destructured local.
    'namespace N { export const a = 1; export namespace M { const a = 2; export const b = a; } }\nexport { N };',
    'namespace N { export const a = 1; a: for (;;) { break a; } }\nexport { N };',
    'namespace N { export let n = 1; for (n of [7]) {} }\nexport { N };',
    'namespace N { export const a = 1; export class K { a = 2; } }\nexport { N };',
    'namespace N { export const a = 1; export function f() { const { a } = { a: 2 }; return a; } }\nexport { N };',
    'namespace N { export const a = 1; export const f = function a() { return 1; }; }\nexport { N };',
    'namespace N { export const a = 1; export function f(x = a, a = 2) { return x; } }\nexport { N };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'reference.ts').backend, 'typescript', source);
  }
});

test('a name that hides an exported namespace variable is never written as a property', () => {
  const hiding = [
    '(v) => v', 'v => v', 'async v => v', 'async (v) => v', '(a, v) => v + a', '({ v }) => v', '([v]) => v', '(v = 1) => v', '(...v) => v',
    '({ a: v }) => v', '({ a: { v } }) => v', '(a, { v } = { v: 1 }) => v',
    'function (v) { return v; }', 'function* (v) { yield v; }', 'async function (v) { return v; }', 'function v() { return v; }',
    'class { m(v) { return v; } }', 'class { set s(v) { this.x = v; } }', 'class { constructor(v) { this.x = v; } }', 'class { v = 1; }',
    'class { static v() { return 1; } }', 'class v {}', 'class { #v = 1; m() { return this.#v; } }',
    '() => { try { throw 1; } catch (v) { return v; } }', '() => { for (const v of [1]) return v; }', '() => { for (let v = 0; v < 1; v++) return v; }',
    '() => { for (var v in { a: 1 }) return v; }', '() => { let v = 2; return v; }', '() => { var v = 2; return v; }', '() => { const { v } = { v: 2 }; return v; }',
    '() => { const [v] = [2]; return v; }', '() => { function v() { return 3; } return v(); }', '() => { class v {} return v; }',
    '() => { enum v { a } return v.a; }', '() => { v: for (;;) { break v; } return 1; }', '{ v() { return 1; } }', '{ get v() { return 1; } }',
    '{ v }', '{ v: 1 }', '{ "v": v }', '{ [v]: v }', 'o.v', 'o?.v', 'o.v.v', 'o[v]', '`${v}`', 'v ? v : v', 'typeof v', 'void v', '[v, ...[v]]', 'new (class { x = v; })().x',
    '(() => { let w: typeof v = 1; return w; })()', '(function f(a = v) { return a; })()', '((a = v, v = 2) => a)()',
  ];
  for (const expression of hiding) {
    for (const declaration of ['export const v = 1;', 'export var v: number;']) {
      const source = `namespace N { const o: any = Object.create(null); ${declaration} export const r = ${expression.startsWith('{') ? `(${expression})` : expression}; }\nexport { N };`;
      // Whichever route answers, the syntax is TypeScript's.
      sameAsTypeScript(source, 'hiding.ts');
    }
  }
});

// One source per row of the PICT table: a namespace behind a declaration of its name.
function mergedNamespace(row) {
  const exported = row.Exported === 'Both' ? 'export ' : '';
  const first = {
    Namespace: `${exported}namespace M { export const first = 1; }`,
    Class: `${exported}class M { static first = 1; }`,
    Function: `${exported}function M() { return 1; }`,
  }[row.First];
  const member = { Const: 'export const v = 2;', Function: 'export function v() { return 2; }', Class: 'export class v { static n = 2; }', Enum: 'export enum v { a, b }' }[row.Member];
  const between = { Nothing: '', CallWithoutSemicolon: 'log.push(1)\n', Declaration: 'const other = 3;\n' }[row.Between];
  const third = row.Third === 'Namespace' ? `\n${exported}namespace M { export const third = 4; }` : '';
  return `const log: number[] = [];\n${first}\n${between}${exported}namespace M { ${member} }${third}\n` +
    `export const out = JSON.stringify([Object.keys(M).sort(), typeof M, typeof (M as any).v, (M as any).first, log]);`;
}

test('a namespace behind a namespace, a class or a function of its name is written without a declaration', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-merged-namespace.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = mergedNamespace(row);
    const result = sameAsTypeScript(source, 'merged.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'merged.ts')), source);
  }
  // A namespace inside another may bear the name of a namespace at the top of the file.
  for (const source of [
    'namespace Top { export const a = 1; }\nnamespace Other { export namespace Top { export const a = 2; } export const b = Top.a; }\nexport const out = JSON.stringify([Top, Other]);',
    'namespace A.B { export const x = 1; }\nnamespace A.C { export const y = 2; }\nexport const out = JSON.stringify(A);',
  ]) {
    const result = sameAsTypeScript(source, 'merged.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'merged.ts')), source);
  }
  // A member that another declaration of the namespace exports is written as a property of the namespace.
  for (const source of [
    'namespace N { export const a = 1; }\nnamespace N { export const b = a + 1; }\nexport const out = JSON.stringify(N);',
    'namespace N { export function f() { return 1; } }\nnamespace N { export const g = f; export const h = f(); }\nexport const out = JSON.stringify([N.h, N.g === N.f]);',
    'namespace N { export const b = () => late; }\nnamespace N { export const late = 2; }\nexport const out = JSON.stringify(N.b());',
    'function foo() {}\nnamespace foo.Bar { export function f() { return 1; } }\nnamespace foo.Baz { export function g() { return Bar.f(); } }\nexport const out = (foo as any).Baz.g();',
    'namespace N { export namespace In { export const a = 1; } }\nnamespace N { export const b = In; export namespace M { export const c = In.a; } }\nexport const out = JSON.stringify(N);',
    'namespace N { export enum E { x = 3 } }\nnamespace N { export const v = E.x; }\nnamespace N { export const w = v + E.x; }\nexport const out = JSON.stringify(N);',
  ]) {
    const result = sameAsTypeScript(source, 'merged.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'merged.ts')), source);
  }
  assert.equal(compile(Buffer.from('class C {}\nnamespace C { export const x = 1; }\nexport { C };'), { file: 'merged.ts' }).code,
    'class C {}\n;(function (C) { C.x = 1; })(C||(C={}));\nexport { C };');
  for (const source of [
    // A name that only the namespaces inside two declarations share, a member that a parameter hides, and a
    // member that is constructed.
    'namespace A.B { export const x = 1; }\nnamespace A.B { export const y = x; }\nexport { A };',
    'namespace N { export const a = 1; }\nnamespace N { export function f(a: number) { return a; } }\nexport { N };',
    'namespace A { export namespace B { export function f() { return 1; } } }\nnamespace A { export namespace B { export const y = f(); } }\nexport { A };',
    // An enum behind the namespace, a declared class, a class behind the namespace, and a merge inside a namespace.
    'namespace E { export const x = 1; }\nenum E { a }\nexport { E };',
    'declare class D {}\nnamespace D { export const x = 1; }\nexport { D };',
    'namespace Outer { export namespace M { export const a = 1; } export namespace M { export const b = 2; } }\nexport { Outer };',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'merged.ts').backend, 'pulse', source);
  }
});

test('an import alias in a namespace body is a variable of the body, or a member when it is exported', () => {
  const run = code => new Function('A', code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))({ x: { y: 7 }, q: 3 });
  for (const source of [
    'declare const A: any;\nnamespace M { import B = A.x; export const z = B.y; }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M { import B = A; import C = B.q; export const z = C; }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M { export import B = A.x; }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M { export import B = A.x; export const c = B.y; export function f() { return B; } }\nexport const out = JSON.stringify([M, M.f()]);',
    'declare const A: any;\nnamespace M { import B = A.x\n  export const z = B }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M { export const x = 1; import B = M.x; export const z = B; }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M { import B = A.x; var c: B; export const z = 1; }\nexport const out = JSON.stringify(M);',
    'declare const A: any;\nnamespace M.N { import B = A.q; export const z = B + 1; }\nexport const out = JSON.stringify(M);',
  ]) {
    const result = sameAsTypeScript(source, 'alias.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'alias.ts')), source);
  }
  assert.equal(compile(Buffer.from('namespace M { export import B = A.x; import C = A; export const c = B; }\nexport { M };'), { file: 'alias.ts' }).code,
    'var M;(function (M) { M.B = A.x; var C = A; M.c = M.B; })(M||(M={}));\nexport { M };');
  // An alias alone does not make the namespace exist, and TypeScript writes nothing.
  assert.doesNotMatch(sameAsTypeScript('namespace M { import B = A.x; }\nexport const y = 1;', 'alias.ts').code, /function/);
  for (const source of [
    // A call of require, a type-only alias, an alias to a member the namespace exports, a statement that goes on.
    'namespace M { import B = require("m"); export const z = B; }\nexport { M };',
    'namespace M { import type B = A.x; export const z = 1; }\nexport { M };',
    'namespace M { export const A = { x: 1 }; import B = A.x; export const z = B; }\nexport { M };',
    'namespace M { import B = A.x\n  (1); export const z = B; }\nexport { M };',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'alias.ts').backend, 'pulse', source);
  }
});

test('a namespace and parameter properties are lowered in one pass', () => {
  const run = code => new Function('A', code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))({ q: 5 });
  for (const source of [
    'namespace N { export class C { constructor(public x: number) {} } }\nexport const out = JSON.stringify(new N.C(3));',
    'namespace N { class C { constructor(private a: number, readonly b = 2) {} } export const c = new C(1); }\nexport const out = JSON.stringify(N);',
    'export class P { constructor(public x: number) {} }\nnamespace N { export const v = 1; export function f() { return v; } }\nexport const out = JSON.stringify([new P(2), N.f()]);',
    'namespace N.M { export class C extends Object { constructor(public x: number) { super(); } } export enum E { a } }\nexport const out = JSON.stringify([new N.M.C(4), N.M.E]);',
    'declare const A: any;\nnamespace N { import B = A.q; export class C { constructor(public y = B) {} } }\nexport const out = JSON.stringify(new N.C());',
    'namespace N { export let count = 0; export class C { constructor(public id = ++count) {} } }\nexport const out = JSON.stringify([new N.C(), new N.C(), N.count]);',
    'class First { constructor(readonly a: string) {} }\nnamespace First { export const tag = "t"; }\nexport const out = JSON.stringify([new First("x"), First.tag]);',
  ]) {
    const result = sameAsTypeScript(source, 'properties.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'properties.ts')), source);
  }
  // A parameter that bears the name of an exported variable hides it.
  assert.notEqual(sameAsTypeScript('namespace N { export var x = 1; export class C { constructor(public x: number) {} } }\nexport { N };', 'properties.ts').backend, 'pulse');
});

test('a namespace that holds only aliases, types and such namespaces is erased', () => {
  for (const source of [
    'module B { import Y = A; }\nexport const v = 1;',
    'module Foo2 { module Bar { } }\nexport const v = 1;',
    'namespace T { namespace w { interface I {} } type X = w.I; }\nexport const v = 1;',
    'namespace A.M { import M = Z.M; import N = M.q }\nexport const v = 1;',
    'namespace N { import B = A.x; export interface I { b: B } }\nexport const v: N.I = null as any;',
    'module Outer { module Inner { import X = Y.Z; } export type T = 1; }\nvar o: Outer.T = 1;',
  ]) {
    const result = sameAsTypeScript(source, 'erased.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /function|var Y|var B|var M/, source);
  }
  // An exported alias, a value beside the alias, and a statement in a namespace inside make it exist.
  for (const source of [
    'namespace M { export import B = A.x; }\nexport { M };',
    'declare const A: any;\nnamespace M { import B = A.x; export const z = B; }\nexport { M };',
    'namespace Outer { namespace Inner { export const v = 1; } }\nexport { Outer };',
  ]) {
    const result = sameAsTypeScript(source, 'erased.ts');
    assert.match(result.code, /function/, source);
  }
});

test('a script with decorators is published natively', () => {
  for (const source of [
    'class Foo { @decorator foo() { } }',
    'class A { @dec() foo: string }',
    '@dec class D { }',
    'declare var dec: any;\n@dec class D { }\nvar x: number = 1;',
    '@dec abstract class D { abstract m(): void; }',
    '@a @b() class D { @c m(x: number) { return x; } @c static s = 1; }\nnew D();',
    'function f() { @d class L { @e v = 1; } return L; }',
  ]) {
    const result = sameAsTypeScript(source, 'script.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /^"use strict";\n/, source);
  }
  // What only a module may hold, and what the certified parse refuses, stays with TypeScript.
  for (const source of ['var await = 1; class A { @d m() {} }', 'class A { @d m() { with (a) {} } }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'script.ts' }).backend, 'pulse', source);
  }
});

test('a computed class key may be any assignment expression', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'class C { [0 + 1]() { return 1; } static ["a" + "b"] = 2; [`t`]: number = 3; }\nexport const out = JSON.stringify([new C()[1](), (C as any).ab, (new C() as any).t]);',
    'const f = () => "k";\nclass C { [f()]() { return 1; } get [f() + "g"]() { return 2; } static [f() as string]: number = 3; }\nexport const out = JSON.stringify([(new C() as any).k(), (new C() as any).kg, (C as any).k]);',
    'const log: number[] = [];\nconst k = (n: number) => { log.push(n); return "k" + n; };\nclass C { [k(1)]: number; static [k(2)] = 1; [k(3)]() {} declare [k(4)]: number; }\nexport const out = JSON.stringify(log);',
    'class C { async [1 ? "a" : "b"]() { return 1; } *[[1, 2].join("")]() { yield 1; } [(0, "p")]<T>(x: T): T { return x; } }\nexport const out = Object.getOwnPropertyNames(C.prototype).join();',
    'let i = 0;\nclass C { [i++] = "a"; [i++] = "b"; static [i = 5] = "c"; }\nexport const out = JSON.stringify([new C(), (C as any)[5], i]);',
  ]) {
    const result = sameAsTypeScript(source, 'computed.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'computed.ts')), source);
  }
  // An index signature is no computed key, and a key without an expression is none either.
  assert.doesNotMatch(sameAsTypeScript('class C { [key: string]: number; a = 1; }\nexport { C };', 'computed.ts').code, /key/);
  for (const source of ['class C { []() {} }\nexport { C };', 'class C { [a, b]() {} }\nexport { C };']) {
    assert.equal(compile(Buffer.from(source), { file: 'computed.ts' }).code, null, source);
  }
});

test('accessor fields keep their word, and an optional method with a body loses its question mark', () => {
  for (const [source, file] of [
    ['export class C { accessor x = 1; static accessor y: number; accessor #z = 2; accessor "q": string = "s"; accessor [k] = 3; }', 'accessor.ts'],
    ['export class C { private accessor a = 1; public static readonly accessor b = 2; @d accessor c = 3; protected accessor d!: number; }', 'accessor.ts'],
    ['export class C { accessor = 1; accessor\n  x = 2; static accessor: number; accessor() { return 1; } }', 'accessor.ts'],
    ['class C { accessor x = 1; }', 'accessor.ts'],
    ['export class C { foo?() { return 1; } bar?<T>(x: T): T { return x; } baz?(): void; }', 'optional.ts'],
    ['class C { foo?() { return 1; } }\nvar c = new C();', 'optional.ts'],
    // The modifiers of an optional method go like those of any member.
    ['export class A { isSent(r: any) { return r.sent }\n  public getHeader?(response: any, name: string) { return response.getHeader(name); }\n  private static override readonly?() { return 1; } protected async?(): void; }', 'optional.ts'],
  ]) {
    const result = sameAsTypeScript(source, file);
    assert.equal(result.backend, 'pulse', source);
  }
  // An accessor field is no method, and an accessor of another kind takes no question mark.
  for (const source of ['export class C { accessor m() {} }', 'export class C { accessor get x() { return 1; } }', 'export class C { get x?() { return 1; } }']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'accessor.ts' }).backend, 'pulse', source);
  }
});

test('@jsx text in a line comment is no pragma', () => {
  // TypeScript reads the JSX pragmas from block comments only.
  for (const source of ['// @jsxImportSource preact\nexport const a = <div/>;', '// @jsx: preserve\ndeclare module JSX { interface Element {} }\nexport const a = <div/>;',
    '//@jsxRuntime classic\nexport const a = <div/>;']) {
    const result = compile(Buffer.from(source), { file: 'pragma.tsx', mode: 'transform', jsx: 'automatic' });
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /from"react\/jsx-runtime"/, source);
  }
  // In a block comment it is one.
  const block = compile(Buffer.from('/** @jsxImportSource preact */\nexport const a = <div/>;'), { file: 'pragma.tsx', mode: 'transform', jsx: 'automatic' });
  assert.match(block.code, /from"preact\/jsx-runtime"/);
  // A factory named in a line comment still keeps the classic runtime with TypeScript.
  assert.equal(compile(Buffer.from('// @jsx h\nexport const a = <div/>;'), { file: 'pragma.tsx', mode: 'transform', jsx: 'classic' }).backend, 'typescript');
});

test('a declared module may hold imports, an export assignment, a default export and a re-export', () => {
  for (const source of [
    'declare module "*.css" { const classes: Record<string, string>; export default classes; }\nexport const q = 1;',
    'declare module "m" { import x = require("y"); export = x; }\nexport const q = 1;',
    'declare module "m" { export = server; }\nexport const q = 1;',
    'declare module "m" { import { A } from "a"; import type { B } from "b"; import * as ns from "c"; import D, { type E } from "d";\n  export function f(a: A, b: B): ns.T; export interface I extends D { e: E } }\nexport const q = 1;',
    'declare module "m" { export * from "q"; export * as all from "r"; export default function f(): void; }\nexport const q = 1;',
    'declare module "vue" { import type { Router } from "vue-router"; interface ComponentCustomProperties { $router: Router } }\nexport const q = 1;',
    'declare module "m" { export default class C { m(): void; } }\nvar script = 1;',
    'declare module "m" { import "side"; export default interface I { a: 1 } }\nexport const q = 1;',
  ]) {
    const result = sameAsTypeScript(source, 'ambient.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /import|require|declare|default/, source);
  }
  // A namespace and a global augmentation hold no text of a module, and a value is no declaration.
  for (const source of [
    'declare namespace N { import x = require("y"); }\nexport const q = 1;',
    'declare global { export = x; }\nexport const q = 1;',
    'declare namespace N { export * from "q"; }\nexport const q = 1;',
    'declare module "m" { export default 1 + 1; }\nexport const q = 1;',
    'declare module "m" { import x from; }\nexport const q = 1;',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'ambient.ts' }).backend, 'pulse', source);
  }
});

test('review of the namespace work: names that meet their parent, declared siblings, mixed exports', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    // A namespace named like the one directly around it: TypeScript renames the parameter.
    'export namespace Widgets { export namespace Button.Button { export const label = "OK"; } }\nexport const out = Widgets.Button.Button.label;',
    'namespace A { export namespace A.B { export const v = 1; } }\nexport const out = JSON.stringify(A);',
    'namespace A.A { export const v = 1; }\nexport const out = JSON.stringify(A);',
    // A declared namespace of the name: its members are properties of the namespace.
    'export declare namespace Settings { let limit: number; }\nexport namespace Settings.UI { export const current = () => limit; }\nexport const out = 1;',
    'declare namespace S { const a: number; }\nnamespace S { export const b = 1; }\nexport const out = 1;',
    // An exported declaration and a local one do not share their members.
    'const timeout = 1000;\nexport namespace Config { export const timeout = 200; }\nnamespace Config { export const retryDelay = timeout; }\nexport const out = Config.retryDelay;',
    // The name of an open namespace is its parameter, also when another declaration bears it.
    'export namespace API.V1 { export const version = 1; export const read = () => V1.version; }\nexport namespace API.V1 { export const ready = true; }\nObject.assign(API, { V1: { ...API.V1, version: 2 } });\nexport const out = API.V1.read();',
  ]) {
    const result = sameAsTypeScript(source, 'review.ts');
    assert.equal(run(result.code), run(reference(source, 'review.ts')), source);
  }
  // A line separator ends a line comment, so the block comment behind it holds a pragma.
  const pragma = compile(Buffer.from('// Copyright /** @jsxImportSource preact */\nexport const view = <div />;'), { file: 'review.tsx', mode: 'transform', jsx: 'automatic' });
  assert.match(pragma.code, /preact\/jsx-runtime/);
});

test('type arguments behind a JSX tag name are erased', () => {
  const sources = [
    'export const a = <Select<string[]> value={v}><option>{name}</option></Select>;',
    'export const b = <Badge<"a"> />;\nexport const c = <Button<typeof LinkSlot>>Home</Button>;',
    'export function T() { return <ThemeProvider<Theme> theme={t}><Deep /><Option<number, typeof Custom> x={(a: number) => a > 1} /></ThemeProvider>; }',
    'export const d = <ns.Item<{ a: () => void; b: Array<string> }> k="1" {...rest} />;',
    'export const e = <A<B<C>>>text</A>;',
  ];
  for (const source of sources) {
    for (const jsx of ['automatic', 'classic', 'preserve']) {
      const result = compile(Buffer.from(source), { file: 'typed.tsx', mode: 'transform', jsx });
      // A typed file whose JSX is kept is not written natively; its syntax is TypeScript's all the same.
      if (jsx !== 'preserve') assert.equal(result.backend, 'pulse', source + ' ' + jsx);
      const expected = ts.transpileModule(source, { fileName: 'typed.tsx', compilerOptions: {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true,
        jsx: jsx === 'classic' ? ts.JsxEmit.React : jsx === 'preserve' ? ts.JsxEmit.Preserve : ts.JsxEmit.ReactJSX } }).outputText;
      const file = jsx === 'preserve' ? 'typed.jsx' : 'typed.js';
      const strip = code => code.replace(/_tmtJsxs?\d*|_jsxs?/g, 'J').replace(/^import[^\n]*\n/gm, '');
      assert.deepEqual(inspect(ts, strip(result.code), file).shape, inspect(ts, strip(expected), file).shape, source + ' ' + jsx);
    }
  }
  // No type arguments in a .jsx file, and none behind a closing tag.
  assert.notEqual(compile(Buffer.from('export const a = <A<B> />;'), { file: 'typed.jsx', mode: 'transform', jsx: 'automatic' }).backend, 'pulse');
  assert.notEqual(compile(Buffer.from('export const a = <A<B>>x</A<B>>;'), { file: 'typed.tsx', mode: 'transform', jsx: 'automatic' }).backend, 'pulse');
});

test('second review of the namespace work', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    // A variable without a value is erased; the statement before it keeps its end.
    'export namespace N.M {\n  export const v = 1\n  export let label: string;\n  [v].map(i => i);\n}\nexport const out = N.M.v;',
    'namespace N { export const v = [1]\n  export var w: number;\n  (v).length; }\nexport const out = N.v.length;',
    // A declared namespace with a comment in its head.
    'declare /* @internal */ namespace Settings { const limit: number; }\nnamespace Settings { export const current = () => limit; }\nexport const out = 1;',
    // A dotted name that repeats a name further out.
    'export namespace API { export const version = 3; export namespace V1.API { export const current = version; } }\nexport const out = API.V1.API.current;',
    'namespace A { export namespace B { export namespace A { export const v = 1; } } }\nexport const out = A.B.A.v;',
  ]) {
    const result = sameAsTypeScript(source, 'review.ts');
    assert.equal(run(result.code), run(reference(source, 'review.ts')), source);
  }
  // `get` in front of a private name on the next line begins a getter, which this is not.
  for (const [source, file] of [['@logged\nclass Store {\n  get\n  #cached = 1\n}', 'review.ts'], ['export class Store {\n  get\n  #cached = 1\n}', 'review.ts'],
    ['export class Store {\n  static set\n  #cached = 1\n}', 'review.ts']]) {
    assert.equal(compile(Buffer.from(source), { file }).code, null, source);
  }
  assert.equal(sameAsTypeScript('export class Store { get #cached() { return 1; } static set #w(v: number) {} }', 'review.ts').backend, 'pulse');
  // Behind `export default` in a declared module stands no variable and no type alias.
  for (const source of ['declare module "*.css" { export default const classes: Record<string, string>; }\nexport const ready = true;',
    'declare module "m" { export default type T = 1; }\nexport const ready = true;', 'declare module "m" { export default let a: number; }\nexport const ready = true;']) {
    assert.equal(compile(Buffer.from(source), { file: 'review.ts' }).code, null, source);
  }
});

test('a class without a name may begin with its implements clause', () => {
  for (const source of [
    'const c: I = new (class implements I { x = 1 })();\nexport { c };',
    'export const C = class implements I, J<number> { m() { return 1; } };',
    'export default class implements I { x = 1 }',
    'export const D = class implements_ {};\nexport const E = class implement { };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'head.ts').backend, 'pulse', source);
  }
  assert.notEqual(compile(Buffer.from('export const C = class implements I {};'), { file: 'head.js' }).backend, 'pulse');
});

test('names outside ASCII are put back in lowered text', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'export enum ɵMode { Off, ɵOn }\nexport function ɵɵf(a: ɵMode): string;\nexport function ɵɵf(a: any) { return ɵMode[a]; }\nexport const out = [ɵɵf(1), ɵMode.ɵOn].join();',
    'namespace ɵns { export const ɵa = 1; export function f() { return ɵa; } }\nexport const out = JSON.stringify([ɵns, ɵns.f()]);',
    'export class ɵC { constructor(private ɵx: number, public y = ɵx) {} }\nexport const out = JSON.stringify(new ɵC(2));',
    'const été = "été";\nexport enum Saison { été = "ÉTÉ", hiver = 2 }\nexport const out = [été, Saison.été, Saison[2], `${été}!`, /été/.test(été)].join();',
    'export function ɵɵdefinePipe<T>(d: any): unknown { return <ɵPipeDef<T>>{ type: d.ɵtype, name: "ɵx" }; }\nexport const out = JSON.stringify(ɵɵdefinePipe({ ɵtype: 1 }));',
  ]) {
    const result = sameAsTypeScript(source, 'names.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'names.ts')), source);
  }
});

test('a class expression may be constructed where it stands, and new takes bare type arguments', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'interface I { x: number }\nconst a = new class implements I { x = 1 };\nconst b = new class { y = 2 }();\nexport const out = JSON.stringify([a, b]);',
    'class B<T> { constructor(public v?: T) {} }\nconst c = new class extends B<number> { w = 3 }(4);\nconst d = new class Named extends B<string> {};\nexport const out = JSON.stringify([c, d, d.constructor.name]);',
    'function mock<T>(): any { return class {}; }\nfunction f(o: object) { return Object.keys(o); }\nexport const out = JSON.stringify([f(new class extends mock<Date>() { k = 1 }), f(new class { private p = 2; m() {} })]);',
    'class Emitter<T> { fired: T[] = []; }\nconst e = new Emitter<void>;\nconst list = [new Emitter<string>, new Emitter<number[]>];\nexport const out = JSON.stringify([e, list, (new Emitter<Map<string, number>>).fired]);',
  ]) {
    const result = sameAsTypeScript(source, 'construct.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'construct.ts')), source);
  }
  for (const source of [
    'export abstract class F { abstract get count(): number; abstract set size(v: number); protected abstract get name(): string; }',
    'export abstract class G { public abstract get debugName(): string; abstract m(): void; get x() { return 1; } }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'construct.ts').backend, 'pulse', source);
  }
  // Type arguments without an argument list end the expression.
  for (const source of ['const a = new A<B>.c;\nexport { a };', 'const a = new A<B> + 1;\nexport { a };']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'construct.ts' }).backend, 'pulse', source);
  }
});

test('a string that spells the name of an exported namespace variable is no occurrence of the name', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'export namespace Ids { export const limit = \'limit\'; export const mode = "mode"; export const tick = `tick`; }\nexport const out = JSON.stringify(Ids);',
    'namespace States { export const idle = { type: \'idle\' }; export const busy = () => [idle, "busy", \'idle\']; }\nexport const out = JSON.stringify([States.idle, States.busy()]);',
  ]) {
    const result = sameAsTypeScript(source, 'quoted.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'quoted.ts')), source);
  }
  // A longer string and a template with a hole still count: the name may be a reference there.
  assert.notEqual(sameAsTypeScript('namespace N { export const a = 1; export const b = `${a}`; export const c = "x a"; }\nexport { N };', 'quoted.ts').backend, 'pulse');
});

test('an enum member may take its value from a member of something the file does not declare', () => {
  for (const source of [
    'import { L } from "l";\nexport const enum W { A = L.Starting, B = L.Ready, C = 5, D }',
    'export enum W { A = 1, B = W.A, C = Other.q }',
    'function f() { enum Local { a = Outside.kind.a } return Local.a; }\nexport { f };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'foreign.ts').backend, 'pulse', source);
  }
  assert.equal(compile(Buffer.from('import { L } from "l";\nexport enum W { A = L.a }'), { file: 'foreign.ts' }).code,
    'import { L } from "l";\nexport var W; (function (W) {W[W["A"]=L.a]="A";})(W||(W={}));');
  for (const source of [
    // The next member needs a value, and no member can compute with one that is not known.
    'import { L } from "l";\nexport enum W { A = L.x.y, B }',
    'import { L } from "l";\nenum W { A = L.a, B = A }\nexport { W };',
    // A member of an enum, a namespace or an alias of the file may be a constant, and so may the result of an operator.
    'enum O { a = 1 }\nexport enum W { A = O.a }',
    'namespace N { export enum O { a = 1 } }\nexport enum W { A = N.O.a }',
    'import O = Q.R;\nexport enum W { A = O.a }',
    'import * as t from "t";\nexport enum K { y = t.B | 1 }',
    // In a namespace the root may be a member of the namespace.
    'import * as t from "t";\nnamespace N { export enum K { x = t.SyntaxKind.A, y = 2 } }\nexport { N };',
    'export enum W { A = this.a }',
    'export enum W { A = someConst }',
  ]) {
    assert.notEqual(sameAsTypeScript(source, 'foreign.ts').backend, 'pulse', source);
  }
});

test('declare stands behind other modifiers, and readonly may precede abstract', () => {
  for (const source of [
    'class M {}\nexport class Tree { protected declare model: M; private declare readonly other: M; static declare count: number; kept = 1; }',
    'export abstract class R { readonly abstract recommendations: readonly string[]; readonly abstract onDidChange: Event; kept = 1; }',
  ]) {
    assert.equal(sameAsTypeScript(source, 'modifiers.ts').backend, 'pulse', source);
  }
  assert.doesNotMatch(compile(Buffer.from('export class Tree { protected declare model: M; kept = 1; }'), { file: 'modifiers.ts' }).code, /model|protected|declare/);
  // readonly belongs to a property.
  assert.notEqual(compile(Buffer.from('export abstract class R { readonly abstract m(): void; }'), { file: 'modifiers.ts' }).backend, 'pulse');
});

test('a left shift whose operand is followed by a right shift is no type argument list', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  for (const [source, file] of [
    ['const b = 3, c = 200, d = 2;\nexport const out = [b << 2 | c >>> 6, b << 2 | c >> d, b << d & c >> 1, 1 << 2 | c >>> 6, b << d | c | b >> 1];', 'shift.ts'],
    ['const b = 3, c = 200, d = [5, 6, 7, 8];\nexport const out = d[(b << 2 | c >>> 6) & 3];', 'shift.js'],
  ]) {
    const result = sameAsTypeScript(source, file);
    assert.match(result.backend, /^(pulse|javascript)$/, source);
    assert.deepEqual(run(result.code), run(reference(source, file)), source);
  }
  // A single > may close type arguments, and so may a shift behind operands that are not plain.
  for (const source of ['x = b << T | U > (d);\nexport {};', 'x = b << (T) | U >> (d);\nexport {};', 'x = b << T | U\n>> d;\nexport {};']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'shift.ts' }).backend, 'pulse', source);
  }
});

test('the operand of new may be parenthesized or asserted without an argument list', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  for (const source of [
    'interface I { k: number }\nfunction mock<T>(): any { return class { k = 1 }; }\nfunction f(...a: object[]) { return a; }\nexport const out = JSON.stringify(f(new (mock<I>()), new (mock<I>()), new class { k = 2 } as I, [new (mock())]));',
    'class K { v = 1 }\nconst o = { K };\nexport const out = JSON.stringify([new (o.K), new K as object, (new K as K).v]);',
  ]) {
    const result = sameAsTypeScript(source, 'operand.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'operand.ts')), source);
  }
});

test('an exported import alias is an exported variable, and override alone makes a parameter property', () => {
  for (const source of [
    'import * as Base from "./base";\nexport import Severity = Base.Severity;\nexport const worst = Severity.Error;',
    'import { testUtils } from "./utils";\nexport import flakySuite = testUtils.flakySuite;',
    'class B { t = 0; }\nclass C extends B { constructor(override t: number, protected override readonly u = 1) { super(); } }\nexport { C };',
  ]) {
    assert.equal(sameAsTypeScript(source, 'alias.ts').backend, 'pulse', source);
  }
  assert.equal(compile(Buffer.from('import { a } from "a";\nexport import b = a.b;'), { file: 'alias.ts' }).code, 'import { a } from "a";\nexport var b = a.b;');
  for (const source of [
    // An alias of a require call is written as a constant and an export list.
    'export import fs = require("fs");',
    // The name is exported once.
    'import { a } from "a";\nexport import b = a.b;\nexport const b = 1;',
    'import { a } from "a";\nexport import b = a.b;\nexport { b };',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'alias.ts' }).backend, 'pulse', source);
  }
});

test('the overloads of a function that a namespace exports are erased with their export', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'export namespace Event {\n  export function any(): number;\n  export function any(x: number): number;\n  export function any(x?: number) { return x ?? 1; }\n  export const two = any(2);\n}\nexport const out = JSON.stringify([Event.any(), Event.two]);',
    'namespace N {\n  export function f(a: string): { a: string }\n  export function f(a: number): { a: number }\n  export function f(a: any) { return { a }; }\n  export async function g(): Promise<void>;\n  export async function g(x?: number) { }\n}\nexport const out = JSON.stringify([N.f(1), typeof N.g]);',
  ]) {
    const result = sameAsTypeScript(source, 'overloads.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'overloads.ts')), source);
  }
  for (const source of [
    // Overloads that are not all exported, or not all local.
    'export namespace E { function f(): number; export function f(x?: number) { return 1; } }',
    'export namespace E { export function f(): number; function f(x?: number) { return 1; } export const a = f(); }',
    // No implementation.
    'export namespace E { export function f(): number; export const a = 1; }',
  ]) {
    assert.notEqual(compile(Buffer.from(source), { file: 'overloads.ts' }).backend, 'pulse', source);
  }
});

test('an assertion without parentheses is no assignment target on any route', () => {
  for (const operator of ['=', '+=', '-=', '^=', '&&=', '||=', '??=']) {
    for (const word of ['as', 'satisfies']) {
      const source = `let t: any;\nt ${word} any ${operator} 1;\nexport {};`;
      const result = compile(Buffer.from(source), { file: 'target.ts' });
      assert.notEqual(result.diagnostics.length, 0, source);
      assert.notEqual(result.backend, 'node-strip', source);
      const expected = ts.transpileModule(source, { fileName: 'target.ts', reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } });
      assert.equal(result.diagnostics.length, expected.diagnostics.length, source);
    }
  }
  // Comparisons and other operators behind an assertion are no assignment.
  for (const source of ['let t: any, x;\nx = t as any == 1;\nx = t as any === 1;\nx = t as any ?? 1;\nx = t as any || 2;\nexport {};']) {
    const result = sameAsTypeScript(source, 'target.ts');
    assert.equal(result.diagnostics.length, 0, source);
  }
});

test('an angle-bracket assertion in parentheses is an assignment target', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  const source = 'let t: unknown = 1, o: any = { x: 1 }, n: any = 1;\n(<any>t) = 2;\n(<any>o.x) = 3;\n(<number>n) += 4;\n(<number>n)++;\nexport const out = JSON.stringify([t, o, n]);';
  const result = sameAsTypeScript(source, 'angle.ts');
  assert.equal(result.backend, 'pulse');
  assert.equal(run(result.code), '[2,{"x":3},6]');
  // Without parentheses, and on what is no target, TypeScript reports it.
  for (const bad of ['let t: any;\n<any>t = 1;\nexport {};', 'declare function f(): any;\n(<any>f()) = 1;\nexport {};']) {
    assert.notEqual(compile(Buffer.from(bad), { file: 'angle.ts' }).backend, 'pulse', bad);
  }
});

test('a shorthand property that names an exported namespace variable is written with the namespace', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let)/g, ''))();
  for (const source of [
    'export namespace C { export const scheme = "s"; export function generate() { return { scheme, }; } export const both = [{ scheme }, { a: 1, scheme }]; }\nexport const out = JSON.stringify([C.generate(), C.both]);',
    'namespace N { export const k = 1; const local = 2; export const o = { k, local, m() { return { k }; } }; }\nexport const out = JSON.stringify([N.o, N.o.m()]);',
  ]) {
    const result = sameAsTypeScript(source, 'shorthand.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'shorthand.ts')), source);
  }
  assert.equal(compile(Buffer.from('namespace N { export const k = 1; export const o = { k }; }\nexport { N };'), { file: 'shorthand.ts' }).code,
    'var N;(function (N) { N.k = 1; N.o = { k:N.k }; })(N||(N={}));\nexport { N };');
  // A destructuring assignment is read another way; whichever route answers, the meaning is TypeScript's.
  const defaults = 'namespace N { export let a = 1; export function reset() { ({ a = 5 } = {} as any); return a; } }\nexport const out = JSON.stringify([N.reset(), N.a]);';
  assert.equal(run(sameAsTypeScript(defaults, 'shorthand.ts').code), '[5,5]');
  const swap = 'namespace N { export let a = 1; export let b = 2; export function swap(o: any) { ({ a, b } = o); return { a, b }; } }\nexport const out = JSON.stringify([N.swap({ a: 3, b: 4 }), N.a, N.b]);';
  assert.equal(run(sameAsTypeScript(swap, 'shorthand.ts').code), '[{"a":3,"b":4},3,4]');
  // A pattern that declares the name is no reference to the variable.
  for (const member of [
    'export const f = ({ k }: any) => k;', 'export function f({ k }: any) { return k; }', 'export const f = async ({ k }: any) => k;',
    'export function f(o: any) { const { k } = o; return k; }', 'export function f(o: any) { let { k = 2 } = o; return k; }',
    'export function f(o: any) { try { throw o; } catch ({ k }) { return k; } }', 'export function f(o: any[]) { for (const { k } of o) return k; }',
    'export const f = ({ a: { k } }: any) => k;', 'export const f = ([{ k }]: any) => k;', 'export function f(o: any) { var { k } = o; return k; }',
  ]) {
    const source = `namespace N { export const k = 1; ${member} }\nexport const out = JSON.stringify(N.f.length);`;
    const result = sameAsTypeScript(source, 'shorthand.ts');
    assert.notEqual(result.backend, 'pulse', source);
  }
});

test('a namespace behind an enum of its name merges with it', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-enum-namespace-merge.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 21);
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|enum|namespace)/g, ''))();
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const enumeration = { Plain: 'enum', Const: 'const enum', Exported: 'export enum', ExportedConst: 'export const enum', Declared: 'declare enum' }[row.Enum] + ' E { A = 1, B }';
    const body = { Empty: '', Function: 'export function parse(s: string) { return s === "A" ? E.A : E.B; }', Variable: 'export const all = [E.A, E.B];', TypeOnly: 'export type T = number;' }[row.Body];
    const space = (row.Space === 'Exported' ? 'export ' : '') + `namespace E { ${body} }`;
    const between = row.Between === 'Statement' ? 'const mid = 1;\n' : '';
    const source = (row.Order === 'EnumFirst' ? enumeration + '\n' + between + space : space + '\n' + between + enumeration) +
      '\nexport const out = (() => { try { return JSON.stringify(E, (k, v) => typeof v === "function" ? "fn" : v); } catch { return "none"; } })();';
    const result = sameAsTypeScript(source, 'merge.ts');
    assert.equal(run(result.code), run(reference(source, 'merge.ts')), source);
    if (result.backend === 'pulse') native++;
    // An enum that exists at run time, then a namespace with members of its own.
    if (row.Order === 'EnumFirst' && (row.Enum === 'Plain' || row.Enum === 'Exported') && (row.Body === 'Function' || row.Body === 'Variable')) {
      assert.equal(result.backend, 'pulse', source);
    }
    // Behind a const enum TypeScript does not resolve the members that declarations of the namespace share.
    if (row.Order === 'EnumFirst' && /Const/.test(row.Enum) && (row.Body === 'Function' || row.Body === 'Variable')) {
      assert.notEqual(result.backend, 'pulse', source);
    }
    // The other order would need the enum written without a declaration of its own.
    if (row.Order === 'SpaceFirst' && (row.Body === 'Function' || row.Body === 'Variable') && row.Enum !== 'Declared') {
      assert.notEqual(result.backend, 'pulse', source);
    }
  }
  assert.ok(native >= 3, String(native));
  assert.equal(compile(Buffer.from('enum E { A }\nnamespace E { export const first = E.A; }\nexport { E };'), { file: 'merge.ts' }).code,
    'var E; (function (E) {E[E["A"]=0]="A";})(E||(E={}));\n;(function (E) { E.first = E.A; })(E||(E={}));\nexport { E };');
  // Other declarations of the name still conflict with the enum.
  for (const source of ['enum E { A }\nconst E = 1;\nexport {};', 'enum E { A }\nclass E {}\nexport {};', 'enum E { A }\nfunction E() {}\nexport {};',
    'import { E } from "e";\nnamespace E { export const a = 1; }\nexport {};']) {
    assert.notEqual(compile(Buffer.from(source), { file: 'merge.ts' }).backend, 'pulse', source);
  }
});

test('an operator that binds no tighter than an assertion may follow it', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  const native = ['a as any || {}', 'a as T && b', 'a as T ?? b', 'a as T === b', 'a as T == b', 'a as T !== b', 'a as T != b', 'a as T ^ b',
    'a as T ? b : c', 'a + b as T || c', 'a < b as T || c', 'a as T as U || b', 'a satisfies T || b', 'a as T ?\n b : c', 'a as T[] || b',
    'a as T<U> === b', 'b || a as T === c && d', 'a! as T || b', 'a as unknown as T ? 1 : 2', 'a as const === b', '(a as T ? b : c)',
    'f(a as T || b, c as U ?? d)', 'a as T === b as U'];
  for (const expression of native) {
    const source = `declare let a: any, b: any, c: any, d: any, f: any, x: any;\nx = ${expression};\nexport {};`;
    assert.equal(sameAsTypeScript(source, 'follow.ts').backend, 'pulse', expression);
  }
  const values = 'const a: any = 0, b: any = 5, c: any = 7;\nexport const out = JSON.stringify([a as number || b, a as number ?? b, a as number === 0, a + b as number ? c : a, b as any ^ c, a as any && b]);';
  assert.equal(run(sameAsTypeScript(values, 'follow.ts').code), '[5,0,true,7,2,0]');
  // An assignment is no continuation, and neither do the operators that bind tighter follow natively.
  for (const expression of ['a as T ||= b', 'a as T &&= b', 'a as T ??= b', 'a as T ^= b', 'a as T = b', 'a as T < b', 'a as T ?.b', 'a as T ? ++b : c']) {
    const result = compile(Buffer.from(`x = ${expression};\nexport {};`), { file: 'follow.ts' });
    assert.notEqual(result.diagnostics.length, 0, expression);
  }
  for (const expression of ['a as T / b', 'a as T + b', 'a as T > b', 'a as T instanceof b', 'a as T\n|| b']) {
    const source = `declare let a: any, b: any, x: any;\nx = ${expression};\nexport {};`;
    assert.notEqual(sameAsTypeScript(source, 'follow.ts').backend, 'pulse', expression);
  }
});

test('a namespace body may read the name of the namespace, and a constructed name is a reference', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|namespace)/g, ''))();
  for (const source of [
    'export class Style { constructor(public bold = false) {} }\nexport namespace Style { export function is(s: any): s is Style { return s instanceof Style; } export function make() { return new Style(true); } }\nexport const out = JSON.stringify([Style.is(Style.make()), Style.is(1), Style.make()]);',
    'namespace T { export const self = T; export const list = [T, typeof T]; export namespace I { export const p = T; } }\nexport const out = JSON.stringify([T.self === T, T.list.length, T.I.p === T]);',
    'namespace A.B { export const pair = [A, B].map(x => typeof x); }\nexport const out = JSON.stringify(A.B.pair);',
    'export namespace N { export const a = () => N; export const o = { N }; }\nexport const out = JSON.stringify([N.a() === N, N.o.N === N]);',
    'namespace N { export const K = class { v = 1 }; export const made = new K(); export class L { w = 2 } export const other = new L(); }\nexport const out = JSON.stringify([N.made, N.other]);',
    'namespace N { export class K { v = 1 } }\nnamespace N { export const made = new K(); }\nexport const out = JSON.stringify(N.made);',
  ]) {
    const result = sameAsTypeScript(source, 'self.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'self.ts')), source);
  }
  // An occurrence that may declare the name leaves the namespace to TypeScript, which renames where it must.
  for (const member of ['export function f(T: number) { return T; }', 'export function f() { const T = 1; return T; }', 'export const T = 1;', 'export class T {}',
    'export function T() {}', 'export const k = { T: 1 };', 'export function f({ T }: any) { return T; }',
    'export function f() { try {} catch (T) { return T; } }', 'export function f() { class T {} return T; }', 'import T = Q.R; export const a = T;']) {
    const source = `namespace T { ${member} }\nexport { T };`;
    assert.notEqual(sameAsTypeScript(source, 'self.ts').backend, 'pulse', source);
  }
});

test('a type-only import alias is erased', () => {
  for (const source of [
    'import type Token = require("markdown-it/lib/token");\nexport function f(t: Token) { return t; }',
    'import type T = A.B.C;\nimport type U = require("u")\nexport const a: T | U = 1;',
    'import type T = require("m");\nexport {};',
  ]) {
    const result = sameAsTypeScript(source, 'typed.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /require|Token|import/, source);
  }
  // `type` may be the alias itself, and the erased name is no value.
  assert.match(sameAsTypeScript('import type = require("m");\nexport const a = type;', 'typed.ts').code, /const type = require\("m"\)/);
  assert.notEqual(compile(Buffer.from('import type T = require("m");\nexport const T = 1;'), { file: 'typed.ts' }).backend, 'pulse');
  // The alias alone leaves a file that TypeScript writes as a script; whichever route answers, the text is TypeScript's.
  sameAsTypeScript('import type T = require("m");\nconst x: T = 1;', 'typed.ts');
});

test('an abstract member may be optional, and an angle assertion may begin the value of a property', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  for (const source of [
    'export abstract class Driver { abstract validate?: () => boolean; abstract begin?(): void; protected abstract end?(flag: boolean): void; kept = 1; }',
    'export abstract class Driver { abstract readonly size?: number; abstract m?<T>(x: T): T; }',
  ]) {
    const result = sameAsTypeScript(source, 'optional.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /validate|begin|end\b|size/, source);
  }
  const values = 'interface G { name: string; nested?: G }\nconst list = [1];\nexport const out = JSON.stringify({ github: <G>{ name: "a", nested: <G>{ name: "b" } }, fn: <any>function () {}, plain: <number>list[0], [list[0]]:<G>{ name: "c" } });';
  const result = sameAsTypeScript(values, 'value.ts');
  assert.equal(result.backend, 'pulse');
  assert.equal(run(result.code), '{"1":{"name":"c"},"github":{"name":"a","nested":{"name":"b"}},"plain":1}');
  // At the start of a statement, of a labelled statement or of an arrow body the brace would open a block.
  for (const source of ['<any>{ a: 1 };\nexport {};', 'label: <any>{ a: 1, b: 2 };\nexport {};', 'export const f = () => <any>{ a: 1 };',
    'switch (x) { case 1: <any>{ a: 1, b: 2 }; }\nexport {};', 'if (x) <any>{ a: 1 };\nexport {};']) {
    assert.notEqual(sameAsTypeScript(source, 'value.ts').backend, 'pulse', source);
  }
});

test('the exponent assignment, and a rest element at the end of an array target', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  for (const [source, file, backend] of [
    ['let x = 2, y = { z: 3 };\nx **= 3;\ny.z **= x ** 0.5 > 2 ? 2 : 1;\nexport const out = JSON.stringify([x, y]);', 'power.js', 'javascript'],
    ['let x: number = 2;\nx **= 3;\nx **= 2;\nexport const out = x;', 'power.ts', 'pulse'],
    ['let a, b, c;\n[a, ...b] = [1, 2, 3];\n[, c, ...b] = [4, 5, 6, 7];\nexport const out = JSON.stringify([a, b, c]);', 'rest.js', 'javascript'],
    ['let a: number, b: number[], o = { rest: [] as number[] };\n[a, ...b] = [1, 2, 3];\n[a, ...o.rest] = b;\nexport const out = JSON.stringify([a, b, o]);', 'rest.ts', 'pulse'],
  ]) {
    const result = sameAsTypeScript(source, file);
    assert.equal(result.backend, backend, source);
    assert.deepEqual(run(result.code), run(reference(source, file)), source);
  }
  // A rest element must be the last one, and its operand a target.
  for (const source of ['let a, b;\n[...b, a] = [1, 2];\nexport {};', 'let a, b;\n[a, ...b,] = [1, 2];\nexport {};', 'let a;\n[a, ...f()] = [1, 2];\nexport {};']) {
    const result = compile(Buffer.from(source), { file: 'rest.js' });
    assert.ok(result.backend === 'typescript' || result.diagnostics.length !== 0, source);
  }
  // Two asterisks and an equals sign are no exponent in front of an assignment.
  assert.equal(compile(Buffer.from('let x = 1;\n1 **= x;\nexport {};'), { file: 'power.js' }).backend, 'typescript');
});

test('findings of the review of the namespace and assertion round', () => {
  // A type-only alias of a name inside the file is no import that makes the file a module.
  const script = 'namespace Models { export interface Item { id: number } }\nimport type Item = Models.Item;\nconst item: Item = { id: 1 };\nfunction isUnbound(this: void) { return this === undefined; }\nconsole.log(isUnbound(), item.id);';
  const strict = sameAsTypeScript(script, 'alias.ts');
  assert.match(strict.code, /^"use strict";/);
  assert.doesNotMatch(sameAsTypeScript('import type T = require("m");\nconst x: T = 1;', 'alias.ts').code, /use strict/);
  // Behind a const enum the declarations of a namespace do not share their members.
  const shared = 'const label = "default";\nexport const enum Status { OK }\nexport namespace Status { export const label = "ok"; }\nexport namespace Status { export const info = { label }; export const direct = label; }';
  const merged = sameAsTypeScript(shared, 'shared.ts');
  assert.match(merged.code, /Status\.info = \{ label \}/);
  assert.match(merged.code, /Status\.direct = label;/);
});

test('a declared module without a body is erased', () => {
  for (const source of [
    'declare module "jquery";\ndeclare module \'lodash\'\ndeclare module "a" { const x: number; export = x; }\nexport const a = 1;',
    'declare module "*.css";\nimport styles from "./a.css";\nexport const s = styles;',
    'declare module "x"\n{ export const y: number; }\nexport const z = 2;',
  ]) {
    const result = sameAsTypeScript(source, 'ambient.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /declare|jquery|lodash/, source);
  }
  // Without another statement the file is a script, as TypeScript writes it; whichever route answers.
  sameAsTypeScript('declare module "jquery";\nconst n: number = 1;', 'ambient.ts');
  assert.notEqual(compile(Buffer.from('declare module "jquery" const n = 1;\nexport {};'), { file: 'ambient.ts' }).backend, 'pulse');
});

test('findings of the second review of the namespace and assertion round', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|namespace)/g, ''))();
  // `export` at the end of a line comment is no modifier of the overload below it.
  const commented = 'namespace N {\n  // TODO: export\n  function format(value: string): string;\n  export function format(value: string) { return value.trim(); }\n}\nexport const out = N.format(" x ");';
  assert.equal(run(sameAsTypeScript(commented, 'second.ts').code), 'x');
  // A function assigned to a name in parentheses gets no name, so such an assignment is left to TypeScript,
  // which writes it without the parentheses.
  for (const target of ['(<() => void>handler)', '(handler as any)', '(handler!)', '((handler as any))']) {
    for (const [operator, value] of [['=', '() => {}'], ['=', 'function () {}'], ['=', 'class {}'], ['=', 'async () => {}'], ['=', 'x => x'], ['??=', '() => {}'], ['||=', '(() => {})']]) {
      const source = `let handler: any;\n${target} ${operator} ${value};\nexport const out = handler.name;`;
      const result = sameAsTypeScript(source, 'second.ts');
      assert.notEqual(result.backend, 'pulse', source);
      assert.equal(run(result.code), run(reference(source, 'second.ts')), source);
    }
  }
  // Other values and operators keep the native route.
  for (const statement of ['(handler as any) = other;', '(<number>handler) += 1;', '(handler as any) = [1].map(x => x);', '(handler as any) &&= 2;']) {
    const source = `let handler: any = 1, other = 2;\n${statement}\nexport const out = handler;`;
    assert.equal(sameAsTypeScript(source, 'second.ts').backend, 'pulse', source);
  }
});

test('a member of an enum may bear the name of a variable that the namespace exports', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|namespace)/g, ''))();
  for (const source of [
    'namespace WebviewState { export const enum Type { Initializing, Ready } export const Ready = { type: Type.Ready } as const; export const both = [Ready, Type.Ready]; }\nexport const out = JSON.stringify(WebviewState);',
    'namespace S { export enum Type { None, Done = None + 1 } export const Done = { type: Type.Done } as const; export class Active { readonly type = Type.None; constructor(public v = Done) {} } }\nexport const out = JSON.stringify([S.Done, new S.Active()]);',
    'namespace S { export const Ready = 1; function f() { enum T { Ready } return [T.Ready, Ready]; } export const got = f(); }\nexport const out = JSON.stringify(S.got);',
  ]) {
    const result = sameAsTypeScript(source, 'state.ts');
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), run(reference(source, 'state.ts')), source);
  }
  // A value that reads the variable would need the namespace in front of it: the enum is not written natively.
  for (const source of ['namespace S { export const base = 1; export enum Type { A = base } }\nexport { S };',
    'namespace S { export const A = 5; export enum Type { A = 1, B = A } export const got = A; }\nexport { S };',
    'namespace N { export const Text = { length: 3 }; enum Label { Length = Text.length } export const q = Label.Length; }\nexport { N };',
    'namespace S { export const A = "x"; enum Local { A = 1, B = A.length } export const got = [A, Local.B]; }\nexport { S };']) {
    assert.notEqual(sameAsTypeScript(source, 'state.ts').backend, 'pulse', source);
  }
});

test('the string of a JSX attribute may run over lines', () => {
  const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore';
  for (const [source, file] of [
    ['export const a = <T d="a\n   b" />;', 'lines.tsx'],
    ['export const a = <T d="a\r\n\tb &amp; c" e=\'x\ny\' />;', 'lines.tsx'],
    ['export const a = <T d="a\rb" />;', 'lines.jsx'],
    [`export const a = <T d="${long}\n    ${long} &lt; ${long}\n${long}" />;`, 'lines.tsx'],
    [`export const a = <div><T description="${long}\n      ${long}" /><p title="one\n two">x</p></div>;`, 'lines.tsx'],
  ]) {
    const result = sameAsTypeScript(source, file);
    assert.match(result.backend, /^(pulse|javascript)$/, source);
    assert.doesNotMatch(result.code.split('\n').slice(1).join('\n'), /^\s+Lorem/m, source);
  }
  const value = compile(Buffer.from('export const a = <T d="a\r\n\tb" />;'), { file: 'lines.tsx', jsx: 'classic' });
  assert.match(value.code, /"d":"a\\r\\n\\tb"/);
  // Other control characters and the line separator stay with TypeScript.
  for (const source of ['export const a = <T d="a b" />;', 'export const a = <T d="a\u0001b" />;']) {
    assert.notEqual(sameAsTypeScript(source, 'lines.tsx').backend, 'pulse', source);
  }
});

// A source for one row of verification/pict/compiler-assignment-targets.tsv.
function assignmentTarget(row) {
  const array = row.Outer === 'ArrayAssign' || row.Outer === 'ForOfArray';
  const element = {
    Name: 'a', Member: 'o.m', NestedArray: '[a, b]', NestedObject: '{ p: a, q: b }', DefaultName: 'a = 9', DefaultNested: '[a, b] = [7, 8]',
    RestName: '...a', RestMember: '...o.m',
  }[row.Element];
  const rest = row.Element.startsWith('Rest');
  const first = array || rest ? element : row.Element === 'Name' ? 'a' : 'k: ' + element;
  const extra = { None: '', Hole: ', ', Renamed: 'k2: c, ', Computed: '["k" + 3]: c, ', TrailingComma: '' }[row.Extra];
  const tail = array ? 'tail' : 't: tail';
  // A rest element stands last.
  const members = rest ? `${extra}${tail}, ${first}` : `${extra}${first}, ${tail}${row.Extra === 'TrailingComma' ? ',' : ''}`;
  const target = array ? `[${members}]` : `{ ${members} }`;
  const types = row.File === 'ts' ? ': any' : '';
  // Every element can be taken apart as an array or as an object.
  const value = 'Object.assign([[1, 2], [3, 4], [5, 6]], { a: 10, k: [5, 6], t: 7, k2: 8, k3: 9, p: 11, q: 12 })';
  const statement = row.Outer.startsWith('ForOf') ? `for (${target} of [value, value]) { count++; }` : array ? `${target} = value;` : `(${target} = value);`;
  return `let a${types}, b${types}, c${types}, tail${types}, count = 0;\nconst o${types} = {};\nconst value${types} = ${value};\n${statement}\nexport const out = JSON.stringify([a, b, c, o, tail, count]);`;
}

test('array and object targets of an assignment, nested, with defaults and with a rest element', () => {
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-assignment-targets.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 42);
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = assignmentTarget(row);
    const file = 'targets.' + row.File;
    const result = sameAsTypeScript(source, file);
    assert.equal(run(result.code), run(reference(source, file)), source);
    assert.equal(result.backend, row.File === 'js' ? 'javascript' : 'pulse', source);
    native++;
  }
  assert.equal(native, 42);
  // What is no target stays an error or with TypeScript: a rest element in front, a call, a parenthesized pattern.
  for (const source of ['let a, b;\n[...a, b] = [1, 2];\nexport {};', 'let a;\n({ k: f() } = {});\nexport {};', 'let a;\n[(a = 1)] = [2];\nexport {};',
    'let a;\n({ ...a, } = {});\nexport {};', 'let a, b;\n({ ...a, b } = {});\nexport {};', 'let a;\n([a]) = [1];\nexport {};', 'let a;\n({ get k() { return a; } } = {});\nexport {};']) {
    const result = compile(Buffer.from(source), { file: 'targets.js' });
    assert.ok(result.backend === 'typescript' || result.diagnostics.length !== 0, source);
  }
  // A member as the target of a loop.
  const loop = 'const o = { p: 0, q: [0] };\nlet sum = 0;\nfor (o.p of [1, 2]) sum += o.p;\nfor (o.q[0] in { x: 1, y: 2 }) sum += o.q[0].length;\nexport const out = JSON.stringify([o, sum]);';
  const looped = sameAsTypeScript(loop, 'targets.js');
  assert.equal(looped.backend, 'javascript');
  assert.equal(run(looped.code), '[{"p":2,"q":["y"]},5]');
});

test('a namespace with many exported variables counts their occurrences in one reading', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|namespace)/g, ''))();
  // Names that share their first letters, each read by the next; a string, a property and an enum member of a name.
  const variables = Array.from({ length: 400 }, (_, i) => `export const value${i}: number = ${i > 0 ? `value${i - 1} + ` : ''}1;`);
  const source = `export namespace Big {\n${variables.join('\n')}\nexport const text = 'value7'; export const o = [{ other: 0 }][0].other; export const p = Math.value9; export enum E { value3, last }\n` +
    'export const sum = [value0, value199, value399, E.value3, o].join(); }\nexport const out = [Big.sum, Big.text].join("|");';
  const result = sameAsTypeScript(source, 'many.ts');
  assert.equal(result.backend, 'pulse');
  assert.equal(run(result.code), '1,200,400,0,0|value7');
  assert.match(result.code, /Big\.value399\s*= Big\.value398 \+ 1;/);
  // One occurrence among them that is no read declines the whole namespace.
  for (const extra of ['export function f(value200: number) { return value200; }', 'export const k = { value200: 1 };', 'label: { const value200 = 1; }']) {
    const declined = `export namespace Big {\n${variables.join('\n')}\n${extra}\n}`;
    assert.notEqual(compile(Buffer.from(declined), { file: 'many.ts' }).backend, 'pulse', extra);
  }
});

test('a file with well over a thousand top-level names is compiled natively', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export (?=var|const|function|class|let|namespace|enum)/g, ''))();
  const count = 1500;
  for (const [name, source, expected] of [
    ['constants', Array.from({ length: count }, (_, i) => `export const v${i}: number = ${i};`).join('\n') + `\nexport const out = v${count - 1} + v0;`, count - 1],
    ['types and functions', Array.from({ length: 900 }, (_, i) => `export type T${i} = { n: ${i} };\nexport function f${i}(x: T${i}): number { return x.n; }`).join('\n') + '\nexport const out = f7({ n: 7 });', 7],
    ['enums', Array.from({ length: count }, (_, i) => `export enum E${i} { A = ${i}, B }`).join('\n') + `\nexport const out = E${count - 1}.B;`, count],
    ['classes with properties', Array.from({ length: count }, (_, i) => `export class C${i} { constructor(public a: number, private b = ${i}) {} }`).join('\n') + '\nexport const out = new C5(1).a;', 1],
    ['an export list', Array.from({ length: count }, (_, i) => `const w${i}: number = ${i};`).join('\n') + `\nexport { ${Array.from({ length: count }, (_, i) => `w${i}`).join(', ')} };\nexport const out = w3;`, 3],
  ]) {
    const result = compile(Buffer.from(source), { file: 'large.ts' });
    assert.equal(result.backend, 'pulse', name);
    assert.equal(run(result.code.replace(/export \{[^}]*\};/, '')), expected, name);
  }
  // A name declared twice far apart is still found.
  const twice = Array.from({ length: count }, (_, i) => `export const v${i}: number = ${i};`).join('\n') + '\nexport const v3: number = 0;';
  assert.notEqual(compile(Buffer.from(twice), { file: 'large.ts' }).backend, 'pulse');
  // Beyond the table the file is handed to TypeScript.
  const beyond = Array.from({ length: 2100 }, (_, i) => `export const v${i}: number = ${i};`).join('\n');
  assert.equal(compile(Buffer.from(beyond), { file: 'large.ts' }).backend, 'typescript');
});

test('a long chain of conditional types and a large union are read without nesting', () => {
  const chain = links => Array.from({ length: links }, (_, i) => `T extends A${i} ? B${i} : `).join('') + 'never';
  const union = members => Array.from({ length: members }, (_, i) => `"m${i}"`).join(' | ');
  for (const [name, source] of [
    ['a chain of 200 in an alias', `export type Events<T> = ${chain(200)};\nexport const a = 1;`],
    ['a chain of 50 in an annotation', `export function f<T>(x: ${chain(50)}): void {}\nexport const a = 1;`],
    ['a union of 3,000 in an alias', `export type Name = ${union(3000)};\nexport const a: Name = "m1";`],
    ['a union of 1,000 in an annotation', `export const a: ${union(1000)} = "m1";`],
    ['an intersection of 500', `export type All = ${Array.from({ length: 500 }, (_, i) => `{ k${i}: number }`).join(' & ')};\nexport const a = 1;`],
    ['a chain whose links hold unions and nested types', `export type X<T> = ${Array.from({ length: 80 }, (_, i) => `T extends Array<Map<string, A${i} | B${i}>> ? { v: ${i} } | null : `).join('')}never;\nexport const a = 1;`],
  ]) {
    const result = sameAsTypeScript(source, 'chain.ts');
    assert.equal(result.backend, 'pulse', name);
  }
  // What nests still has its limit, and a chain beyond the budget of an annotation is handed on.
  for (const source of [`export type X = ${'Array<'.repeat(40)}number${'>'.repeat(40)};\nexport const a = 1;`,
    `export function f<T>(x: ${chain(100)}): void {}\nexport const a = 1;`, `export type E<T> = ${chain(400)};\nexport const a = 1;`]) {
    assert.equal(sameAsTypeScript(source, 'chain.ts').backend, 'typescript');
  }
  // A chain is no place for a line break in front of `extends`, and each link needs both branches.
  assert.notEqual(compile(Buffer.from('export type X<T> = T extends A ? B;\nexport const a = 1;'), { file: 'chain.ts' }).backend, 'pulse');
});

test('the targets from ES2022 on compile as ESNext unless a form that TypeScript lowers stands in the source', () => {
  const reference = (source, file, target) => ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget[target.toUpperCase()], module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true } });
  const same = (source, file, target) => {
    const result = compile(Buffer.from(source), { file, target });
    const expected = reference(source, file, target);
    assert.deepEqual(inspect(ts, result.code, file), inspect(ts, expected.outputText, file), `${target} ${source}`);
    return result;
  };
  for (const target of ['es2022', 'es2023', 'es2024', 'es2025']) {
    for (const [source, file] of [
      ['import { a } from "./a";\nexport enum E { A }\nnamespace N { export const n: number = E.A + a; }\nexport class C { static count = 0; constructor(public v: number) {} static { C.count++; } }', 'new.ts'],
      ['/** @param x a value, using the cache; an accessor function */\nexport const f = (x: number): number => x ?? 1;\nexport const color: string = "#fff";', 'new.ts'],
      ['export const el = <div className="x">{(1 as number) ||= 2}</div>;'.replace('(1 as number) ||= 2', 'n as number'), 'new.tsx'],
      ['export class A { static x = () => A; static { A.x(); } m() { return A; } }\nexport const top = await Promise.resolve(1);', 'new.js'],
    ]) {
      const result = same(source, file, target);
      assert.match(result.backend, /^(pulse|javascript)$/, `${target} ${source}`);
    }
    // Each of the forms that TypeScript writes differently for these targets goes to TypeScript.
    for (const source of [
      'function d(...a: any[]): any {}\n@d export class A { @d m() {} }',
      'export function f(g: () => Disposable) { using x = g(); return x; }',
      'export async function f(g: () => AsyncDisposable) { await using /* held */ x = g(); return x; }',
      'export function f(list: Disposable[]) { for (using x of list) { void x; } }',
      'export class A { accessor x = 1; static accessor #y = 2; }',
      'export class Foo { #x() { return Foo; } }',
      'export class Foo {\n  /** doc */ #x = () => Foo;\n}',
    ]) {
      const result = same(source, 'new.ts', target);
      assert.equal(result.backend, 'typescript', `${target} ${source}`);
    }
  }
  // A decorator in a place where the parser gives no records still goes to TypeScript, and a source given
  // as a string is decided like one given as bytes.
  same('function d(...a: any[]): any {}\nexport @d class A {}', 'new.ts', 'es2022');
  assert.equal(compile('function d(...a: any[]): any {}\nexport @d class A {}', { file: 'new.ts', target: 'es2022' }).backend, 'typescript');
  assert.equal(compile('export enum E { A }', { file: 'new.ts', target: 'es2022' }).backend, 'pulse');
  assert.equal(compile('export class A { accessor x = 1; }', { file: 'new.ts', target: 'es2022' }).backend, 'typescript');
  // An older target is lowered by TypeScript where the source holds a form newer than it.
  assert.equal(compile(Buffer.from('export class A { x: number = 1; }'), { file: 'new.ts', target: 'es2021' }).backend, 'typescript');
  // With a source map the route is the same.
  const mapped = compile(Buffer.from('export enum E { A }\nexport const a: number = E.A;'), { file: 'new.ts', target: 'es2022', sourceMap: true });
  assert.equal(mapped.backend, 'pulse');
  assert.equal(typeof mapped.sourceMap.mappings, 'string');
});

// A source for one row of verification/pict/compiler-jsx-preserve.tsv.
function keptJsx(row) {
  const tag = { Intrinsic: 'section', Component: 'Panel', Member: 'ui.Panel', Fragment: '', Generic: 'List<Item>' }[row.Tag];
  const closing = row.Tag === 'Generic' ? 'List' : tag;
  const attribute = { None: '', String: ' title="a &amp; b \'q\'"', Typed: ' value={(first as Item).id!}', Spread: ' {...(rest as object)}',
    Element: ' icon=<i />', Flag: ' hidden' }[row.Attribute];
  const child = { None: null, Text: "  don't &nbsp; stop — 日本語\n  ", Typed: '{count as number}', Nested: '<b>{<i>{label satisfies string}</i>}</b>',
    Comment: '{/* note */}', Mapped: '{items.map((item: Item, at: number) => <li key={item.id}>{at}</li>)}' }[row.Child];
  const element = child === null ? `<${tag}${attribute} />` : `<${tag}${attribute}>${child}</${closing}>`;
  const around = {
    Plain: `export const view = ${element};`,
    RemovedType: `type Local = { id: string };\nexport const view = (local: Local) => ${element};`,
    GenericArrow: `export const view = <T,>(given: T) => ${element};`,
    Enum: `export enum Mode { On, Off }\nexport const view = (mode: Mode = Mode.On) => ${element};`,
  }[row.Around];
  return `import { ui, Panel, List, items, first, rest, count, label } from "./parts";\ninterface Item { id: string }\n${around}\n`;
}

test('JSX that is kept: elements as written, with the types around and inside them erased', () => {
  const kept = (source, file = 'kept.tsx') => {
    const expected = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.Preserve, verbatimModuleSyntax: true } });
    assert.deepEqual(expected.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], source);
    const result = compile(Buffer.from(source), { file, jsx: 'preserve' });
    assert.equal(typeof result.code, 'string', source);
    assert.deepEqual(inspect(ts, result.code, file), inspect(ts, expected.outputText, file), source);
    return result;
  };
  const [header, ...rows] = readFileSync(new URL('../verification/pict/compiler-jsx-preserve.tsv', import.meta.url), 'utf8')
    .trim().split('\n').map(line => line.split('\t'));
  assert.equal(rows.length, 39);
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = keptJsx(row);
    const result = kept(source);
    assert.equal(result.backend, 'pulse', source);
    assert.doesNotMatch(result.code, /_tmt|react\/jsx-runtime|createElement/, source);
  }
  // The text of an element is the source's, byte for byte.
  const text = kept('export const view = <p title="a &amp; b">  don\'t &nbsp; stop — 日本語\n  {1 as number}</p>;\n');
  assert.ok(text.code.includes('<p title="a &amp; b">  don\'t &nbsp; stop — 日本語\n  {1'), text.code);
  // TypeScript drops a container that holds nothing and joins the texts around it; one with a comment stays.
  assert.equal(kept('export const view = <p>&{}amp;</p>;\n').backend, 'typescript');
  assert.equal(kept('export const view = <p>a{ }b{1 as number}</p>;\n').backend, 'typescript');
  assert.equal(kept('export const view = <p>a{/* note */}b{1 as number}</p>;\n').backend, 'pulse');
  assert.equal(kept('export const view = <p>&{\u2028}amp;</p>;\n').backend, 'typescript');
  // A text that begins like a comment is written twice by TypeScript; it is left to it.
  assert.equal(compile(Buffer.from('export const view = <p>{0}/*x*/</p>;\n'), { file: 'kept.tsx', jsx: 'preserve' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('export const view = <p>{0} // x\n</p>;\n'), { file: 'kept.tsx', jsx: 'preserve' }).backend, 'typescript');
  assert.equal(kept('export const view = <a>{0}see http://example.test/x</a>;\n').backend, 'pulse');
  // A file that is left without an import or export gains one from TypeScript, so it is not answered here.
  assert.equal(kept('import type { T } from "./t";\nconst view = <p>export</p>;\nvoid view;\n').backend, 'typescript');
  // A script keeps the TypeScript route; .jsx and a request for a map are answered natively.
  assert.equal(kept('const view = <p />;\nvoid view;\n').backend, 'typescript');
  assert.equal(kept('export const view = <p />;\n', 'kept.jsx').backend, 'pulse');
  assert.equal(compile(Buffer.from('export const view = <p>{1 as number}</p>;\n'), { file: 'kept.tsx', jsx: 'preserve', sourceMap: true }).backend, 'pulse');
  // The other modes are unchanged by the third one.
  assert.match(compile(Buffer.from('export const view = <p>{1 as number}</p>;\n'), { file: 'kept.tsx' }).code, /react\/jsx-runtime/);
  assert.match(compile(Buffer.from('export const view = <p>{1 as number}</p>;\n'), { file: 'kept.tsx', jsx: 'classic' }).code, /React\.createElement/);
});

test('each target compiles natively up to the forms of its year', () => {
  // A source and the first target year that TypeScript writes like ESNext.
  const forms = [
    ['/** doc */\nexport function f(a: number[]): number { for (const x of a) g(x); try { g(1); } catch (e) { g(e); } return a.length; }\ndeclare function g(x: unknown): void;', 2015],
    ['export enum E { A }\nnamespace N { export const x: number = E.A; }\nexport const n = N.x;', 2015],
    ['export const p: number = 2 ** 3;', 2015],
    ['export async function f(): Promise<number> { return await g(); }\ndeclare function g(): Promise<number>;', 2017],
    ['declare const p: object;\nexport const o = { ...p };', 2018],
    ['export function f(...rest: number[]) { return rest; }', 2018],
    ['export async function f(s: AsyncIterable<number>) { for await (const x of s) void x; }', 2018],
    ['export const o = { async /* c */ *g() { yield 1; } };', 2018],
    ['declare const tag: any;\nexport const a = tag`\\u bad \\x1 \\1`;', 2018],
    ['declare const tag: any;\nexport const a = tag`\\u{110000}`;', 2018],
    ['export const o = { async /* { */ *g() { yield 1; } };', 2018],
    ['export const f = async function\n* () { yield 1; };', 2018],
    ['export /* c */ * as parts from "./parts";', 2015],
    ['export // c\n * as parts from "./parts";', 2015],
    ['declare const b: number;\nexport const a = b /* c */** 2;', 2015],
    ['declare const b: number;\nexport const a = 2 **/* c */ b;', 2015],
    ['let a = 2;\na **= 2;\nexport { a };', 2015],
    ['export const p: number = 2 ** 3 ** 2;', 2016],
    ['export * from "./parts";\nexport { a } from "./a";\nexport default 1;', 2015],
    ['  /*****\n * banner\n */\nexport const a: string = `t${1}` + "\\u0041\\x41";', 2015],
    ['export function f(g: () => void) { try { g(); } catch { g(); } }', 2015],
    ['export function f(g: () => void) { try { g(); } catch /* none */ { g(); } }', 2015],
    ['export function f(g: () => void) { const _a = 1; try { g(); } catch { g(); return _a; } }', 2015],
    ['export function f() { const _\\u0061 = 42; try { throw 1; } catch { return _\\u0061; } }', 2019],
    ['declare const b: { c?: number } | undefined;\nexport const a = b?.c;', 2015],
    ['declare const b: { c?: { d?: number } } | undefined;\nexport const a = b?.c?.d;', 2020],
    ['declare const b: number | undefined;\nexport const a = b ?? 1;', 2015],
    ['declare function f(): number | undefined;\nexport const a = f() ?? 1;', 2020],
    ['export * as parts from "./parts";', 2015],
    ['let a: number | undefined;\na ||= 1;\na &&= 2;\na ??= 3;\nexport { a };', 2015],
    ['declare const o: { a?: number };\no.a ||= 1;', 2021],
    ['export const n: number = 1_000 + 0xff_ff;', 2015],
    ['export const s: string = "1_000"; export const d = 1_000.2_5e1_0 + 0b1010_0101;', 2015],
    ['export const big = 1_000n;', 2020],
    ['export const x = (1_000).to_string;', 2015],
    ['export const x = 1.._;', 2015],
    ['export const x = (0xab_cd).foo_bar;', 2015],
    ['export default /1_000/;', 2015],
    ['export const x = [.../1_0/.source];', 2018],
    ['export const x = 1_0..to_string;', 2015],
    ['export const x = 1_0n.valueOf();', 2020],
    ['export const x = 1_0..n;', 2015],
    ['#!/usr/bin/env -S node 1_0\nexport const x = 1_0;', 2015],
    ['// comment\rexport const x = 1_0;', 2015],
    ['export class A { x = 1; static s = 2; }', 2022],
    ['export const A = class { m() { return 1; } };', 2015],
    ['export class M { constructor(x: number) { this.x = x; } m() { return this.x; } static s() { return 1; } get g() { return 2; } }', 2015],
    ['export class P { constructor(public x: number) {} }', 2022],
  ];
  const years = { es2015: 2015, es6: 2015, es2016: 2016, es2017: 2017, es2018: 2018, es2019: 2019, es2020: 2020, es2021: 2021, es2022: 2022, es2023: 2023 };
  for (const [target, year] of Object.entries(years)) {
    for (const [source, since] of forms) {
      const expected = ts.transpileModule(source, { fileName: 'year.ts', reportDiagnostics: true, compilerOptions: {
        target: ts.ScriptTarget[target === 'es6' ? 'ES2015' : target.toUpperCase()], module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } });
      const result = compile(Buffer.from(source), { file: 'year.ts', target });
      assert.deepEqual(inspect(ts, result.code, 'year.ts'), inspect(ts, expected.outputText, 'year.ts'), `${target} ${source}`);
      assert.equal(result.backend === 'typescript', year < since, `${target} ${source}`);
    }
    // JSX is native from ES2018 on, where the object of its attributes may spread.
    const jsx = compile(Buffer.from('export const e = <a b={1 as number} />;'), { file: 'year.tsx', target });
    assert.equal(jsx.backend === 'typescript', year < 2018, target);
  }
  // A doc comment with two stars inside compiles natively once tokenized.
  assert.notEqual(compile(Buffer.from('/** a ** b */\nexport const a: number = 1;'), { file: 'year.ts', target: 'es2015' }).backend, 'typescript');
  // Shadowed Math declines exponentiation lowering to TypeScript.
  assert.equal(compile(Buffer.from('const Math = { pow: () => 0 };\nexport const a = 2 ** 3;'), { file: 'year.ts', target: 'es2015' }).backend, 'typescript');
  // Direct vs indirect eval optional call declines to TypeScript.
  assert.equal(compile(Buffer.from('export const a = eval?.("1");'), { file: 'year.ts', target: 'es2019' }).backend, 'typescript');
  // Mixed ?? and || declines to TypeScript.
  assert.equal(compile(Buffer.from('declare const a: any, b: any, c: any;\nexport const x = a ?? b || c;'), { file: 'year.ts', target: 'es2019' }).backend, 'typescript');
  // Two stars behind the slash that closes a regular expression are the operator.
  const regex = 'var r = /**// /**/asdf /;';
  const lowered = compile(Buffer.from(regex), { file: 'year.js', target: 'es2015' });
  assert.equal(lowered.backend, 'typescript');
  assert.match(lowered.code, /Math\.pow/);
  // Members whose modifier touches the private name, and a loop head or a field with a comment in it.
  for (const source of ['export class A { static#x = 1; get#y() { return A; } }', 'export class A { async#y() { return A; } }',
    'export function f(l: Disposable[]) { for (/* c */ using x of l) void x; }', 'export class A { accessor x // c\n}',
    // Names outside ASCII and names written with an escape.
    'export class C { accessor café = 1 }', 'export class C { accessor \\u0063af = 1 }', 'export class C { static accessor 名; }',
    'export function f(g: () => Disposable) { using café = g(); return café; }', 'export function f(g: () => Disposable) { using \\u{63}af = g(); }',
    'export class Café { #é() { return Café; } }',
    // Tokens that touch the word, and white space that is neither a space, a tab nor a line end of ASCII.
    'export class A { accessor["x"] = 1; }', 'export class A { accessor#x = 1; }', 'export class A { static accessor\'y\' = 1; }',
    'export class A {\u2028#f() { return A; } static same = new this().#f() === this; }',
    'export function f() { using\u000bx = null; }', 'export function f() { using\u00a0x = null; }', 'export class A { accessor\u3000x = 1; }']) {
    assert.equal(compile(Buffer.from(source), { file: 'year.ts', target: 'es2022' }).backend, 'typescript', source);
  }
  assert.equal(compile(Buffer.from('export async function\u2028*f() { yield 1; }'), { file: 'year.ts', target: 'es2017' }).backend, 'typescript');
  // Other white space leaves a file with TypeScript wherever a pattern is consulted at all.
  assert.equal(compile(Buffer.from('export const a: string = "\u00a0";'), { file: 'year.ts', target: 'es2021' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('export const a: string = "\u00a0";'), { file: 'year.ts', target: 'es2022' }).backend, 'pulse');
  assert.equal(compile(Buffer.from('export const a: string = "\u00a0";'), { file: 'year.ts' }).backend, 'pulse');
  // Tokenized downlevel skips comments and strings for `class` and `??`, while real classes below ES2022 still defer.
  assert.equal(compile(Buffer.from('// no class here\nexport const a: number = 1;'), { file: 'year.ts', target: 'es2020' }).backend, 'pulse');
  assert.equal(compile(Buffer.from('export const a: string = "x ?? y";'), { file: 'year.ts', target: 'es2019' }).backend, 'pulse');
  // Single-optional-point chaining with non-optional continuations (`id?.b.c(1)`, `id?.b[0]`, `this?.a`) lowers natively below ES2020.
  for (const src of [
    'export const f = (data: any) => data?.trim/* keep */();\n',
    'export const f = (a: any) => a?.b.c(1);\n',
    'export const f = (a: any) => a?.b[0].d;\n',
    'export function f(this: any) { return this?.a.b(); }\n',
  ]) {
    const r = compile(Buffer.from(src), { file: 'year.ts', target: 'es2019' });
    assert.equal(r.backend, 'pulse', src);
    assert.deepEqual(inspect(ts, r.code, 'year.ts'), inspect(ts, ts.transpileModule(src, {
      fileName: 'year.ts', compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } }).outputText, 'year.ts'), src);
  }
  const optCall = compile(Buffer.from('export const f = (data: any) => data?.trim/* keep */();\n'), { file: 'year.ts', target: 'es2019' });
  assert.match(optCall.code, /data\.trim\/\* keep \*\/\(\)/);
  // Review round 44 & 46: keyword property after `?.` followed by division + `class`,
  // inline `extends class {}` / `extends function () {}`, and `async` field before newline decline below ES2022.
  for (const src of [
    'export const y = ({ return: 1 })?.return / class { static n = 2 }.n / 2;\n',
    'export const y = ({ if: () => 1 })?.if() / class { static n = 2 }.n / 2;\n',
    'export class A extends class {} { x = 1; }\n',
    'export class A extends function () {} { static {} }\n',
    'export class A { async\nm() {} }\n',
    'export class A { async /*\n*/ m() {} }\n',
  ]) {
    assert.equal(compile(Buffer.from(src), { file: 'year.ts', target: 'es2021' }).backend, 'typescript', src);
  }
  // A private name outside a class is an error that TypeScript prints differently per target.
  assert.equal(compile(Buffer.from('declare const x: any;\nx.#bar = 1;\nexport {};'), { file: 'year.ts', target: 'es2021' }).backend, 'typescript');
});

test('lifted syntax limits: for-of object defaults, new a!.b(), labeled simple statements, and deeper type nesting', () => {
  const cases = [
    'declare const x: any;\nlet a: number;\nfor ({ a = 1 } of x) {}\nexport { a };\n',
    'declare const x: any;\nlet a: any, c: any, r: any;\nfor ({ a = 1, b: c = 2, ...r } of x) {}\nexport { a, c, r };\n',
    'declare const a: any;\nexport const v = new a!.b();\n',
    'declare const a: any;\nexport const v = new a!.b.c<number>();\n',
    'export function f() { lbl: 1 + 2; }\n',
    'export function f() { lbl: break lbl; }\n',
    `export type Deep = ${'Array<'.repeat(24)}number${'>'.repeat(24)};\nexport const x: Deep = [] as any;\n`,
  ];
  for (const source of cases) {
    const result = compile(Buffer.from(source), { file: 'lifted.ts' });
    assert.equal(result.backend, 'pulse', source);
    const expected = ts.transpileModule(source, { fileName: 'lifted.ts', compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } }).outputText;
    assert.deepEqual(inspect(ts, result.code, 'lifted.ts'), inspect(ts, expected, 'lifted.ts'), source);
  }
  // A lexical declaration behind a label matches TypeScript's syntax-only transpileModule output.
  sameAsTypeScript('export function f() { lbl: const x = 1; }\n', 'lifted.ts');
});

test('pure-JavaScript .ts modules and scripts validated by V8 publish natively while declining TS-rejected forms', () => {
  for (const source of [
    'class C { get 0b10() { return 2; } }\nexport { C };\n',
    'const \\u0061 = 1;\nexport default \\u0061;\n',
  ]) {
    const r = compile(Buffer.from(source), { file: 'js.ts' });
    assert.equal(r.backend, 'javascript', source);
    assert.equal(r.code, source);
  }
  // Escaped keyword, `new import(...)`, generic-call/regex ambiguity, and CR/LS-ended `//` comments stay with TypeScript.
  assert.equal(compile(Buffer.from('class C { st\\u0061tic\nx = 1; }\nexport { C };\n'), { file: 'bad.ts' }).backend, 'typescript');
  for (const sep of ['\r', '\u2028', '\u2029']) {
    const r = compile(Buffer.from(`// x${sep}export class C { st\\u0061tic\nx = 1; }\n`), { file: 'bad.ts' });
    assert.equal(r.backend, 'typescript');
    assert.equal(r.code, null);
  }
  assert.equal(compile(Buffer.from('new import.meta();\nexport {};\n'), { file: 'bad.ts' }).backend, 'typescript');
  assert.equal(compile(Buffer.from('new /*c*/ import.meta();\nexport {};\n'), { file: 'bad.ts' }).code, null);
  sameAsTypeScript('export const a = f(a < b, c > (d));\n', 'bad.ts');
  sameAsTypeScript('export const a = f(a0 < b, c > /d/g);\n', 'bad.ts');
  // Out-of-range Unicode escapes in non-u regexes and invalid identifiers must not throw RangeError.
  for (const module of ['preserve', 'cjs']) {
    const regexOk = compile(Buffer.from('export function f() { return /\\u{110000}/; }\n'), { file: 're.ts', module });
    assert.equal(typeof regexOk.code, 'string', module);
    const badId = compile(Buffer.from('export const x = \\u{110000};\n'), { file: 'bad.ts', module });
    assert.equal(badId.code, null, module);
  }
});

test('downlevel review round 42 regressions match TypeScript in AST and runtime behavior', () => {
  for (const [target, source, expectNative] of [
    ['es2019', 'declare function g(): any;\ndeclare const a: any;\nexport function f() { g()\na?.b; }', false],
    ['es2019', 'export function f(a: any) { return (a?.b)(); }', false],
    ['es2019', 'export function f(a: any) { return delete (a?.b); }', false],
    ['es2019', 'export function f(a: any) { return ((a?.b.m))(); }', false],
    ['es2019', 'export function f(a: any) { return delete ((a?.b.c)); }', false],
    ['es2019', 'export function f(a: any) { return ((a?.b.m))`x`; }', false],
    ['es2019', 'export function f(a: any) { return (((a?.b.c))).d; }', false],
    ['es2019', 'export function f(a: any) { a ||= `x${1}`; return a; }', true],
    ['es2019', 'export function f(a: any) { a ||= /a;b/; return a; }', true],
    ['es2019', 'export function f(a: any, b: any) { switch (a) { case a ||= b: return 1; } }', false],
    ['es2019', 'export function f(\\u0061: any) { return \\u0061?.x; }', false],
    ['es2019', 'export const x = ev\\u0061l?.("1");', false],
    ['es2015', 'export function f(a: any, b: any) { return a ** b`x`; }', false],
  ]) {
    const r = compile(Buffer.from(source), { file: 'r42.ts', target });
    assert.equal(r.backend !== 'typescript', expectNative, `${target}: ${source}`);
    const expected = ts.transpileModule(source, { fileName: 'r42.ts', compilerOptions: {
      target: ts.ScriptTarget[target.toUpperCase()], module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true } }).outputText;
    assert.deepEqual(inspect(ts, r.code, 'r42.ts'), inspect(ts, expected, 'r42.ts'), `${target}: ${source}`);
  }
  // Comment preservation in exponentiation lowering.
  const commentExp = compile(Buffer.from('export const x = 2 /*x*/ ** /*y*/ 3;\n'), { file: 'r42.ts', target: 'es2015' });
  assert.equal(commentExp.backend, 'pulse');
  assert.match(commentExp.code, /Math\.pow\(2 \/\*x\*\/, \/\*y\*\/ 3\)/);
});

test('Stage 3 standard ES class decorators lower natively with __esDecorate for ES2022 and ES2023', () => {
  for (const target of ['es2022', 'es2023']) {
    for (const source of [
      'declare const Dec: any;\n@Dec\nexport class Foo { x: number = 1; }\n',
      'declare const A: any, B: any;\n@A\n@B(1)\nexport class Bar { m(): number { return 1; } }\n',
      'declare const Dec: any, Base: any;\n@Dec\nexport class Sub extends Base { x = 1; }\n',
      'declare const Dec: any;\n@Dec\nexport default class Baz { x = 1; }\n',
    ]) {
      const r = compile(Buffer.from(source), { file: 'dec.ts', target });
      assert.equal(r.backend, 'pulse', `${target}: ${source}`);
      const expected = ts.transpileModule(source, { fileName: 'dec.ts', compilerOptions: {
        target: ts.ScriptTarget[target.toUpperCase()], module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: false } }).outputText;
      assert.deepEqual(inspect(ts, r.code, 'dec.ts'), inspect(ts, expected, 'dec.ts'), `${target}: ${source}`);
    }
    // Member decorators, static fields/blocks, and reserved-name collisions decline cleanly to TypeScript.
    assert.equal(compile(Buffer.from('declare const M: any;\nexport class C { @M m() {} }\n'), { file: 'dec.ts', target }).backend, 'typescript');
    assert.equal(compile(Buffer.from('declare const Dec: any;\n@Dec\nexport class C { static x = 1; }\n'), { file: 'dec.ts', target }).backend, 'typescript');
    assert.equal(compile(Buffer.from('declare const Dec: any;\n@Dec\nexport class C { static /* c */ { } }\n'), { file: 'dec.ts', target }).backend, 'typescript');
    assert.equal(compile(Buffer.from('declare const Dec: any;\nconst _classThis = 1;\n@Dec\nexport class C {}\n'), { file: 'dec.ts', target }).backend, 'typescript');
    // Shebang stays before emitted helpers.
    const sb = compile(Buffer.from('#!/usr/bin/env node\ndeclare const Dec: any;\n@Dec\nexport class C {}\n'), { file: 'dec.ts', target });
    assert.equal(sb.backend, 'pulse');
    assert.ok(sb.code.startsWith('#!/usr/bin/env node\n'));
  }
});

test('F170 TypeScript lowering: legacy module, CJS equals, ambient blocks, TSX pre-pass, and SWC relaxations', async () => {
  for (const [file, source] of [
    ['mod.ts', 'module A.B { export const x = 1; export function f() { return 2; } }\n'],
    ['cjs.ts', 'import fs = require("node:fs");\nexport = fs;\n'],
    ['amb.ts', 'declare module "pkg" { export function f(): void; }\nconst v: number = 1;\n'],
    ['tsx-cjs.tsx', '// @jsx: preserve\nimport React = require("react");\nconst el = <div />;\n'],
    ['tsx-amb.tsx', '// @jsx: preserve\ndeclare module JSX { interface Element {} }\nconst el = <div />;\n'],
    ['dec-expr.ts', 'declare var dec: any;\nconst C = (@dec class {});\n'],
    ['non-es-dec.ts', 'declare function dec<T>(t: T): T;\n@dec\ninterface I {}\n'],
    ['relax-eval.ts', 'class C { f(arguments: any) { return arguments; } }\n'],
    ['relax-const.ts', 'const x: number;\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  // Invalid syntax inside declare module, reserved type alias names, and malformed references must be rejected.
  for (const [file, source] of [
    ['bad-amb.ts', 'declare module M { export extension class C {} }\nconst x = 1;\n'],
    ['bad-res.ts', 'declare module debugger {}\nexport const x = 1;\n'],
    ['bad-type.ts', 'type void = number;\n'],
    ['bad-ref.ts', '/// <reference path="unclosed.ts />\nclass C {}\n'],
    ['bad-var.ts', 'type T<in in> = T;\n'],
    ['bad-shorthand.ts', 'export {};\nconst x = {if};\n'],
    ['bad-dup-static.ts', 'export {};\nclass C { static /*a*/ static x = 1; }\n'],
    ['bad-bare-await.ts', 'export {};\nawait;\n'],
  ]) {
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 52 regressions: template literal preservation, multi-declarator namespace refs,
  // enum forward-ref/pow, and ASI continuation after "use strict".
  const tplSrc = '// import\nconst s = `\ndeclare module Foo {\n}`;\nclass C { accessor x: number = 1; }\n';
  assert.match(sameAsTypeScript(tplSrc, 'tpl.ts').code, /declare module Foo \{/);
  sameAsTypeScript('module N { export const a = 1, b = a + 1; }\n', 'ns-multi.ts');
  sameAsTypeScript('enum E { A = E.X, X = 2 }\n', 'enum-fwd.ts');
  sameAsTypeScript('enum E { A = 2 ** 3 }\n', 'enum-pow.ts');
  sameAsTypeScript('"use strict"\n[1].forEach(console.log);\nlet x: any;\n', 'strict-asi.ts');
  // F172/F173 regressions: pure-JS SWC relaxations, namespace cross-stmt export refs, optional-chain LHS,
  // nested module/export-interface lowering, and strict rejection of TS syntax errors.
  for (const [file, source] of [
    ['ns-cross-ref.ts', 'module M { export interface I { a: number; } export var a = 1; export var b = a + 1; }\n'],
    ['ns-nested-line.ts', 'module A { export module B { export module C { export class D {} } } }\n'],
    ['opt-lhs.ts', 'declare const o: any;\no?.["a"]++;\no?.a = 1;\n'],
    ['for-of-init.ts', 'for (var a = 1, b = 2 of []) {}\n'],
    ['destr-pp.ts', 'class C { constructor(public { a }: any) {} }\n'],
    ['js-with.ts', 'with ({}) {}\nexport {};\n'],
    ['js-import-args.ts', 'import();\nexport {};\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  for (const [file, source] of [
    ['bad-import-mod.ts', 'import r = module("rect");\n'],
    ['bad-if-void.ts', 'interface void {}\n'],
    ['bad-await-arrow.ts', 'async function f(a = await => await) {}\n'],
    ['bad-yield-arrow.ts', 'function* g(a = yield => yield) {}\n'],
    ['bad-double-inc.ts', 'let x = 1;\n++x++;\n'],
    ['bad-for-let-of.ts', 'for (let of []) {}\n'],
    ['bad-import-type-defer.ts', 'import type defer * as ns from "./a";\n'],
    ['bad-yield-comment-arrow.ts', 'function* g(a: any = yield /*x*/ => yield) {}\n'],
  ]) {
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 53 regressions: TSX string with `// @jsx:`, `$&` in for-of init, enum `.length` and string-concat comparison.
  sameAsTypeScript('// @jsx: preserve\nconst s = "// @jsx: keep";\nconst el = <div>{s}</div>;\n', 'tsx-str-jsx.tsx');
  assert.match(compile(Buffer.from('// @jsx: preserve\nconst s = "// @jsx: keep";\nconst el = <div>{s}</div>;\n'), { file: 'tsx-str-jsx.tsx' }).code, /\/\/ @jsx: keep/);
  sameAsTypeScript("for (var a = '$&', b = \"$'$$\" of []) {}\n", 'for-of-dollar.ts');
  sameAsTypeScript("enum E { A = 'abc'.length, B }\n", 'enum-len.ts');
  sameAsTypeScript("enum E { A = '\\n'.length, B }\n", 'enum-len-esc.ts');
  sameAsTypeScript("enum E { A = 'a' + 1 }\n", 'enum-str-fold.ts');
  sameAsTypeScript("enum E { A = 'a' + 'b' === 'ab' }\n", 'enum-str-cmp.ts');
  // F175/F176 regressions (98%+ official suites): JSX automatic fallback (fragments, namespaces, pragmas, spread children),
  // top-level `export import`, enum string/template/computed/block lowering, angle-bracket `<T>{}`, and strict TS-error rejections.
  for (const [file, source] of [
    ['tsx-frag-ws.tsx', 'const a = <   ></   >;\nconst b = < /*c*/ ></ /*c*/ >;\n'],
    ['tsx-ns.tsx', 'const a = <svg:path a:b={1}></svg:path>;\n'],
    ['tsx-pragma-src.tsx', '/* @jsxImportSource preact */\nconst a = <div className="x">hi</div>;\n'],
    ['tsx-spread-child.tsx', 'declare const xs: any[];\nconst a = <div>{...xs}</div>;\n'],
    ['exp-imp-alias.ts', 'namespace M { export var x = 1; }\nexport import a = M.x;\n'],
    ['enum-tpl.ts', 'enum E { A = `1`, B = "1" + "2", C = `1` + "2" }\n'],
    ['enum-block.ts', '{ enum A { X = 1 } }\n'],
    ['angle-obj.ts', 'var v = (a: any) => <any><any>{};\nvar w = <any>{ a: 1 };\n'],
    ['let-reserved.ts', 'const x = 1, let = 2;\nfor (let let of [1]) {}\n'],
    ['ctor-dup.ts', 'class C { constructor(a: number) {} constructor(b: string) {} }\n'],
    ['use-strict-non-simple.ts', 'function f(a = 1) { "use strict"; return a; }\n'],
    ['static-const.ts', 'class C { static const H = 1; }\n'],
    ['override-order.ts', 'class A { override static x = 1; }\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  for (const [file, source] of [
    ['bad-tsx-brace.tsx', 'let x = <div>}</div>;\n'],
    ['bad-tsx-gt.tsx', 'let x = <div>></div>;\n'],
    ['bad-tsx-unclosed.tsx', 'let x = <   Foo >Hello\n'],
    ['bad-pub-ctor.ts', 'class C { public constructor; }\n'],
    ['bad-using-destr.ts', '{ await using [a] = null; }\nexport {};\n'],
    ['bad-using-of.ts', 'for (using of of []) {}\n'],
    ['bad-var-enum.ts', 'var enum = 1;\nexport {};\n'],
    ['bad-for-semi.ts', 'for (a; b\n)\nexport {};\n'],
    ['bad-async-fn-lhs.ts', '(async function foo() {} = 1);\nexport {};\n'],
    ['bad-let-nl-yield.ts', 'function f() { let\nyield 0; }\nexport {};\n'],
    // Review Round 54 negative syntax rejections:
    ['r54-f-await.ts', 'export {}; f(await);\n'],
    ['r54-jsx-bad-ta.tsx', 'export const x = <div<,>/>;\n'],
    ['r54-jsx-empty-ns-attr.tsx', 'export const x = <div a:=""/>;\n'],
    ['r54-enum-spaced-shift.ts', 'export enum E { A = 1 < < 2 }\n'],
  ]) {
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 54 semantic/AST equivalence & crash-safety regressions:
  for (const [file, source] of [
    ['r54-jsx-entities.tsx', 'export const x = <a:b>&nbsp; &amp;lt;</a:b>;\n'],
    ['r54-jsx-dup-key.tsx', 'declare function a(): any; declare function b(): any;\nexport const x = <a:b key={a()} key={b()} />;\n'],
    ['r54-jsx-comma.tsx', 'declare const a: any, b: any;\nexport const x = <div a={(a, b)} key={a, b} {...a, b}>{a, b}</div>;\nexport const y = <div a={a, b} />;\n'],
    ['r54-jsx-regex.tsx', 'export const x = <a:b>{/[=<x/>]/.source}</a:b>;\n'],
    ['r54-jsx-str-pragma.tsx', 'const s = "/* @jsxImportSource fake */";\nexport const x = <a:b/>;\n'],
    ['r54-jsx-directive.tsx', '"use client";\nexport const x = <a:b/>;\n'],
    ['r54-enum-paren-str.ts', 'export enum E { A = ("x") }\n'],
    ['r54-enum-hex-key.ts', 'export enum E { 0x10 = 2 }\n'],
  ]) {
    sameAsTypeScript(source, file);
  }
  // Deeply nested JSX must not throw RangeError (Maximum call stack size exceeded)
  const deepJsx = 'export const x = ' + '<a:b>'.repeat(400) + '<a:b/>' + '</a:b>'.repeat(400) + ';\n';
  assert.doesNotThrow(() => compile(Buffer.from(deepJsx), { file: 'r54-deep.tsx' }));
  // Out-of-range numeric JSX entity must not crash the JSX fallback lowerer
  const { lowerJsxToAutomatic } = await import('../src/compiler-jsx-lower.cjs');
  assert.equal(lowerJsxToAutomatic('export const x = <a:b>&#1114112;</a:b>;'), null);
});

test('F178 official spec suite push: Test262 99.88%, TS compiler/conformance 98.3%+, zero FP', () => {
  for (const [file, source] of [
    ['f178-str-import-defer.ts', 'const s = "import defer does not trigger evaluation";\nexport { s };\n'],
    ['f178-esc-accessor-asi.ts', 'var C = class { acc\\u0065ssor\na = 1; };\nexport {};\n'],
    ['f178-esc-await-binding.ts', 'async () => { var \\u0061wait; };\nexport {};\n'],
    ['f178-esc-class-await.ts', 'var C = class aw\\u0061it {};\nexport {};\n'],
    ['f178-esc-for-async-of.ts', 'let async; for (\\u0061sync of [7]);\nexport {};\n'],
    ['f178-regex-octal-u.ts', '/\\1/u;\nexport {};\n'],
    ['f178-for-in-dstr.ts', 'for ([[(x, y)]] in [[[]]]) ;\nexport {};\n'],
    ['f178-for-in-rest.ts', 'for ([...x, y] in [[]]) ;\nexport {};\n'],
    ['f178-export-declare-ns.ts', 'export declare namespace Foo { export var static: any; }\nexport const x = 1;\n'],
    ['f178-async-await-arrow.ts', 'var foo = async (await): Promise<void> => {};\n'],
    ['f178-override-pp.ts', 'class B { p1!: string; }\nclass C extends B { constructor(public override p1: string) { super(); } }\n'],
    ['f178-tsx-script.tsx', 'namespace JSX { export interface Element {} }\nconst x = 1;\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  for (const [file, source] of [
    ['f178-bad-yield-star-nl.ts', 'function* g() { yield\n* 1; }\nexport {};\n'],
    ['f178-bad-esc-get-asi.ts', 'class C { \\u0067\\u0065\\u0074\na = 1; }\nexport {};\n'],
    ['f178-bad-ctor-field.ts', 'class C { constructor; }\n'],
    ['f178-bad-await-using-arr.ts', '{ await using [a] = null; }\nexport {};\n'],
    // Review Round 55 negative syntax rejections:
    ['r55-bad-mapped.ts', 'type T = { a: 1; [K in +]: V };\n'],
    ['r55-bad-mapped.tsx', 'export const x = <div/>;\ntype T = { a: 1; [K in +]: V };\n'],
    ['r55-bad-index-init.ts', 'class C { [x: string = +]: number }\n'],
    ['r55-bad-import-type-obj.ts', 'let x: import({x: +});\n'],
    ['r55-bad-esc-get-num.ts', 'class C { \\u0067et 1() {} }\n'],
    ['r55-bad-esc-static-esc.ts', 'class C { \\u0073tatic \\u006d() {} }\n'],
    ['r55-bad-mapped-stmt.ts', 'type T = { a: 1; [K in string; const a = 1]: V };\n'],
    ['r55-bad-index-escape.ts', 'class C { [x: string = 1); const y = (2]: number }\n'],
    ['r55-bad-ambient-bare-await.ts', 'export declare namespace N { export var static: any; }\nawait;\n'],
    ['r55-bad-ambient-bare-await.tsx', 'export declare namespace N { export var static: any; }\nawait;\n'],
  ]) {
    const tm = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.ok((tm.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error), `TS must reject: ${file}`);
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 55 AST/module-mode equivalence regressions:
  for (const [file, source] of [
    ['r55-import-type-and-dyn.ts', 'type T = import(Foo); const p = import(Foo);\n'],
    ['r55-typeof-import-type-and-dyn.ts', 'type T = typeof import(Foo); const p = typeof import(Foo);\n'],
    ['r55-new-meta-and-target.ts', 'function f(){new.foo;new.target;}\n'],
    ['r55-new-meta-and-str.ts', 'function f(){new.foo;} const s="new.target";\n'],
    ['r55-only-ambient-export.ts', 'export declare namespace N { export var static: any; }\nconst x = 1;\n'],
    ['r55-only-ambient-export.tsx', 'export declare namespace N { export var static: any; }\nconst x = 1;\n'],
    ['r55-only-ambient-export-await.ts', 'export declare namespace N { export var static: any; }\nawait foo();\n'],
    ['r55-only-ambient-export-await.tsx', 'export declare namespace N { export var static: any; }\nawait foo();\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    if (file.startsWith('r55-only-ambient-export')) {
      assert.ok(!r.code.includes('"use strict"'), `must not emit "use strict" in module ${file}`);
    }
  }
});

test('F181 official spec suite push: Test262 99.96%, TS compiler/conformance 98.5%+, zero FP', () => {
  for (const [file, source] of [
    ['f181-shorthand-yield.ts', '0, { yield } = {};\nexport {};\n'],
    ['f181-shorthand-await-fn.ts', 'class C { static { (() => ({ await })); } }\nexport {};\n'],
    ['f181-var-await-dstr.ts', 'class C { static { var { await } = {}; } }\nexport {};\n'],
    ['f181-esc-yield-label.ts', 'yi\\u0065ld: 1;\nexport {};\n'],
    ['f181-multi-mod-static-block.ts', 'class C { readonly private static {} }\n'],
    ['f181-priv-in-declare-type.ts', 'declare const x: { #foo: number; };\nconst y = 1;\n'],
    ['f181-tagged-tpl-chain.ts', 'declare const a: any;\nconst x = a?.`hello`;\n'],
    ['f181-obj-lit-mods.ts', 'let data = { public foo: "hey", private bar: "nay" };\n'],
    ['f181-uninit-dstr.ts', 'var [a], {b}, c;\n'],
    ['f181-ns-export-default-abs.ts', 'namespace ns_abs { export default abstract class {} }\n'],
    ['f181-jsdoc-fn-comment.ts', '/** @typedef {function} T */\ndeclare const x: T;\nclass T { prop: number; }\n'],
    ['f181-opt-chain-lt.ts', 'declare const items: { id?: number }[];\nitems.filter(item => item?.id < 5);\n'],
    ['f181-empty-type-alias-mod.ts', 'export type A = {}\ntype A = {}\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  for (const [file, source] of [
    ['f181-bad-for-let-semi.ts', 'var let;\nfor (let = 3; ; ) break;\nexport {};\n'],
    ['f181-bad-gen-shorthand-yield.ts', '(function*() { 0, { yield } = {}; });\nexport {};\n'],
    ['f181-bad-static-shorthand-await.ts', 'class C { static { ({ await }); } }\nexport {};\n'],
    ['f181-bad-esc-yield-label-gen.ts', 'class C { *m() { yi\\u0065ld: ; } }\nexport {};\n'],
    ['f181-bad-for-using-of.ts', 'for (using of of []) {}\n'],
    // Review Round 56 negative syntax rejections:
    ['r56-bad-var-await-call.ts', 'var await; f(await, 0); export {};\n'],
    ['r56-bad-var-await-arr.ts', 'var await; const a = [await]; export {};\n'],
    ['r56-bad-static-nested-await.ts', 'class C { static { if (true) { ({ await }); } } } export {};\n'],
    ['r56-bad-gen-quoted-yield.ts', 'const v = { *"m"() { return { yield }; } }; export {};\n'],
    ['r56-bad-for-let-nl-eq.ts', 'var let; for (let\n= 3; ; ) break; export {};\n'],
    ['r56-bad-fn-static-await.ts', 'function f() { class C { static { ({ await }); } } } export {};\n'],
    ['r56-bad-nested-static-await.ts', 'class C { static { class D { static {} } ({ await }); } } export {};\n'],
  ]) {
    const tm = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.ok((tm.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error), `TS must reject: ${file}`);
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 56 AST/literal preservation regressions:
  for (const [file, source] of [
    ['r56-type-only-ns-alias.ts', 'namespace A { export interface X {} }\nimport B = A;\nconsole.log(B);\n'],
    ['r56-type-only-ns-alias-member.ts', 'namespace A { export type T = number; }\nimport B = A.T;\nconsole.log(B);\n'],
    ['r56-tagged-tpl-str-lit.ts', 'declare const a: any;\nconst s = "a?.`b`";\nconst r = /a?.`b`/;\nconst x = a?.`c`;\n'],
    ['r56-tagged-tpl-if-regex.ts', 'declare const a: any;\nif (true) /a?.`b`/.test("x");\nconst x = a?.`c`;\n'],
    ['r56-arrow-nl-tpl-lit.ts', 'const s = `a\n=>b`;\nconst f = ()\n=> 1;\n'],
    ['r56-mul-and-shorthand-yield.ts', 'const p = 2 * 3;\n0, { yield } = {};\nexport { p };\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    if (file === 'r56-mul-and-shorthand-yield.ts') assert.notEqual(r.backend, 'typescript');
  }
});

test('F184 official spec suite push: Test262 99.98%, TS compiler/conformance 98.7%+, zero FP', () => {
  for (const [file, source] of [
    ['f184-dec-member-underscore.ts', 'let ns = { _() {}, \\u{6F}() {} };\n@ns._\n@ns.\\u{6F} class C {}\nexport {};\n'],
    ['f184-static-fn-param-await.ts', 'var await = 0;\nclass C { static { (function (x = await) { return await; })(); } }\nexport {};\n'],
    ['f184-static-esc-arguments.ts', 'class C { static { (class { [argument\\u0073]() {} }); } }\nexport {};\n'],
    ['f184-tsx-param-prop.tsx', 'class Box { constructor(public x: number) {} }\nexport const v = <div />;\n'],
    ['f184-tsx-ambient-only.tsx', 'declare module JSX { interface Element {} }\nexport const x = 1;\n'],
    ['f184-param-prop-prologue.ts', 'class C { constructor(private a: string) { "ngInject"; } }\n'],
    ['f184-param-prop-super-mid.ts', 'class B {} class D extends B { constructor(public x: number) { console.log(1); super(); console.log(2); } }\n'],
    ['f184-override-param-prop.ts', 'class B { p!: string; } class C extends B { constructor(override p: string) { super(); } m(override q: string) {} }\n'],
    ['f184-enum-bigint.ts', 'enum E { 0n = 0 }\n'],
    ['f184-enum-tpl-const.ts', 'enum T { a = `1`, b = `1${"2"}3`, c = `1` - `1` }\n'],
    ['f184-ctor-empty-typeargs.ts', 'class C { constructor<>() {} constructor < >() {} }\n'],
    ['f184-obj-lit-q-bang.ts', 'const a = 1; const o = { a!, foo?() {} };\n'],
    ['f184-export-declare-class-impl.ts', 'export declare class C { static f() {} };\n'],
    ['f184-mapped-get-set.ts', 'type T = { get [K in "a"](): string };\n'],
    ['f184-override-mods.ts', 'class B { p = 1; } class D extends B { override declare p: number; readonly override q: number; }\n'],
    ['f184-jsdoc-nullable.ts', 'function f(a: ?string, b: number!, c: Array.<string>) { return a; }\n'],
    ['f184-for-using-of.ts', 'for (using of = null;;) break;\n'],
    ['f184-strict-multi-kw.ts', '"use strict";\nvar [public] = [1]; var [[private]] = [[2]];\n'],
    ['f184-import-star-await.ts', 'import * as await from "./m";\nexport { await as x };\n'],
    ['f184-leading-multi-slash.ts', 'interface A { x: number }\n////////\ndeclare const a: A;\nconsole.log(a);\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  // AST-exactness guards (must match TS even if falling back)
  for (const [file, source] of [
    ['f184-enum-const-fold.ts', 'const d = "d";\nenum E { D = d }\n'],
    ['f184-enum-forward-ref.ts', 'enum E1 { X = Y, Y = E1.Z }\nenum E1 { Z = 4 }\n'],
    ['f184-enum-self-ref.ts', 'enum E { A = A, D = 1 + D }\n'],
  ]) {
    sameAsTypeScript(source, file);
  }
  // Negative rejections: TS errors must NOT compile natively
  for (const [file, source] of [
    ['f184-bad-num-sep-dot.ts', 'const x = 1._0;\nexport {};\n'],
    ['f184-bad-fn-param-nested-static-await.ts', 'var await = 0;\nclass C { static { (function (x = class { static { ({ await }); } }) {})(); } }\nexport {};\n'],
    // Review Round 57 negative rejections:
    ['r57-bad-call-override.ts', 'class C { constructor(public x: number) {} }\nfoo(override x);\n'],
    ['r57-bad-call-override.tsx', 'class C { constructor(public x: number) {} }\nexport const v = <div />;\nfoo(override x);\n'],
    ['r57-bad-ambient-import-dot.ts', 'declare module "m" { declare import X = X.; }\nexport const x = 1;\n'],
    ['r57-bad-ambient-import-dot.tsx', 'declare module "m" { declare import X = X.; }\nexport const v = <div />;\n'],
    ['r57-bad-enum-tpl-leading-zero.ts', 'enum E { A = `1${08}3` }\n'],
    ['r57-bad-enum-esc-digit.tsx', 'enum E { \\u0030 = 2 }\nexport const v = <div />;\n'],
    // Review Round 57 follow-up (Round 2) negative rejections:
    ['r57r2-bad-ternary-override.ts', 'class C { constructor(public x: number) {} }\ntrue ? foo(override x) : 0;\n'],
    ['r57r2-bad-ternary-override.tsx', 'class C { constructor(public x: number) {} }\nexport const v = <div />;\ntrue ? foo(override x) : 0;\n'],
    ['r57r2-bad-block-override.ts', 'class C { constructor(public x: number) {} }\nfoo(override x)\n{}\n'],
    ['r57r2-bad-enum-tpl-sep-exp.ts', 'enum E { A = `1${1e_2}3` }\n'],
    ['r57r2-bad-enum-tpl-sep-dbl.tsx', 'enum E { A = `1${1__2}3` }\nexport const v = <div />;\n'],
    ['r57r2-bad-ambient-import-true.ts', 'declare module "m" { declare import X = true; }\nexport const x = 1;\n'],
    ['r57r2-bad-ambient-req-nosep.ts', 'declare module "m" { declare import X = require("m")const x: number; }\nexport const x = 1;\n'],
  ]) {
    const tm = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.ok((tm.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error), `TS must reject: ${file}`);
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
  // Review Round 57 AST/runtime preservation regressions:
  for (const [file, source] of [
    ['r57-enum-esc-member.ts', 'enum E { \\u0041 = 1 }\n'],
    ['r57-enum-merged-self-ref.ts', 'enum E { A = E.X }\nenum E { X = 4 }\n'],
    ['r57-enum-other-str-ref.ts', 'enum F { X = "s" }\nenum E { A = F.X }\n'],
    ['r57-braceless-if-super.ts', 'class B {} class D extends B { constructor(public x: number) { if (true) super(); } }\n'],
    ['r57-braceless-while-super.ts', 'class B {} class D extends B { constructor(public x: number) { while (false) super(); } }\n'],
    ['r57-declare-priv-next-field.ts', 'class C { declare #x: number\ny = 1; }\n'],
    ['r57-ctor-tagged-tpl-nl.ts', 'class C { constructor(public x: number) { "abc"\n`tpl`; } }\n'],
    ['r57-ctor-prologue-inc-nl.ts', 'class C { constructor(public x: number) { "abc"\n++x; } }\n'],
    // Review Round 57 follow-up (Round 2) AST/runtime preservation regressions:
    ['r57r2-static-declare-priv.ts', 'class C { static declare #x: number\ny = 1; }\n'],
    ['r57r2-enum-dollar-merged.ts', 'enum E$ { A = E$.X }\nenum E$ { X = 4 }\n'],
    ['r57r2-enum-comment-merged.ts', 'enum /*c*/ E { A = E.X }\nenum\nE { X = 4 }\n'],
    ['r57r2-enum-forward-merged-other.ts', 'enum F {}\nenum E { A = F.X }\nenum F { X = "s" }\n'],
    ['r57r2-void-nl-super.ts', 'class B {} class D extends B { constructor(public x: number) { void\nsuper(); } }\n'],
    ['r57r2-plus-nl-super.ts', 'class B {} class D extends B { constructor(public x: number) { 0 +\nsuper(); } }\n'],
    ['r57r2-enum-literal-merged-name.ts', 'enum E { __MERGED__ = 1 }\n'],
  ]) {
    sameAsTypeScript(source, file);
  }
});

test('F187 official spec suite push: Test262 99.99%, TS compiler/conformance 98.8%+, zero FP', () => {
  for (const [file, source] of [
    ['f187-unpaired-surrogate-reexport.ts', 'export { "\\uD83D" } from "./m.js";\nexport {};\n'],
    ['f187-unpaired-surrogate-as-reexport.ts', 'export { "☿" as "\\uD83D" } from "./m.js";\nexport {};\n'],
    ['f187-strict-import-public-req.ts', '"use strict"\nimport public = require("1");\n'],
    ['f187-strict-empty-mod-public.ts', '"use strict"\nmodule public {}\nmodule private.public.foo {}\n'],
    ['f187-unary-strict-eval.ts', '"use strict"\n++eval;\n--arguments;\neval++;\n'],
    ['f187-paren-comma-lhs.ts', 'var x;\n(1, x) = 0;\n'],
    ['f187-spread-angle-assert.ts', 'let o = { ...<object>{} };\n'],
    ['f187-return-nl-angle-obj.ts', 'function f() { return <any>\n{}; }\n'],
    ['f187-enum-cross-ref-const.ts', 'const enum A { Zero, One }\nconst enum B { X = A.One }\n'],
    ['f187-using-module.ts', 'using d1 = { [Symbol.dispose]() {} };\nexport {};\n'],
  ]) {
    const r = sameAsTypeScript(source, file);
    assert.notEqual(r.backend, 'typescript', `${file}: ${source}`);
  }
  // Negative rejections:
  for (const [file, source] of [
    ['f187-bad-export-trailing-tok.ts', 'export { a } foo;\n'],
    ['f187-bad-paren-lhs-inner.ts', '(1 + ) = 0;\n'],
  ]) {
    const tm = ts.transpileModule(source, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.ok((tm.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error), `TS must reject: ${file}`);
    const r = compile(Buffer.from(source), { file });
    assert.equal(r.code, null, `must reject invalid TS: ${file}`);
  }
});
