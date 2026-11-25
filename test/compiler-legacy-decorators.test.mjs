import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { inspect } from '../scripts/audit-compiler-coverage.mjs';
import { compile } from '../src/compiler.mjs';

const ts = createRequire(import.meta.url)('typescript');
const options = { file: 'legacy.ts', experimentalDecorators: true };

// The lowering has to give the syntax of TypeScript's own lowering.
function lowered(source) {
  const result = compile(Buffer.from(source), options);
  const reference = ts.transpileModule(source, { fileName: 'legacy.ts', reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: true } });
  assert.deepEqual(reference.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], source);
  assert.equal(typeof result.code, 'string', source);
  assert.deepEqual(inspect(ts, result.code, 'legacy.ts'), inspect(ts, reference.outputText, 'legacy.ts'), source);
  return result;
}

test('legacy decorators are lowered natively to the calls TypeScript writes', () => {
  for (const source of [
    '@Injectable()\nexport class A extends B {\n  @Input() x = 1;\n  @dec static s() {}\n  constructor(@IFoo private readonly foo: IFoo, bar: IBar, @Inject(T) @Optional() baz: T) { super(); }\n  m(@Arg() a: number) { return 1; }\n  get g() { return 1; }\n}',
    'class A { constructor(@IFoo private readonly foo: IFoo) {} }\nexport { A };',
    'export class A { @Input() x: number; @Output() "quoted-key" = 1; @d get v() { return 1; } @e \'single\' = 2; }',
    'export abstract class A { constructor(@IFoo protected foo: IFoo) {} abstract m(): void; protected abstract n: number; f(): void; f(a?: number) {} }\nexport class B { constructor(@IFoo foo: IFoo) {} }',
    'import { Inject } from "x";\n// leading\n@Component({ selector: "a", template: `<p>${1}</p>` })\nexport class C implements OnInit { @Input({ required: true }) name!: string; @Output() changed = new EventEmitter<string>(); constructor(private readonly http: HttpClient) {} @HostListener("window:resize", ["$event"]) onResize(e: Event) {} ngOnInit(): void {} }',
    'export class A { @d static x = 1; @d y = 2; @d static m() {} @d n() {} }',
    'export class A { @d get v() { return 1; } set v(x) {} }',
    'export class A { m(@a @b x: number, y: string, @c z = 1) {} }',
    'export class A { constructor(@a public x: number, @b private y = 2) {} }',
    '@a @b.c @d() @e.f(1, "x")\nexport class A {}',
    '@a class A {}\n@b class B extends A {}\nexport { A, B };',
    'export class A<T> { constructor(@IFoo foo: IFoo<T>) {} m<U>(@d a: U): U { return a; } }',
    'export class A { constructor(@IFoo foo: IFoo) {} }\nexport const a = new A(null);',
    'export class A { @d\n  m() {} // c\n  @e\n  n = 1\n}',
  ]) {
    const result = lowered(source);
    assert.equal(result.backend, 'pulse', source);
    assert.match(result.code, /__decorate\(\[/, source);
  }
});

test('the lowered text runs: decorators see the class, the member and the parameter index', () => {
  const source = 'const log: string[] = [];\n' +
    'const d = (name: string) => (target: any, key?: any, extra?: any) => { log.push(name + ":" + (typeof target === "function" ? target.name : target.constructor.name) + ":" + String(key) + ":" + typeof extra); };\n' +
    '@d("class")\nclass A {\n  @d("field") x = 1;\n  @d("static") static s() {}\n  constructor(@d("ctor") readonly v: number) {}\n  @d("method") m(@d("param") a: number) { return a + this.v; }\n}\n' +
    'export const out = [log.join("|"), new A(2).m(3)];';
  const result = lowered(source);
  assert.equal(result.backend, 'pulse');
  const out = new Function(result.code.replace(/export const out =/, 'return'))();
  assert.deepEqual(out, ['field:A:x:undefined|param:A:m:number|method:A:m:object|static:A:s:object|ctor:A:undefined:number|class:A:undefined:undefined', 5]);
});

test('what the first cut does not lower is left to TypeScript, with the same result', () => {
  for (const source of [
    'export default class A { constructor(@IFoo foo: IFoo) {} }',
    'export class A { @d get v() { return 1; } @d set v(x) {} }',
    'export class A { @d [k]() {} }',
    'export class A { set v(@d x: number) {} }',
    '"use strict";\n@d class A {}\nexport { A };',
    'function f() { @d class L { constructor(@IFoo foo: IFoo) {} } return L; }\nexport { f };',
    'const C = class { constructor(@IFoo foo: IFoo) {} };\nexport { C };',
  ]) {
    assert.equal(lowered(source).backend, 'typescript', source);
  }
  // A decorator on the parameter of a function that is no class member is not read here; TypeScript drops it.
  for (const source of ['export function f(@x q) {}', 'export class A { m() { return function (@x q) {}; } }']) {
    assert.equal(lowered(source).backend, 'typescript', source);
  }
});

test('a source whose at signs are no decorators compiles as without the option', () => {
  const source = '/** @param a a number */\nexport function f(a: number) { return "@" + a; }';
  assert.deepEqual(compile(Buffer.from(source), options), compile(Buffer.from(source), { file: 'legacy.ts' }));
  assert.equal(compile(Buffer.from(source), options).backend, 'pulse');
});

test('metadata and source maps keep the TypeScript route', () => {
  const source = 'export class A { constructor(@IFoo foo: IFoo) {} }';
  assert.equal(compile(source, { ...options, emitDecoratorMetadata: true }).backend, 'typescript');
  assert.equal(compile(source, { ...options, sourceMap: true }).backend, 'typescript');
});

// A class that names itself in its body. TypeScript writes a second name for the decorated class and uses it for
// every reference in the body; this compiler takes the name off the class expression, so that the body sees the
// variable. The two texts differ, so they are compared by what they do.
test('a class that names itself in its body behaves as TypeScript\'s lowering does', () => {
  const source = 'const replace = (target: any) => class Replaced extends target { static tag = "replaced"; };\n' +
    'const keep = (target: any) => { target.kept = true; };\n' +
    'const mark = (target: any, key: any, index: number) => { (target.marks ??= []).push(index); };\n' +
    '@replace\nclass A {\n  static first = A.name;\n  static self = A;\n  static make() { return new A(1); }\n' +
    '  constructor(@mark readonly v: number) {}\n  who() { return [A.name, (A as any).tag, this instanceof A]; }\n  shadow() { const A = 5; return A; }\n}\n' +
    '@keep\nclass B { static INSTANCE = new B(); static of(): B { return B.INSTANCE; } same() { return B.of() === B.INSTANCE; } }\n' +
    'export const out = [A.name, (A as any).tag, (A as any).first, (A as any).self === A, A.make() instanceof A, A.make().who(), new A(2).shadow(), (A as any).marks,\n' +
    '  (B as any).kept, B.of() instanceof B, new B().same()];';
  const result = compile(Buffer.from(source), options);
  assert.equal(result.backend, 'pulse');
  const reference = ts.transpileModule(source, { fileName: 'legacy.ts', compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: true } }).outputText;
  const run = code => new Function(code.replace(/export const out =/, 'return'))();
  assert.deepEqual(run(result.code), run(reference));
  // The class that the first decorator returns is the one the body sees afterwards.
  assert.deepEqual(run(result.code).slice(0, 2), ['Replaced', 'replaced']);
  for (const shape of [
    '@d export class A<T> extends B<A<T>> implements I { m(): typeof A { return this.constructor as typeof A; } }',
    '@d export abstract class A { abstract m(): A; static of(): A { return null as any; } }',
    'export class A { static ID = "a"; constructor(@IFoo foo: IFoo) { A.ID; } }',
  ]) {
    const lowered = compile(Buffer.from(shape), options);
    assert.equal(lowered.backend, 'pulse', shape);
    assert.match(lowered.code, /let A;\s*A = class[^{]*\{ static \{ A = this; \}/, shape);
  }
});
