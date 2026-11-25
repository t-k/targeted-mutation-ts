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

test('a source map does not change the route or the code', () => {
  const source = 'export class A { constructor(@IFoo foo: IFoo) {} }';
  const mapped = compile(source, { ...options, sourceMap: true });
  assert.equal(mapped.backend, 'pulse');
  assert.equal(mapped.code, compile(source, options).code);
  assert.equal(typeof mapped.sourceMap.mappings, 'string');
  // A file with names outside ASCII still takes TypeScript's map.
  assert.equal(compile('export class \u00c0 { constructor(@IFoo foo: IFoo) {} }', { ...options, sourceMap: true }).backend, 'typescript');
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
    // A self-naming class inside a function is lowered too: no loop stands around it in these places, so its
    // declaration runs once in each run of the function. An abstract one is still left to TypeScript.
    const abstractLocal = row.SelfName === 'Yes' && whole && ['Function', 'Block', 'Method'].includes(row.Place) && /abstract class/.test(source);
    if (abstractLocal) assert.equal(result.backend, 'typescript', source);
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
    ['@D class Service { static create() { return new Service(); } }\nconst Original = Service;\nconst Sub = class extends Service {};\n(Service as any) = Sub;\nexport const out = Original.create() instanceof Service;', ['value', false]],
    ['@D class A { static get() { return A; } }\nconst saved = A;\nconst Other = class {};\n(A as any) = Other;\nexport const out = (saved as any).get() === saved;', ['value', true]],
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
  // TypeScript's second variable belongs to the function or the module, so the runs of a loop share it: in its
  // output the body of the first class of a loop sees the second class. A class in a loop is left to
  // TypeScript, as is one that awaits inside its own text, or whose second name is taken.
  for (const source of [
    'const all: any[] = [];\nfor (const n of [1, 2]) { @d class K { static me() { return K; } } all.push(K); }\nexport { all };',
    'export function f() { for (;;) { @d class K { static me() { return K; } } return K; } }',
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

test('a decorated class inside a function may name itself when no loop stands around it', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let|function)/g, ''))();
  const helpers = 'const replace = (target: any) => class Replaced extends target { static tag = "replaced"; };\nconst keep = (target: any) => { target.kept = true; };\n';
  for (const body of [
    // In a function body, an arrow body, a block, a try and a switch.
    'function make() { @replace class G { static self = G; static value = 1; can() { return [G.value, (G as any).tag, this instanceof G]; } } return [new G().can(), (G as any).self === G]; }\nexport const out = JSON.stringify([make(), make()]);',
    'const make = () => { @keep class S { static inst = new S(); static of() { return S.inst; } } return [(S as any).kept, S.of() instanceof S]; };\nexport const out = JSON.stringify(make());',
    'function make(flag: boolean) { if (flag) { try { @keep class T { static again() { return new T(); } } return T.again() instanceof T; } finally { } } switch (1) { case 1: { @replace class U { static me = U; } return (U as any).me === U; } } }\nexport const out = JSON.stringify([make(true), make(false)]);',
  ]) {
    const source = helpers + body;
    const result = compile(Buffer.from(source), options);
    assert.equal(result.backend, 'pulse', body);
    const expected = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true } }).outputText;
    assert.equal(run(result.code), run(expected), body);
  }
  // Inside a loop TypeScript's second variable is shared by the runs of the loop: left to TypeScript.
  for (const body of [
    'function make() { const all: any[] = []; for (let i = 0; i < 2; i++) { @keep class L { static n = i; static who() { return L.n; } } all.push(L); } return all.map(c => c.who()); }\nexport const out = JSON.stringify(make());',
    'function make() { let i = 0; const all: any[] = []; while (i++ < 2) { switch (i) { default: { @keep class W { static n = i; static who() { return W.n; } } all.push(W); } } } return all.map(c => c.who()); }\nexport const out = JSON.stringify(make());',
    'const all: any[] = [];\nfor (const i of [1, 2]) { @keep class M { static n = i; static who() { return M.n; } } all.push(M); }\nexport const out = JSON.stringify(all.map(c => c.who()));',
  ]) {
    const source = helpers + body;
    const result = compile(Buffer.from(source), options);
    assert.notEqual(result.backend, 'pulse', body);
    const expected = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true } }).outputText;
    assert.equal(run(result.code), run(expected), body);
  }
  // A function inside a loop starts anew: its class runs once in each run of the function.
  const nested = helpers + 'const all: any[] = [];\nfor (const i of [1, 2]) { all.push((() => { @keep class N { static n = i; static who() { return N.n; } } return N.who(); })()); }\nexport const out = JSON.stringify(all);';
  const result = compile(Buffer.from(nested), options);
  assert.equal(result.backend, 'pulse');
  assert.equal(run(result.code), '[1,2]');
});

test('findings of the second review of the namespace and assertion round, with decorators', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let|enum|namespace|var)/g, ''))();
  const reference = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true } }).outputText;
  // A computed key over several lines that names the class.
  const key = 'let owner: () => Function;\nfunction register(getOwner: () => Function) { owner = getOwner; return "save"; }\nconst wrap = (Base: any) => class extends Base {};\n' +
    '@wrap\nexport class Cafe {\n  [register(\n    () => Cafe,\n  )]() {}\n}\nexport const out = owner!() === Cafe;';
  const keyed = compile(Buffer.from(key), options);
  assert.notEqual(keyed.backend, 'pulse');
  assert.equal(run(keyed.code), false);
  // A bracket inside the key does not end it, and a quotation mark in it counts as naming the class.
  for (const member of ['[register(items[0], () => Cafe)]() {}', 'static [register(() => Cafe)] = 1;', '[(x => "]")(Cafe)]() {}']) {
    const source = `declare const items: any[];\nconst wrap = (Base: any) => Base;\ndeclare function register(...f: any[]): string;\n@wrap\nexport class Cafe {\n  static self = Cafe;\n  ${member}\n}`;
    assert.notEqual(compile(Buffer.from(source), options).backend, 'pulse', member);
  }
  // A class that a namespace exports is assigned to the namespace behind the calls of its decorators.
  const exported = 'export const registered: string[][] = [];\nfunction record(owner: object) { registered.push(Object.keys(owner)); return (_target: object, _key: string) => {}; }\n' +
    'export enum Status { Ready }\nexport namespace Status {\n  export class View { @record(Status) value = 1; }\n}\nexport const out = JSON.stringify(registered);';
  const assigned = compile(Buffer.from(exported), options);
  assert.equal(run(assigned.code), run(reference(exported)));
  assert.equal(run(assigned.code), '[["0","Ready"]]');
  const plain = 'function mark(c: any) { c.marked = true; return class extends c {}; }\nexport namespace N {\n  @mark export class A {}\n  export abstract class B { @((t: any, k: string) => {}) m() {} }\n}\nexport const out = JSON.stringify([(N.A as any).marked, Object.getPrototypeOf(N.A) !== Function.prototype]);';
  assert.equal(run(compile(Buffer.from(plain), options).code), run(reference(plain)));
  // In a JSX file with names outside ASCII the copy is not used: the text of an element keeps its words.
  const element = 'function register(c: any) {}\n@register\nexport class Café {}\nexport const label = <span>Note:&nbsp;don’t close this tab.</span>;';
  const jsx = compile(Buffer.from(element), { file: 'legacy.tsx', experimentalDecorators: true, jsx: 'classic' });
  assert.doesNotMatch(jsx.code, /9on/);
  assert.match(jsx.code, /don(\\u2019|’)t close this tab/);
});

test('findings of the review of the destructuring and map round', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let|namespace|function|var)/g, ''))();
  const reference = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true } }).outputText;
  // A computed key behind a field that ends without a semicolon.
  const key = 'const wrap = (Base: any) => class extends Base {};\nfunction make() {\n  let getOwner: () => Function;\n  function register(read: () => Function) { getOwner = read; return "run"; }\n' +
    '  @wrap\n  class Service {\n    label?: string\n    [register(() => Service)]() {}\n  }\n  return getOwner!() === Service;\n}\nexport const out = make();';
  const keyed = compile(Buffer.from(key), options);
  assert.notEqual(keyed.backend, 'pulse');
  assert.equal(run(keyed.code), false);
  // A comment between `export` and the class that a namespace exports, and a decorator behind `export`.
  for (const head of ['export /** @internal */ class View {', 'export // note\n  class View {', 'export abstract /* a */ class View {', 'export @record(N) class View {']) {
    const source = `let seen: string[] = ["unset"];\nfunction record(owner: object): any { seen = Object.keys(owner); return () => {}; }\nexport namespace N {\n  ${head}\n    @record(N) value = 1;\n  }\n}\nexport const out = JSON.stringify(seen);`;
    const result = compile(Buffer.from(source), options);
    assert.equal(run(result.code), run(reference(source)), head);
    assert.equal(run(result.code), '[]', head);
  }
  // A class of the namespace that is not exported is lowered, also behind an exported function.
  const local = 'function mark(c: any) { c.marked = true; }\nexport namespace N {\n  export function f() { return 1; }\n  @mark class Local { static me = Local; }\n  export const got = [(Local as any).marked, Local.me === Local];\n}\nexport const out = JSON.stringify(N.got);';
  const lowered = compile(Buffer.from(local), options);
  assert.equal(lowered.backend, 'pulse');
  assert.equal(run(lowered.code), '[true,true]');
  // Only the key of a member counts: an array or an index with the name inside a method is no key.
  for (const body of ['static all() { return [A, A.name]; }', 'static list = [1, 2]; static me() { return A; } static at(i: number) { return this.list[i]; }',
    'label?: string\n  static pick(o: any) { return o[A.name]; }', '["plain"]() { return A; }']) {
    const source = `const d = (c: any) => c;\n@d export class A { ${body} }`;
    assert.equal(compile(Buffer.from(source), options).backend, 'pulse', body);
  }
  // A key of any shape that names the class, behind a member of any ending.
  for (const body of ['label?: string\n  [String(A)]() {}', 'x = 1\n  static [A.name] = 2;', 'm() {}\n  get [`${A}`]() { return 1; }', 'static async *[register(() => A)]() {}']) {
    const source = `const d = (c: any) => c;\ndeclare function register(f: any): string;\n@d export class A { ${body} }`;
    assert.notEqual(compile(Buffer.from(source), options).backend, 'pulse', body);
  }
});

test('the heritage clause of a self-naming class is read without its types, which the parser recorded', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let|namespace|function|var)/g, ''))();
  const reference = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true } }).outputText;
  const prelude = 'function withPolicy(check: () => boolean): any { return class { static canRun = check; }; }\nfunction upgrade(Base: any): any { return class extends Base { static version = 2; }; }\n' +
    'class Base<T> { static canRun() { return "base"; } }\ninterface I<T> {}\n';
  // Two comparisons in a callback are no type arguments: the name between them is a reference.
  for (const body of [
    'function build(retries: number) {\n  @upgrade\n  class Job extends withPolicy((): boolean => retries < 1 || Job.version > 1) {\n    static version = 1;\n  }\n  return Job.canRun();\n}\nexport const out = build(3);',
    '@upgrade\nclass Job extends withPolicy((): boolean => 3 < 1 || Job.version > 1) { static version = 1; static me() { return Job; } }\nexport const out = Job.canRun();',
  ]) {
    const result = compile(Buffer.from(prelude + body), options);
    assert.notEqual(result.backend, 'pulse', body);
    assert.equal(run(result.code), false, body);
  }
  // Type arguments, type parameters and an implements clause that name the class are erased and no reference.
  for (const body of [
    '@upgrade\nclass Job extends Base<Job> implements I<Job> { static version = 1; static me() { return Job; } }\nexport const out = [Job.canRun(), Job.me() === Job];',
    '@upgrade\nclass Job<T extends Job<T> = Job<any>> extends Base<Array<Job<any>>> { static version = 1; static me() { return Job; } }\nexport const out = [Job.canRun(), Job.me() === Job];',
  ]) {
    const source = prelude + body;
    const result = compile(Buffer.from(source), options);
    assert.equal(result.backend, 'pulse', body);
    assert.deepEqual(run(result.code), run(reference(source)), body);
  }
});

test('an await in the computed key of any member keeps a self-naming class with TypeScript', () => {
  for (const member of ['[await 1]() {}', 'x = 1\n  [await key()] = 2;', 'static get [(await key())]() { return 1; }']) {
    const source = `const d = (c: any) => c;\ndeclare function key(): Promise<string>;\n@d export class K { static v = K;\n  ${member}\n}`;
    assert.notEqual(compile(Buffer.from(source), options).backend, 'pulse', member);
  }
  // Without the self reference no function is written around the class, and the key may await.
  const plain = compile(Buffer.from('const d = (c: any) => c;\n@d export class K { [await Promise.resolve("k")]() { return 1; } }'), options);
  assert.equal(plain.backend, 'pulse');
  assert.match(plain.code, /let K = class K \{ \[await Promise\.resolve\("k"\)\]\(\)/);
});

test('a self-naming class that evaluates text is left to TypeScript, and types leave no joined words', () => {
  const run = code => new Function(code.replace(/export const out =/, 'return').replace(/export \{[^}]*\};?/g, '').replace(/export (?=class|const|let|namespace|function|var)/g, ''))();
  const reference = (source, file = 'legacy.ts') => ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, experimentalDecorators: true, verbatimModuleSyntax: true, jsx: ts.JsxEmit.React } }).outputText;
  const upgrade = 'const upgrade = (Base: any) => class extends Base { static version = 2; };\n';
  // The name in a constraint, in annotations, in an assertion and in an erased member, beside a direct eval:
  // whichever route answers, the evaluated text finds the class's own name.
  for (const body of [
    'class Job<T extends () => Job<T>> {\n  static version = 1;\n  static evaluate(expression: string) { return eval(expression); }\n}',
    'class Job {\n  static version = 1;\n  next?: Job;\n  declare owner: Job;\n  static make(): Job | null { return null as unknown as Job; }\n  clone(other: Job = this): Array<Job> { return [<Job>other]; }\n  static evaluate(expression: string) { return eval(expression); }\n}',
  ]) {
    const source = upgrade + '@upgrade\n' + body + '\nexport const out = Job.evaluate("Job.version");';
    const result = compile(Buffer.from(source), options);
    assert.equal(run(result.code), 1, body);
    assert.equal(run(result.code), run(reference(source)), body);
  }
  // A class that names itself and evaluates text is left to TypeScript: the text could spell the name.
  const evaluated = upgrade + '@upgrade\nclass Job {\n  static version = 1;\n  static make() { return new Job(); }\n  static evaluate(expression: string) { return eval(expression); }\n}\nexport const out = [Job.evaluate("Job.version"), Job.make() instanceof Job];';
  const left = compile(Buffer.from(evaluated), options);
  assert.notEqual(left.backend, 'pulse');
  assert.deepEqual(run(left.code), [1, true]);
  // Behind the dots of a spread the call is direct as well.
  const spread = upgrade + '@upgrade\nclass Job {\n  static version = 1;\n  static create() { return new Job(); }\n  static entries(expression: string) { return [...eval(expression)]; }\n}\nexport const out = Job.entries("[Job.version]");';
  const spreadResult = compile(Buffer.from(spread), options);
  assert.notEqual(spreadResult.backend, 'pulse');
  assert.deepEqual(run(spreadResult.code), [1]);
  // A type argument between a tag and an attribute: the words on both sides stay apart.
  const element = 'const React = { createElement(type: any) { return { type }; } };\nfunction withPreview(render: () => any) { return class { static preview = render; }; }\n' + upgrade +
    '@upgrade\nclass Job<T> extends withPreview(() => <Job<"<">title="Preview" />) {\n  static version = 1;\n}\nexport const out = (Job as any).preview().type.version;';
  const tsx = compile(Buffer.from(element), { file: 'legacy.tsx', experimentalDecorators: true, jsx: 'classic' });
  assert.notEqual(tsx.backend, 'pulse');
  assert.equal(run(tsx.code), run(reference(element, 'legacy.tsx')));
});
