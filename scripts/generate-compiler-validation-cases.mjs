import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const fixture = (file, value) => ({ file, mode: 'module', source: Buffer.from(value).toString('base64') });
const expressionCases = new Map([
  ['chain', 'const result = 1 as number satisfies number;'],
  ['conditional', 'const result = true ? (1) : (2 as number);'],
  ['template', 'const result = `as < type: ${1 as number}`;'],
  ['regex', 'const result = /satisfies|<T>/.test("as");'],
  ['comparison', 'const result = 0 < 1 && 2 > 1;'],
  ['instantiation', 'const result = (String<number>);'],
  ['unbound-export', 'type Result = number; export { Result }; const result = 42;'],
  ['duplicate', 'const result = 1; const result = 2;'],
  ['newline', 'const result = (value: number): {\\LINE\\value: number\\LINE\\} => ({ value });'],
  ['assertion-then-array', 'const result = [1] as number[]\\LINE\\[0];'],
  ['assertion-then-paren', 'const result = Math.abs as typeof Math.abs\\LINE\\(-42);'],
  ['class-computed', 'const result = class { item: number\\LINE\\["method"]() { return 1; } };'],
  ['enum', 'enum Flag { Ready = 42 }; const result = Flag.Ready;'],
  ['raw-receiver', 'const result = function(this) { return this; };'],
]);
export function generatedCases() {
  const inputs = [];
  for (const dialect of ['ts', 'tsx']) {
    const start = dialect === 'tsx' ? 'export const view = () => <i title="&amp;"/>;\n' : '';
    for (const [shape, code] of expressionCases) {
      for (const [newlineName, newline] of [['lf', '\n'], ['crlf', '\r\n'], ['unicode', '\u2028']]) {
        for (const [style, header] of [['empty', ''], ['directive', '"use strict";' + newline],
          ['comment', '/* prefix with type and < */' + newline]]) {
          const suffix = 'export const output = result;' + newline;
          inputs.push(fixture('generated/' + shape + '/' + newlineName + '/' + style + '.' + dialect,
            header + start + code.replaceAll('\\LINE\\', newline) + newline + suffix));
        }
      }
    }
  }
  return inputs;
}

export function mutateCases(path, corpus) {
  const suffixes = [
    '\nexport const tmtAuditAdded = (): {\n n: number;\n} => ({n: 1});\n',
    '\ntype TmtAuditRemoved = number;\nexport { TmtAuditRemoved };\n',
    '\nexport const tmtAuditMalformed = ready as boolean ? ++count < limit : false;\n',
    '\n// tmt audit EOF comment\n',
  ];
  const selected = corpus.filter(test => test.mode === 'module' &&
    /\.[jt]sx?$/.test(test.file) && !test.file.endsWith('.d.ts'));
  const variants = [];
  for (let index = 0; index < Math.min(selected.length, 137); index += 17) {
    const { file, source } = selected[index];
    const original = Buffer.from(source, 'base64').toString('utf8');
    for (const [mutation, suffix] of suffixes.entries()) {
      variants.push(fixture('mutation/' + basename(path, '.json') + '/' + mutation + '/' + file, original + suffix));
    }
  }
  return variants;
}

const certificationShapes = new Map([
  ['annotation', 'const result: number = 42;'],
  ['arguments', 'const result = new Map<string, number>().size + 42;'],
  ['assertion', 'const result = 42 as number;'],
  ['markers', 'class Box { value?: number; ready!: boolean }\\LINE\\const result = new Box();'],
  ['erased-statement', 'interface Shape { side: number }\\LINE\\const result = 42;'],
  ['overload', 'function pick(value: string): string;\\LINE\\function pick(value: number): number;\\LINE\\' +
    'function pick(value: any) { return value; }\\LINE\\const result = pick(42);'],
  ['modifiers', 'class Box { private readonly value = 42; }\\LINE\\const result = new Box();'],
  ['literal-enum', 'enum Flag { Ready = 42 }\\LINE\\const result = Flag.Ready;'],
  ['computed-enum', 'function next() { return 9; }\\LINE\\enum Flag { On = next() }\\LINE\\const result = Flag.On;'],
  ['string-enum-implicit', 'enum Ready { A = "s", B }\\LINE\\const result = Ready.A;'],
  ['constructor-this', 'class Box { constructor(this: Box) {} }\\LINE\\const result = 42;'],
  ['ambient-class-export', 'declare class Ambient {}\\LINE\\export { Ambient };\\LINE\\const result = 42;'],
  ['ambient-const-export', 'declare const ambient: number;\\LINE\\export { ambient };\\LINE\\const result = 42;'],
  ['parameter-property', 'class Box { constructor(public value: number) {} }\\LINE\\const result = new Box(42);'],
  ['parameter-property-derived', 'class Base {}\\LINE\\class Box extends Base { constructor(private readonly value: number, protected other = 1) { super()\\LINE\\} }\\LINE\\const result = new Box(42);'],
  ['parameter-property-constructor', 'class Box { constructor(public constructor: number) {} }\\LINE\\const result = 42;'],
  ['ambient-enum-export', 'declare enum Ambient { A }\\LINE\\export { Ambient };\\LINE\\const result = 42;'],
  ['ambient-var-export-as', 'declare var ambient: number;\\LINE\\export { ambient as renamed };\\LINE\\const result = 42;'],
  ['ambient-class-export-before', 'export { Ambient };\\LINE\\declare abstract class Ambient {}\\LINE\\const result = 42;'],
  ['ambient-function-export', 'declare function ambient(): void;\\LINE\\export { ambient };\\LINE\\const result = 42;'],
  ['ambient-const-reference', 'declare const ambient: number;\\LINE\\const result = typeof ambient;'],
  ['ambient-class-default', 'declare class Ambient {}\\LINE\\export default Ambient;\\LINE\\const result = 42;'],
  ['ambient-const-duplicate', 'declare const ambient: number;\\LINE\\const ambient = 1;\\LINE\\const result = ambient;'],
  ['ambient-enum-duplicate', 'declare enum Ambient { A }\\LINE\\class Ambient {}\\LINE\\const result = 42;'],
]);

// Shapes that the emitter certifies, and shapes that only V8 or a compatibility route can decide.
export function certificationCases() {
  const inputs = [];
  for (const dialect of ['ts', 'tsx']) {
    const view = dialect === 'tsx' ? 'export const view = () => <i title="&amp;"/>;\\LINE\\' : '';
    for (const [shape, code] of certificationShapes) {
      for (const [newlineName, newline] of [['lf', '\n'], ['crlf', '\r\n']]) {
        for (const [position, lead] of [['first', ''], ['after-import', 'import { lead } from "./lead.js";\\LINE\\'],
          ['after-erased', 'type Lead = string;\\LINE\\']]) {
          const text = lead + view + code + '\\LINE\\export const output = result;\\LINE\\';
          inputs.push(fixture('certification/' + shape + '/' + newlineName + '/' + position + '.' + dialect,
            text.replaceAll('\\LINE\\', newline)));
        }
      }
    }
  }
  return inputs;
}

const ambiguityPrelude = 'declare const a: any, b: any, c: any, d: any, e: any, f: any, g: any;\ntype T = any; type U = any;\n' +
  'class A<X = any, Y = any> { constructor(...r: any[]) {} static m<X>(...r: any[]): any {} }\n' +
  'function fn<X = any, Y = any>(...r: any[]): any {}\n';
// Angle brackets that are comparisons, shifts, type arguments or generic arrows depending on what follows.
const angleShapes = ['a < b > c', 'a < b > (c)', 'a < b >(c)', 'fn(a < b, c > d)', 'fn(a < b, c > (d))', 'fn(a < b, c >> d)', '(a < b, c > d)', '[a < b, c > d]',
  '({ x: a < b, y: c > d })', 'a < b >> c', 'a < b >>> c', 'a << b > c', 'a < b >\n c', 'a < b >= c', 'new A < T > (c)', 'new A < T, U > (c)', 'new A<T>', 'fn<T>`x`',
  'fn<T>(c)', 'fn<T, U>(c)', 'fn < T > (c)', 'fn<T>\n(c)', 'a < (b > c)', 'a < b && c > d', 'a < b ? c > d : e', 'a < b || c > (d)', 'a < b | c > (d)',
  'fn<typeof a>(c)', 'fn<T[]>(c)', 'fn<{ x: 1 }>(c)', 'fn<T>()', 'A.m<T>(c)', 'a?.b<T>(c)', 'fn<T>?.(c)', 'a < b > -c', 'a < b > +c', 'a < b > !c', 'a < b > c.d',
  'a < b > [c]', 'a < b > {}', 'a<b>c', 'a < b > = c', 'fn<T>;', 'const z = fn<T>;', 'const z = fn<T>\nconst y = 1', 'a < b >\n(c)', 'a < b\n> (c)', 'a\n< b > (c)',
  'a < b > c > d', 'a < b < c > (d)', 'a < b < c >> (d)', 'fn<A<T>>(c)', 'fn<A<A<T>>>(c)', 'a < b == c > d', 'a < b + c > (d)', 'a < b.c > (d)', 'a < b.c > d',
  'a < b["c"] > (d)', 'a < b() > (d)', 'a < 1 > (d)', 'a < "s" > (d)', 'a < -1 > (d)', 'a < b, c > (d)', 'if (a < b) c > d', 'for (; a < b; c > d) {}',
  'a < b ? c : d > (e)', 'a < b as any > (c)', '(a < b) > (c)', 'a < (b) > (c)', 'x = a < b > (c)', 'x = a < b, c > (d)', 'async < T > (x) => x', '<T>(x: T) => x',
  '<T,>(x: T) => x', 'fn(<T>(x: T) => x)', 'a < b >>= c', 'a <<= b > c', 'a < b > c ? d : e', 'a < b, c > d ? e : f', 'fn(a < b, c > d, e)', 'fn(a < b, c >= d)',
  'fn(a < b, (c > (d)))', 'fn(a < b, c, d > (e))', 'fn(a < b, c > (d), e < f, g > (a))', 'a < b > `t`', 'a < b > c `t`', 'fn<T>.name', 'fn<T>["name"]',
  'a < b > typeof c', 'a < b > void c', 'a < b > await c', 'a < b > new c', 'a < b > function () {}', 'a < b > class {}', 'a < b > this', 'a < b > null',
  'a < b > /re/', 'a < b > c++', 'a < b > ++c', 'a < b > (c) => d', 'a < b > async () => d'];
// Words that TypeScript reads as declarations or modifiers only in some positions.
const contextualWords = ['declare', 'abstract', 'type', 'namespace', 'module', 'interface', 'as', 'satisfies', 'readonly', 'public', 'private', 'protected', 'override',
  'implements', 'accessor', 'static', 'async', 'of', 'get', 'set', 'global', 'keyof', 'infer', 'is', 'asserts', 'unique', 'out', 'in', 'from', 'require', 'any', 'never', 'unknown', 'object', 'symbol', 'enum', 'await', 'yield', 'let', 'using', 'defer'];
const wordUses = [w => `var ${w}: any;\n${w}\nconst x = 1;`, w => `var ${w}: any;\n${w};\nconst x = 1;`, w => `var ${w}: any = 1;\n${w} + 1;`, w => `var ${w}: any;\n${w}\nclass B {}`,
  w => `var ${w}: any, A: any;\n${w}\nA\n{}`, w => `var ${w}: any, A: any;\n${w} \nA = 1;`, w => `var ${w}: any;\n${w}\nfunction g() {}`, w => `var ${w}: any;\n${w}\ninterface I {}`,
  w => `var ${w}: any;\n${w}\ntype X = 1;`, w => `var ${w}: any;\n${w}\nenum E { A }`, w => `var ${w}: any;\n${w}\nvar y = 1;`, w => `var ${w}: any;\n${w}\nlet y = 1;`,
  w => `var ${w}: any;\n${w}\nexport const y = 1;`, w => `var ${w}: any;\n${w}\nimport("x");`, w => `var ${w}: any;\nconst o = { ${w} };`, w => `var ${w}: any;\nconst o = { ${w}: 1, x: ${w} };`,
  w => `var ${w}: any;\nconst o = { ${w}() {} };`, w => `var ${w}: any;\n${w}[0];`, w => `var ${w}: any;\n${w}++;`, w => `var ${w}: any;\n${w}(1);`, w => `var ${w}: any;\n${w}\`t\`;`,
  w => `var ${w}: any;\n${w}.x;`, w => `var ${w}: any;\n${w}?.x;`, w => `var ${w}: any;\n${w} = 1;`, w => `var ${w}: any;\n${w} => 1;`, w => `var ${w}: any;\n(${w}) => 1;`,
  w => `var ${w}: any, x: any;\nx as ${w};`, w => `var ${w}: any, x: any;\nx\nas ${w};`, w => `var ${w}: any, x: any;\nx as\n${w};`, w => `var ${w}: any, x: any;\nx < ${w} > (x);`,
  w => `class C { ${w}: any }`, w => `class C { ${w} = 1 }`, w => `class C { ${w}\n x = 1 }`, w => `class C { ${w}\n x() {} }`, w => `class C { ${w}() {} }`, w => `class C { ${w} x = 1 }`,
  w => `class C { ${w} x() {} }`, w => `class C { static ${w} = 1 }`, w => `class C { ${w}\n static x = 1 }`, w => `class C { ${w}\n [x]() {} }`, w => `class C { ${w}\n *g() {} }`,
  w => `class C { ${w}?: any }`, w => `class C { ${w}!: any }`, w => `class C { ${w};\n x }`, w => `class C { get ${w}() { return 1 } }`, w => `class C { #${w} = 1 }`,
  w => `label: { var ${w}: any; ${w}: for (;;) break ${w}; }`, w => `function g(${w}: any) { return ${w} }`, w => `function g(${w}?: any) {}`, w => `var ${w}: any;\n${w} instanceof Object;`,
  w => `var ${w}: any;\n${w} in {};`, w => `var ${w}: any;\ntypeof ${w};`, w => `var ${w}: any;\n[${w}];`, w => `var ${w}: any;\nif (${w}) ${w};`, w => `var ${w}: any;\nfor (${w} of []) {}`,
  w => `var ${w}: any;\nfor (${w} in {}) {}`, w => `var ${w}: any;\n${w} < 1;`, w => `var ${w}: any;\n${w} < ${w} > (1);`, w => `var ${w}: any;\n${w}<any>(1);`, w => `var ${w}: any;\nnew ${w}<any>(1);`,
  w => `import { ${w} } from "m";\n${w};`, w => `import { x as ${w} } from "m";\n${w};`, w => `import { ${w} as x } from "m";\nx;`, w => `import ${w} from "m";\n${w};`,
  w => `import * as ${w} from "m";\n${w};`, w => `var ${w}: any;\nexport { ${w} };`, w => `var x: any;\nexport { x as ${w} };`, w => `export const ${w} = 1;`, w => `export function ${w}() {}`,
  w => `export class ${w} {}`, w => `type ${w} = number;\nvar v: ${w};`, w => `interface ${w} {}\nvar v: ${w};`, w => `var ${w}: any;\n${w}!;`, w => `var ${w}: any;\n${w}!.x;`,
  w => `var ${w}: any;\n<any>${w};`, w => `var ${w}: any;\n${w} as any;`, w => `var ${w}: any;\n${w} satisfies any;`, w => `var ${w}: any;\n${w}\n/re/g;`, w => `var ${w}: any;\n${w}\n(1);`,
  w => `var ${w}: any;\n${w}\n[1];`, w => `var ${w}: any;\n${w}\n\`t\`;`, w => `var ${w}: any;\n${w}\n++${w};`, w => `var ${w}: any;\n${w}\n"s";`];

// Shapes whose JavaScript reading and TypeScript reading can differ. The retired projection guard
// objects to many of them, and the audit compares each published objection with TypeScript.
export function ambiguityCases() {
  const inputs = [];
  for (const [index, shape] of angleShapes.entries()) {
    inputs.push(fixture(`ambiguity/angle-statement-${index}.ts`, `${ambiguityPrelude}${shape};\nexport {};\n`));
    inputs.push(fixture(`ambiguity/angle-initializer-${index}.ts`, `${ambiguityPrelude}export const z = ${shape};\n`));
    inputs.push(fixture(`ambiguity/angle-return-${index}.ts`, `${ambiguityPrelude}export function w() { return ${shape}; }\n`));
    inputs.push(fixture(`ambiguity/angle-unterminated-${index}.ts`, `${ambiguityPrelude}${shape}\nexport const z = 1\n`));
    inputs.push(fixture(`ambiguity/angle-statement-${index}.tsx`, `${ambiguityPrelude}${shape};\nexport {};\n`));
  }
  for (const word of contextualWords) {
    for (const [index, use] of wordUses.entries()) {
      inputs.push(fixture(`ambiguity/word-${word}-${index}.ts`, `${use(word)}\nexport {};\n`));
      if (index % 4 === 0) inputs.push(fixture(`ambiguity/word-${word}-${index}.tsx`, `${use(word)}\nexport {};\n`));
    }
  }
  return inputs;
}

if (import.meta.main) {
  const inputs = generatedCases().concat(certificationCases());
  for (const path of process.argv.slice(2)) {
    const raw = JSON.parse(readFileSync(path));
    inputs.push(...mutateCases(path, raw.rows ?? raw));
  }
  console.log(JSON.stringify(inputs));
}
