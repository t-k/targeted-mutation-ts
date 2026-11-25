import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
    'export default @d class A {}',
    'namespace N { @d export class A {} }\nexport { N };',
    'export class A { @d get v() { return 1; } @d set v(x) {} }',
    'export class A { @d [k]() {} }',
    'export class A { @d 1() {} }',
    'export class A { @d #p = 1; }',
    'const default_1 = 1;\n@d export default class {}\nexport { default_1 };',
    'export class A { set v(@d x: number) {} }',
    '"use strict";\n@d class A {}\nexport { A };',
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

test('source maps keep the TypeScript route', () => {
  const source = 'export class A { constructor(@IFoo foo: IFoo) {} }';
  assert.equal(compile(source, { ...options, sourceMap: true }).backend, 'typescript');
});

// A class that names itself in its body. TypeScript writes a second name for the decorated class and uses it for
// every reference in the body; this compiler takes the name off the class expression and declares the name again
// in a scope around it. The two texts differ, so they are compared by what they do.
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
    assert.match(lowered.code, /let \[A, A_1\] = \(\(\) => \{ let A; A = class[^{]*\{ static \{ A = this; \}/, shape);
  }
});

// One source per row of the PICT table: where the class stands, and what is decorated in it.
function placed(row) {
  const members = [];
  if (row.Parameter === 'Constructor') members.push('constructor(@p("c") a?: number) {}');
  if (row.Member === 'Method') members.push(row.Parameter === 'Method' ? '@m("m") m(x: number, @p("m") y?: number) { return 1; }' : '@m("m") m() { return 1; }');
  if (row.Member === 'Field') members.push('@m("f") f = 2;');
  if (row.Member === 'Static') members.push('@m("s") static s() { return 3; }');
  if (row.Member === 'Accessor') members.push('@m("g") get g() { return 4; }');
  if (row.SelfName === 'Yes') members.push('static make() { return new K(); }', 'who() { return K.name; }');
  if (row.Abstract === 'Yes') members.push('abstract missing(): void;');
  const decorators = { None: '', One: '@c("1") ', Two: '@c("1") @c("2") ' }[row.ClassDecorator];
  const modifier = row.Abstract === 'Yes' ? 'abstract ' : '';
  const body = ` { ${members.join(' ')} }`;
  const prelude = 'const log: string[] = [];\n' +
    'const c = (n: string) => (t: any) => { log.push("c" + n + typeof t); };\n' +
    'const m = (n: string) => (t: any, k: any, d?: any) => { log.push("m" + n + String(k) + typeof d); };\n' +
    'const p = (n: string) => (t: any, k: any, i: number) => { log.push("p" + n + String(k) + i); };\n';
  const use = '[log.join("|"), Object.getOwnPropertyNames(K.prototype).join(), Object.getOwnPropertyNames(K).join()]';
  switch (row.Place) {
    case 'Module': return `${prelude}${decorators}${modifier}class K${body}\nexport const out = ${use};`;
    case 'Exported': return `${prelude}${decorators}export ${modifier}class K${body}\nexport const out = ${use};`;
    case 'DefaultNamed': return `${prelude}${decorators}export default ${modifier}class K${body}\nexport const out = ${use};`;
    case 'DefaultAnonymous': return `${prelude}${decorators}export default ${modifier}class${body}\nexport const out = [log.join("|")];`;
    case 'Function': return `${prelude}function f() { ${decorators}${modifier}class K${body}\n return ${use}; }\nexport const out = f();`;
    case 'Block': return `${prelude}let seen: any;\nif (log.length === 0) { ${decorators}${modifier}class K${body}\n seen = ${use}; }\nexport const out = seen;`;
    case 'Method': return `${prelude}@c("o") class Outer { @m("o") run() { ${decorators}${modifier}class K${body}\n return ${use}; } }\nexport const out = new Outer().run();`;
    default: throw new Error(row.Place);
  }
}

const places = readFileSync(new URL('../verification/pict/compiler-legacy-decorator-places.tsv', import.meta.url), 'utf8')
  .trim().split('\n').map(line => line.split('\t'));

test('a decorated class is lowered wherever its declaration stands', () => {
  const [header, ...rows] = places;
  assert.equal(rows.length, 38);
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export default\s+(?=class)/g, '').replace(/export default /g, 'void ').replace(/export\s+(?=class)/g, '').replace(/export \{[^}]*\};?/g, ''))();
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const source = placed(row);
    const result = compile(Buffer.from(source), options);
    const reference = ts.transpileModule(source, { fileName: 'legacy.ts', reportDiagnostics: true, compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: true } });
    assert.deepEqual(reference.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], source);
    assert.equal(typeof result.code, 'string', source);
    const whole = row.ClassDecorator !== 'None' || row.Parameter === 'Constructor';
    // A class that names itself is written with another device than TypeScript's, so only the behaviour is compared.
    if (!(row.SelfName === 'Yes' && whole)) {
      assert.deepEqual(inspect(ts, result.code, 'legacy.ts'), inspect(ts, reference.outputText, 'legacy.ts'), source);
    }
    assert.deepEqual(run(result.code), run(reference.outputText), source);
    const any = whole || row.Member !== 'None';
    // A self-naming class inside a function is left to TypeScript, whose second variable belongs to the function.
    const shared = row.SelfName === 'Yes' && whole && ['Function', 'Block', 'Method'].includes(row.Place);
    if (shared) assert.equal(result.backend, 'typescript', source);
    else if (any) { assert.equal(result.backend, 'pulse', source); native++; }
  }
  assert.ok(native >= 25, String(native));
});

// What a text does: its value, or the error it throws.
function outcome(code) {
  try { return ['value', new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, ''))()]; } catch (error) { return ['throws', error.constructor.name]; }
}

test('the variable a self-naming class sees is its own, as in TypeScript\'s lowering', () => {
  const prelude = 'const D = (target: any) => target;\nconst customize = (Base: any) => class extends Base { static extra = true; };\n';
  for (const [body, expected] of [
    // An assignment to the class's variable does not reach the body.
    ['@D class Service { static create() { return new Service(); } }\nconst Original = Service;\n(Service as any) = class extends Service {};\nexport const out = Original.create() instanceof Service;', ['value', false]],
    ['@D class A { static get() { return A; } }\nconst saved = A;\n(A as any) = class Other {};\nexport const out = (saved as any).get() === saved;', ['value', true]],
    // A function outside reads the outer variable, which is not initialized while the static members run.
    ['function read() { return Service; }\n@D class Service { static self = Service; static registered = read(); }\nexport const out = 1;', ['throws', 'ReferenceError']],
    // A class of any name: the function that stores the decorated class does not hide it.
    ['@customize class value { static make() { return new value(); } }\nexport const out = [(value as any).make() instanceof value, (value as any).extra];', ['value', [true, true]]],
    // A spread of the class is a reference to it.
    ['@customize class Settings { static snapshot() { return { ...Settings }; } }\nexport const out = Settings.snapshot();', ['value', { extra: true }]],
    // The class of a heritage clause has a body of its own in front of the class's body.
    ['@D class Service extends class {} { static self = Service; }\nexport const out = (Service as any).self === Service;', ['value', true]],
  ]) {
    const source = prelude + body;
    const result = compile(Buffer.from(source), options);
    assert.equal(result.backend, 'pulse', source);
    const reference = ts.transpileModule(source, { fileName: 'legacy.ts', compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: true } }).outputText;
    assert.deepEqual(outcome(reference), expected, source);
    assert.deepEqual(outcome(result.code), expected, source);
  }
  // Inside a function TypeScript's second variable is shared by every run of the function: in its output the
  // body of the first class of a loop sees the second class. Such a class is left to TypeScript, as is one
  // that awaits inside its own text, or whose second name is taken.
  for (const source of [
    'const all: any[] = [];\nfor (const n of [1, 2]) { @d class K { static me() { return K; } } all.push(K); }\nexport { all };',
    'export function f() { @d class K { static me() { return K; } } return K; }',
    '@d class K { static v = K; [await 1]() {} }\nexport { K };',
    '@d class K extends (await base) { static v = K; }\nexport { K };',
    // In the heritage clause and as a shorthand property TypeScript leaves the name, which is the undecorated class.
    '@d class Service extends base(() => Service) {}\nexport { Service };',
    '@d class A { static get() { return { A }; } }\nexport { A };',
    '@d class A { static get() { return { x: 1, A }; } }\nexport { A };',
    'const K_1 = 1;\n@d class K { static v = K; }\nexport { K, K_1 };',
  ]) assert.equal(lowered(source).backend, 'typescript', source);
});

test('an await inside a method does not keep a self-naming class from the native lowering', () => {
  const source = '@d export class K { static of() { return new K(); } async load() { await 1; return K; } *all() { yield K; } #p = 1; }';
  const result = compile(Buffer.from(source), options);
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /let \[K, K_1\] = /);
});

test('comments and white space do not change what is read', () => {
  for (const source of [
    '@d export /* default settings */ class Settings {}',
    '/* a */ // b\n@d export class C { @e m() {} }',
  ]) {
    assert.equal(lowered(source).backend, 'pulse', source);
  }
  assert.match(compile(Buffer.from('@d export /* default settings */ class Settings {}'), options).code, /export \{ Settings \};/);
  // A line separator ends a line comment and is white space. A source that holds one is left to TypeScript.
  for (const source of ['// license\u2028@d export class C {}\nfunction d(...args: any[]) {}',
    'function register() {}\n@register\nexport // Public entry point\u2028default class Service {}',
    'function record() {}\nexport class Config { @record value\u2028: string; }', '@d export class C { m() { return "\u2029"; } }']) {
    assert.equal(lowered(source).backend, 'typescript', source);
  }
});

test('a TSX file is lowered under the legacy option, with or without decorators', () => {
  const tsx = { ...options, file: 'legacy.tsx' };
  const reference = (source, extra = {}) => ts.transpileModule(source, { fileName: 'legacy.tsx', compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true, experimentalDecorators: true,
    jsx: ts.JsxEmit.ReactJSX, ...extra } }).outputText;
  const names = code => code.replace(/_tmtJsxs?\d*|_jsxs?/g, 'J');
  for (const source of [
    // An at sign in a package name and in JSX text is no decorator.
    'import { B } from "@mui/material";\nexport const a: number = 1;\nexport const v = <B x={a}>mail @me</B>;',
    'import { B } from "@x/y";\n@D class C { @E m(@F p: string) { return <B />; } }\nexport const v = <p>{new C().m("a")}</p>;\nexport { C };',
    '@D export class V<T> { render() { return <Select<T> v={1} />; } }',
  ]) {
    for (const extra of [{}, { emitDecoratorMetadata: true }]) {
      const result = compile(Buffer.from(source), { ...tsx, ...extra });
      assert.equal(result.backend, 'pulse', source);
      assert.deepEqual(inspect(ts, names(result.code), 'legacy.js').shape, inspect(ts, names(reference(source, extra)), 'legacy.js').shape, source);
    }
  }
});

test('decorators are lowered in a file with names outside ASCII', () => {
  const source = 'import { ɵɵdefineInjectable as def } from "@angular/core";\n' +
    '@Injectable() export class ɵSvc { constructor(@Inject(ɵT) private ɵdep: ɵDep) {} @Input() ɵname = "ɵ"; static ɵmake() { return new ɵSvc(null as any); } }\nexport const ɵx = def;';
  for (const extra of [{}, { emitDecoratorMetadata: true }]) {
    const result = compile(Buffer.from(source), { ...options, ...extra });
    assert.equal(result.backend, 'pulse');
    assert.match(result.code, /__decorate\(\[Input\(\)[^\]]*\], ɵSvc\.prototype, "ɵname", void 0\);/);
    assert.match(result.code, /__param\(0, Inject\(ɵT\)\)/);
    assert.equal(/typeof ɵDep !== "undefined" && ɵDep/.test(result.code), extra.emitDecoratorMetadata === true);
    assert.doesNotMatch(result.code, /[A-Z]{2}Svc|TZ/);
    assert.match(result.code, /let \[ɵSvc, ɵSvc_1\] = /);
  }
  // Without a decorator such a file compiles as without the option.
  const plain = 'export const ɵa: number = 1; // mail @home';
  assert.deepEqual(compile(Buffer.from(plain), options), compile(Buffer.from(plain), { file: 'legacy.ts' }));
});

test('the copy spelled in ASCII is not taken where it could differ from the source', () => {
  // An escape or a number that the spelling would complete.
  for (const source of [
    'function logged(ctor: Function) {}\n@logged\nclass Label { text = "\\xAБилет"; }\nexport { Label };',
    'function logged(ctor: Function) {}\n@logged\nclass Label { size = 0xБ; }\nexport { Label };',
  ]) {
    const result = compile(Buffer.from(source), options);
    assert.notEqual(result.backend, 'pulse', source);
    assert.equal(result.diagnostics.length, 1, source);
  }
  assert.notEqual(compile(Buffer.from('export const text: string = "\\xAБилет";'), { file: 'legacy.ts' }).backend, 'pulse');
  // A word of the source that is spelled like the second name of a class.
  for (const source of [
    'function logged(ctor: Function) {}\n@logged\nclass é {}\nconst status = "NN_1";\nexport { status };',
    'function d(x: any) {}\n@d class 名 {}\nconst data = { VOL_1: 42 };\nconsole.log(data.VOL_1, "VOL_1");\nexport {};',
  ]) {
    const result = compile(Buffer.from(source), options);
    assert.match(result.code, /"(NN|VOL)_1"/, source);
    assert.doesNotMatch(result.code, /"[é名]_1"/, source);
  }
  // Without the derived name, a word like it is left alone.
  assert.match(compile(Buffer.from('export const é: number = 1;\nexport const s: string = "NN_1";'), { file: 'legacy.ts' }).code, /"NN_1"/);
});

test('findings of the second review of the round: erased members, derived names, shorthand behind a comment', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let)/g, ''))();
  // A semicolon stands where an erased member stood.
  for (const member of ['protected declare y: number;', 'declare y: number']) {
    const source = `function register(_target: Function) {}\n@register\nexport class Model {\n  x = 1\n  ${member}\n  ["z"] = 2;\n}\nexport const out = JSON.stringify(new Model());`;
    const result = compile(Buffer.from(source), options);
    assert.equal(result.backend, 'pulse', source);
    assert.equal(run(result.code), '{"x":1,"z":2}', source);
  }
  const abstract = 'function register(_target: Function) {}\n@register\nexport abstract class Model {\n  x = 1\n  abstract get y(): number\n  ["z"] = 2;\n}';
  assert.match(compile(Buffer.from(abstract), options).code, /x = 1\n\s*;\n\s*\["z"\] = 2;/);
  // A word with bytes outside ASCII that is spelled like the second name of a class.
  const derived = 'function register(_target: Function) {}\nexport const β_1 = 0.5;\nconst Θ = 1;\n@register\nexport class Model {\n  score() { return β_1 * Θ; }\n}';
  const lowered = compile(Buffer.from(derived), options);
  assert.match(lowered.code, /export const β_1 = 0\.5/);
  assert.match(lowered.code, /return β_1 \* Θ/);
  // A comment between the brace and a shorthand name.
  for (const body of ['{ /* model */ Cafe }', '{ a: 1, // model\n Cafe /* x */ }', '{ Cafe // last\n }']) {
    const source = `const wrap = (Base: any) => class extends Base {};\n@wrap\nexport class Cafe {\n  static info() { return ${body}; }\n}`;
    assert.notEqual(compile(Buffer.from(source), options).backend, 'pulse', source);
  }
});

test('a computed key that names the class leaves a self-naming class to TypeScript', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let)/g, ''))();
  const source = 'let getOwner: () => Function;\nfunction register(owner: () => Function) { getOwner = owner; return "save"; }\nfunction wrap(Base: any) { return class extends Base {}; }\n' +
    '@wrap\nexport class Cafe {\n  [register(() => Cafe)]() { return "x"; }\n}\nexport const out = getOwner!() === Cafe;';
  const result = compile(Buffer.from(source), options);
  assert.notEqual(result.backend, 'pulse');
  assert.equal(run(result.code), false);
  // The same with a name outside ASCII, which goes through the copy.
  assert.notEqual(compile(Buffer.from(source.replaceAll('Cafe', 'Café')), options).backend, 'pulse');
  // A key that does not name the class is no obstacle.
  const other = 'const key = "save";\nfunction mark(c: any) {}\n@mark\nexport class Cafe {\n  [key]() { return Cafe.name; }\n}\nexport const out = new Cafe()[key]();';
  const lowered = compile(Buffer.from(other), options);
  assert.equal(lowered.backend, 'pulse');
  assert.equal(run(lowered.code), 'Cafe');
});
