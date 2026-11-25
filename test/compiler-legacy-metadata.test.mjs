import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { inspect } from '../scripts/audit-compiler-coverage.mjs';
import { compile } from '../src/compiler.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { serializer } = require('../src/compiler-legacy-metadata.cjs');
const options = { file: 'metadata.ts', experimentalDecorators: true, emitDecoratorMetadata: true };

function reference(source) {
  const output = ts.transpileModule(source, { fileName: 'metadata.ts', reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, verbatimModuleSyntax: true,
    experimentalDecorators: true, emitDecoratorMetadata: true } });
  assert.deepEqual(output.diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), [], source);
  return output.outputText;
}

// The lowering has to give the syntax of TypeScript's own lowering, whichever route answers.
function lowered(source) {
  const result = compile(Buffer.from(source), options);
  assert.equal(typeof result.code, 'string', source);
  assert.deepEqual(inspect(ts, result.code, 'metadata.ts'), inspect(ts, reference(source), 'metadata.ts'), source);
  return result;
}

const preludes = {
  Unknown: ['', 'Known'], ValueImport: ['import { Val } from "v";\n', 'Val'], TypeImport: ['import type { Typ } from "t";\n', 'Typ'],
  ModuleClass: ['class Own {}\n', 'Own'], Alias: ['type Ali = string;\n', 'Ali'], TypeParameter: ['', 'Par'],
};
const forms = {
  None: () => '', Primitive: () => 'string', Literal: () => '"lit"', Array: name => `${name}[]`, Tuple: () => '[string, number]',
  Function: () => '(a: string) => void', ObjectLiteral: () => '{ a: string }', Reference: name => name,
  Qualified: name => `${name}.Inner`, Generic: name => `Promise<${name}>`, UnionSame: name => `${name} | ${name}`,
  UnionMixed: name => `${name} | string`, UnionNull: name => `${name} | null`, Keyof: name => `keyof ${name}`,
  Parenthesized: name => `(${name})`,
};

// One source per row of the PICT table: a type form at one position of a decorated class.
function placed(row) {
  const [prelude, name] = preludes[row.Name];
  const type = forms[row.Type](name);
  const annotation = type === '' ? '' : `: ${type}`;
  const fixed = row.Static === 'Yes' ? 'static ' : '';
  const member = {
    Field: `@m ${fixed}f${annotation};`,
    MethodParameter: `@m ${fixed}m(a: number, b${annotation}) {}`,
    Return: `@m ${fixed}m()${annotation} { return null as any; }`,
    ConstructorParameter: `constructor(a${annotation}) {}`,
    Getter: `@m ${fixed}get g()${annotation} { return null as any; }`,
    Setter: `@m ${fixed}set s(v${annotation}) {}`,
    Rest: `@m ${fixed}m(...r${type === '' ? '' : `: (${type})[]`}) {}`,
  }[row.Position];
  const parameters = row.Name === 'TypeParameter' ? '<Par>' : '';
  return `${prelude}declare const c: any, m: any;\n${row.ClassDecorator === 'Yes' ? '@c ' : ''}class K${parameters} { ${member} }\nexport { K };`;
}

const table = readFileSync(new URL('../verification/pict/compiler-legacy-metadata.tsv', import.meta.url), 'utf8')
  .trim().split('\n').map(line => line.split('\t'));

test('metadata of every type form at every position has the syntax TypeScript writes', () => {
  const [header, ...rows] = table;
  assert.equal(rows.length, 108);
  let native = 0;
  for (const cells of rows) {
    const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]));
    const result = lowered(placed(row));
    // A name the file declares as something else than one class, and a type parameter, are left to TypeScript.
    const certain = row.Name !== 'Alias' && row.Name !== 'TypeParameter' ||
      ['None', 'Primitive', 'Literal', 'Tuple', 'Function', 'ObjectLiteral', 'Array', 'Keyof'].includes(row.Type);
    if (certain && row.Position !== 'Rest') { assert.equal(result.backend, 'pulse', placed(row)); native++; }
  }
  assert.ok(native >= 60, String(native));
});

test('the shapes of real services and entities are lowered natively', () => {
  for (const source of [
    'import { Injectable, Inject } from "@nestjs/common";\nimport { Repository } from "typeorm";\nimport { User } from "./user";\n' +
      '@Injectable()\nexport class Users {\n  constructor(private readonly repo: Repository<User>, @Inject("T") private config: Config, private http: HttpService) {}\n' +
      '  @Get(":id")\n  async find(@Param("id") id: string, @Query() q: QueryDto): Promise<User> { return null as any; }\n  @Post() create(@Body() dto: CreateDto) {}\n}',
    'import { Entity, Column } from "typeorm";\n@Entity()\nexport class Row {\n  @PrimaryGeneratedColumn() id: number;\n  @Column() name: string;\n' +
      '  @Column({ nullable: true }) note?: string;\n  @Column() at: Date;\n  @OneToMany(() => Other, o => o.row) others: Other[];\n  @ManyToOne(() => Owner) owner: Owner;\n}',
    '@D class A { constructor(); constructor(a?: string) {} }\nexport { A };',
    'import { S } from "s";\nclass A { @E static a: S; @E b: S; constructor(c: S) {} @E static m(x: S) {} @E n(y: S): S { return y; } }\nexport { A };',
    'class A { @E get g(): bigint { return 1n; } @E set h(v: symbol) {} @E async o() {} @E n() {} @E p; @E q = 1; }\nexport { A };',
    '@D class A {}\nclass B { m() {} }\nexport { A, B };',
    'interface I {}\nexport interface J { a: 1 }\nconst J = dec<J>("j");\nclass A { @E a: I; @E b: J; constructor(@J c: J) {} }\nexport { A };',
    'class A { @E a: Later; @E b: Later[]; }\nclass Later {}\nexport { A, Later };',
    'import { S } from "s";\nclass A { @E m(' + Array.from({ length: 30 }, (unused, index) => `p${index}: S`).join(', ') + ') {} }\nexport { A };',
  ]) {
    const result = lowered(source);
    assert.equal(result.backend, 'pulse', source);
  }
});

test('what the reading of types is not certain of is left to TypeScript, with the same result', () => {
  for (const source of [
    'class A<T> { @E a: T; }\nexport { A };',
    'type X = string;\nclass A { @E a: X; }\nexport { A };',
    'interface I {}\nfunction f() { interface I {} }\nclass A { @E a: I; }\nexport { A, f };',
    'interface I {}\nclass I {}\nclass A { @E a: I; }\nexport { A };',
    'function f() { interface I {} }\nclass A { @E a: I; }\nexport { A, f };',
    'interface I { (a: string): void }\nclass A { @E a: I; }\nexport { A };',
    'interface I {\n  new (a: string): I;\n}\nclass A { @E a: I; }\nexport { A };',
    'interface I { a: 1; <T>(a: T): void }\nclass A { @E a: I; }\nexport { A };',
    'interface B { (): void }\ninterface I extends B {}\nclass A { @E a: I; }\nexport { A };',
    'interface I {}\ninterface I { (): void }\nclass A { @E a: I; }\nexport { A };',
    'enum N { a }\nclass A { @E a: N; }\nexport { A };',
    'class A { @E a: S extends T ? 1 : 2; }\nexport { A };',
    'class A { @E a: string | never; }\nexport { A };',
    'class A { @E m({ a }: S) {} }\nexport { A };',
    'class A { @E get g(): string { return ""; } set g(v: string) {} }\nexport { A };',
    'const _a = 1;\nclass A { @E a: S; }\nexport { A };',
    'function f() { @D class L { constructor(a: Foo) {} } return L; }\nexport { f };',
    'class B {}\nfunction f() { class B {} }\nclass A { @E a: B; }\nexport { A, f };',
    'import S = require("s");\nclass A { @E a: S; }\nexport { A };',
    'class A { @E a: a.b.C; }\nexport { A };',
  ]) {
    assert.equal(lowered(source).backend, 'typescript', source);
  }
});

test('a class named in its own annotations is lowered natively', () => {
  // The class expression loses its name here, so the text differs from TypeScript's; what runs is the same.
  const source = 'const D = (t: any) => t, E = (t: any, k: any) => {};\n@D class A { @E p: A; @E m(x: A): A { return x; } }\nexport const out = Reflect.ownKeys(new A());';
  const result = compile(Buffer.from(source), options);
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /"design:type", A\)/);
  assert.match(result.code, /"design:paramtypes", \[A\]/);
  assert.match(result.code, /"design:returntype", A\)/);
});

test('temporaries are numbered as TypeScript numbers them', () => {
  // The constructor comes first, the members follow in source order, and a reference that is not written gets none.
  const result = lowered('import { S, T } from "s";\n@D class A { @E static a: S; @E b: S | T; @E c: string | S; @E d: any | S; @E e: S[]; constructor(x: T) {} @E f: keyof S; @E g: T; }\nexport { A };');
  assert.equal(result.backend, 'pulse');
  assert.match(result.code, /var _a, _b, _c, _d, _e, _f;/);
  assert.match(result.code, /"design:paramtypes", \[typeof \(_a = typeof T/);
});

test('the serializer reads a type from its text', () => {
  const names = { classes: new Set(['Own']), interfaces: new Set(['Face']), typeOnly: new Set(['Typ']), declared: new Set(['Own', 'Ali', 'Face']), parameters: new Set(['Par']) };
  let count = 0;
  const serialize = serializer(names, () => `_t${count++}`);
  const cases = [
    ['string', 'String'], [' number ', 'Number'], ['boolean', 'Boolean'], ['bigint', 'BigInt'], ['symbol', 'Symbol'],
    ['void', 'void 0'], ['undefined', 'void 0'], ['null', 'void 0'], ['never', 'void 0'], ['any', 'Object'], ['unknown', 'Object'],
    ['object', 'Object'], ['this', 'Object'], ['"a"', 'String'], ['`a`', 'String'], ['1', 'Number'], ['-1', 'Number'], ['1n', 'BigInt'],
    ['true', 'Boolean'], ['string[]', 'Array'], ['readonly string[]', 'Array'], ['[a: string]', 'Array'], ['() => void', 'Function'],
    ['new () => Own', 'Function'], ['<T>(x: T) => T', 'Function'], ['{ a: Own }', 'Object'], ['keyof Ali', 'Object'], ['typeof x.y', 'Object'],
    ['Own', 'Own'], ['(Own)', 'Own'], ['Typ', 'Object'], ['Face', 'Object'], ['Face | Own', 'Object'], ['Face<string>', 'Object'], ['Own["a"]', 'Object'], ['"a" | "b"', 'String'], ['string | number', 'Object'],
    ['string | null', 'Object'], ['| string | string', 'String'], ['string & {}', 'Object'], ['/* c */ string // d\n', 'String'],
    ['false', 'Boolean'], ['(() => void)', 'Function'], ['(() => void) | string', 'Object'], ['() => Map<string, number>', 'Function'],
    ['() => { a: [string] }', 'Function'], ['[() => void, string]', 'Array'], ['(new () => Own)[]', 'Array'], ['typeof Own.a<string>', 'Object'],
    ['Ali[]', 'Array'], ['Par[]', 'Array'], ['keyof Par', 'Object'], ['string | number | Ali', 'Object'],
    ['Ali', null], ['Par', null], ['Own.Inner', null], ['Face.Inner', null], ['infer X', null], ['import("x").T', null], ['(Par)', null], ['Par | null', null],
    ['string | never', null], ['asserts x', null], ['a.b.C', null], ['`a${string}`', null], ['', null], ['string string', null],
    // Text that is no type gives no value.
    ['(', null], ['Map<', null], ['typeof', null], ['typeof import("x")', null], ['-', null], ['- x', null], ['(string', null], ['(string]', null],
    ['string[', null], ['typeof x<', null], ['unique symbol', null], ['string |', null], ['|', null], ['asserts', null], ['string & ', null], ['typeof x.', null], ['() => (', null], ['(a: string', null],
    ['() => {', null], ['new', 'Function'], ['abstract new () => Own', null],
  ];
  for (const [text, expected] of cases) assert.equal(serialize(text), expected, text);
  assert.equal(count, 0);
  for (const text of ['A extends B ? 1 : 2', 'x is string', 'x.']) assert.equal(serializer(names, () => '_x')(text), null, text);
  assert.equal(serialize('Known'), 'typeof (_t0 = typeof Known !== "undefined" && Known) === "function" ? _t0 : Object');
  assert.equal(serialize('ns.Known<string>'), 'typeof (_t1 = typeof ns !== "undefined" && ns.Known) === "function" ? _t1 : Object');
  // Only what is written takes a temporary.
  assert.equal(serialize('Known[]'), 'Array');
  assert.equal(serialize('keyof Known'), 'Object');
  assert.equal(serialize('string | number | Known'), 'Object');
  assert.equal(serialize('(Known | Other)[]'), 'Array');
  assert.equal(serialize('(Known)["a"]'), 'Object');
  assert.equal(count, 2);
  assert.equal(serialize('Known | null'), 'Object');
  assert.equal(count, 3);
  // Without a further temporary no reference is written.
  assert.equal(serializer(names, () => null)('Known'), null);
});
